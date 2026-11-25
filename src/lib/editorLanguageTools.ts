import { indentUnit } from "@codemirror/language";
import { forEachDiagnostic } from "@codemirror/lint";
import { Facet, Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { api } from "./api";
import { applyEditorEdits, codeActionEdits, editorRange } from "./editorEdits";
import { t } from "./i18n";
import type { CodeAction, CodeActionResult, SignatureHelp } from "./types";
import { errorCode, errorMessage } from "./utils";

export type EditorLanguageAction =
  "quick-fix" | "organize-imports" | "format-code" | "parameter-info";

interface Context {
  projectId: string;
  path: string;
  wanted: () => boolean;
  notify: (message: string) => void;
}

const context = Facet.define<Context>();
const setTooltip = StateEffect.define<Tooltip | null>();
const tooltip = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTooltip)) return effect.value;
    }
    return transaction.docChanged ||
      transaction.selection ||
      transaction.startState.readOnly !== transaction.state.readOnly
      ? null
      : value;
  },
  provide: (field) => showTooltip.from(field),
});

function quickFixRange(state: EditorState) {
  const { from, to } = state.selection.main;
  if (from !== to) return editorRange(state.doc, from, to);
  let start = from;
  let end = to;
  forEachDiagnostic(state, (_, diagnosticFrom, diagnosticTo) => {
    if (diagnosticFrom <= from && diagnosticTo >= to) {
      start = Math.min(start, diagnosticFrom);
      end = Math.max(end, diagnosticTo);
    }
  });
  return editorRange(state.doc, start, end);
}

export function signatureParts(help: SignatureHelp) {
  const active = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  if (!active) return null;
  const parameter = active.parameters[active.activeParameter ?? help.activeParameter ?? 0];
  if (!parameter) return { before: active.label, current: "", after: "" };
  let from: number;
  let to: number;
  if (typeof parameter.label === "string") {
    from = active.label.indexOf(parameter.label, Math.max(0, active.label.indexOf("(") + 1));
    to = from + parameter.label.length;
  } else {
    [from, to] = parameter.label;
  }
  if (from < 0 || to <= from || to > active.label.length) {
    return { before: active.label, current: "", after: "" };
  }
  return {
    before: active.label.slice(0, from),
    current: active.label.slice(from, to),
    after: active.label.slice(to),
  };
}

const languageTools = ViewPlugin.fromClass(
  class {
    private request = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private trackingSignature = false;
    private signatureBackoffUntil = 0;
    private disposed = false;

    constructor(readonly view: EditorView) {}

    private allowed(settings: Context) {
      return (
        !this.disposed &&
        settings.wanted() &&
        !this.view.state.readOnly &&
        !this.view.compositionStarted
      );
    }

    update(update: ViewUpdate) {
      const settings = update.state.facet(context)[0];
      if (!settings || !this.allowed(settings) || !this.view.hasFocus) {
        if (this.trackingSignature) this.stopTracking();
        return;
      }
      if (!update.docChanged && !update.selectionSet) return;
      const head = update.state.selection.main.head;
      const char = update.state.sliceDoc(Math.max(0, head - 1), head);
      const trigger =
        update.transactions.some((transaction) => transaction.isUserEvent("input.type")) &&
        (char === "(" || char === ",");
      if (Date.now() < this.signatureBackoffUntil || (!trigger && !this.trackingSignature)) return;
      this.stopTracking();
      this.trackingSignature = true;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.run("parameter-info", true);
      }, 120);
    }

    private stopTracking() {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.trackingSignature = false;
      this.request++;
    }

    close(focus = false) {
      const open = !!this.view.state.field(tooltip);
      const pendingSignature = this.trackingSignature;
      this.stopTracking();
      if (open) this.view.dispatch({ effects: setTooltip.of(null) });
      if (focus) this.view.focus();
      return open || pendingSignature;
    }

    async run(action: EditorLanguageAction, automatic = false) {
      const { view } = this;
      const settings = view.state.facet(context)[0];
      if (!settings || !this.allowed(settings)) return;
      this.close();
      const request = this.request;
      const state = view.state;
      const { doc, selection } = state;
      const { head, from, to } = selection.main;
      const { projectId, path, notify } = settings;
      const wanted = () =>
        this.allowed(settings) &&
        this.request === request &&
        view.state.doc === doc &&
        view.state.selection.eq(selection) &&
        (!automatic || view.hasFocus);
      const content = doc.toString();
      try {
        if (action === "parameter-info") {
          this.trackingSignature = true;
          try {
            const help = await api.lspSignatureHelp(
              projectId,
              path,
              content,
              editorRange(doc, head, head).start,
            );
            if (!wanted()) return;
            this.signatureBackoffUntil = 0;
            const parts = help && signatureParts(help);
            if (!parts) {
              this.trackingSignature = false;
              if (!automatic) notify(t("当前位置没有参数提示。"));
              return;
            }
            view.dispatch({
              effects: setTooltip.of({
                pos: head,
                above: true,
                create() {
                  const dom = document.createElement("div");
                  dom.className = "cm-signature-help";
                  dom.setAttribute("role", "tooltip");
                  const current = document.createElement("strong");
                  current.textContent = parts.current;
                  dom.append(parts.before, current, parts.after);
                  return { dom };
                },
              }),
            });
          } catch (error) {
            if (!wanted()) return;
            this.trackingSignature = false;
            if (errorCode(error) === "unsupported" || errorCode(error) === "toolMissing") {
              this.signatureBackoffUntil = Date.now() + 15_000;
            }
            if (!automatic) notify(errorMessage(error));
          }
          return;
        }

        if (action === "format-code") {
          const indentation = state.facet(indentUnit);
          const result = await api.lspFormat(
            projectId,
            path,
            content,
            from === to ? null : editorRange(doc, from, to),
            {
              tabSize: indentation.includes("\t") ? state.tabSize : indentation.length,
              insertSpaces: !indentation.includes("\t"),
            },
          );
          const applied = await applyEditorEdits(
            view,
            doc,
            result.edits,
            { ...settings, revision: result.revision },
            wanted,
          );
          if (applied === "invalid") notify(t("语言服务器返回了无效的编辑。"));
          if (applied === "unchanged") notify(t("代码已符合格式。"));
          if (applied === "stale" && wanted()) notify(t("语言服务文档已更改，请重试。"));
          return;
        }

        const quickFix = action === "quick-fix";
        const result = await api.lspCodeActions(
          projectId,
          path,
          content,
          quickFix ? quickFixRange(state) : editorRange(doc, 0, doc.length),
          [quickFix ? "quickfix" : "source.organizeImports"],
        );
        if (!wanted()) return;
        const apply = async (item: CodeAction) => {
          if (!wanted()) return;
          try {
            const edits = await codeActionEdits(projectId, path, doc, item);
            if (!wanted()) return;
            if (!edits) {
              notify(t("此操作没有可应用的编辑。"));
              return;
            }
            const applied = await applyEditorEdits(
              view,
              doc,
              edits,
              { ...settings, revision: result.revision },
              wanted,
            );
            if (applied === "invalid") notify(t("语言服务器返回了无效的编辑。"));
            if (applied === "unchanged") notify(t("此操作没有可应用的编辑。"));
            if (applied === "stale" && wanted()) notify(t("语言服务文档已更改，请重试。"));
          } catch (error) {
            if (wanted()) notify(errorMessage(error));
          }
        };
        if (!quickFix) {
          const item = result.actions.find(
            (item) =>
              !item.disabledReason &&
              (item.kind?.startsWith("source.organizeImports") || !item.kind),
          );
          if (item) await apply(item);
          else notify(t(result.message ?? "没有需要整理的导入。"));
          return;
        }
        if (!result.actions.length) {
          notify(t(result.message ?? "当前位置没有可用的快速修复。"));
          return;
        }
        view.dispatch({
          effects: [
            EditorView.scrollIntoView(head),
            setTooltip.of({
              pos: head,
              create: () => ({ dom: this.quickFixMenu(result, apply) }),
            }),
          ],
        });
      } catch (error) {
        if (wanted()) notify(errorMessage(error));
      }
    }

    private quickFixMenu(result: CodeActionResult, apply: (item: CodeAction) => Promise<void>) {
      const dom = document.createElement("div");
      dom.className = "cm-quick-fixes";
      dom.setAttribute("role", "menu");
      dom.setAttribute("aria-label", t("快速修复"));
      const items = [...result.actions].sort(
        (a, b) => Number(b.isPreferred) - Number(a.isPreferred),
      );
      const buttons = items.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.tabIndex = -1;
        button.textContent = item.title;
        if (item.disabledReason) {
          button.setAttribute("aria-disabled", "true");
          button.title = item.disabledReason;
        }
        button.onclick = () => {
          if (item.disabledReason) return;
          this.view.dispatch({ effects: setTooltip.of(null) });
          this.view.focus();
          void apply(item);
        };
        return button;
      });
      dom.append(...buttons);
      dom.addEventListener("keydown", (event) => {
        const index = buttons.findIndex((button) => button === document.activeElement);
        if (event.key === "Escape") this.close(true);
        else if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length]?.focus();
        else if (event.key === "ArrowUp")
          buttons[(index + buttons.length - 1) % buttons.length]?.focus();
        else return;
        event.preventDefault();
        event.stopPropagation();
      });
      dom.addEventListener("focusout", (event) => {
        if (event.relatedTarget instanceof Node && dom.contains(event.relatedTarget)) return;
        queueMicrotask(() => {
          if (dom.isConnected && !dom.contains(document.activeElement)) this.close();
        });
      });
      queueMicrotask(() => {
        if (dom.isConnected)
          (buttons.find((button) => !button.hasAttribute("aria-disabled")) ?? buttons[0])?.focus();
      });
      return dom;
    }

    destroy() {
      this.disposed = true;
      this.stopTracking();
    }
  },
);

export function runEditorLanguageAction(view: EditorView, action: EditorLanguageAction) {
  return view.plugin(languageTools)?.run(action);
}

export function editorLanguageTools(settings: Context) {
  return [
    tooltip,
    context.of(settings),
    languageTools,
    Prec.high(
      keymap.of([
        {
          key: "Alt-Enter",
          run: (view) => {
            void runEditorLanguageAction(view, "quick-fix");
            return !view.state.readOnly;
          },
        },
        {
          key: "Mod-Alt-l",
          run: (view) => {
            void runEditorLanguageAction(view, "format-code");
            return !view.state.readOnly;
          },
        },
        {
          key: "Mod-Alt-o",
          run: (view) => {
            if (view.state.readOnly) return false;
            void runEditorLanguageAction(view, "organize-imports");
            return true;
          },
        },
        {
          key: "Ctrl-Shift-Space",
          run: (view) => {
            if (view.state.readOnly) return false;
            void runEditorLanguageAction(view, "parameter-info");
            return true;
          },
        },
        { key: "Escape", run: (view) => view.plugin(languageTools)?.close() ?? false },
      ]),
    ),
  ];
}
