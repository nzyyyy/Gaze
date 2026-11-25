import { closeCompletion, completionStatus, currentCompletions } from "@codemirror/autocomplete";
import {
  indentUnit,
  language,
  matchBrackets,
  StreamLanguage,
  syntaxTree,
} from "@codemirror/language";
import { forEachDiagnostic } from "@codemirror/lint";
import { Facet, MapMode, Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  hasHoverTooltips,
  hoverTooltip,
  keymap,
  showTooltip,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { api } from "./api";
import { showCompletionDocumentation } from "./completion";
import { applyEditorEdits, codeActionEdits, editorRange } from "./editorEdits";
import { documentationSource } from "./hover";
import { t } from "./i18n";
import type { CodeAction, CodeActionResult, SignatureHelp } from "./types";
import { errorCode, errorMessage } from "./utils";

export type EditorLanguageAction =
  "quick-fix" | "organize-imports" | "format-code" | "parameter-info" | "quick-documentation";

interface Context {
  projectId: string;
  path: string;
  autoParameterInfo?: boolean;
  hoverEnabled?: boolean;
  wanted: () => boolean;
  canEdit?: () => boolean;
  notify: (message: string) => void;
}

const context = Facet.define<Context>();
const completionBlocksHints = (state: EditorState) =>
  completionStatus(state) === "pending" || currentCompletions(state).length > 0;
type LanguageTooltip = Tooltip & { kind?: "signature" | "documentation" };
const setTooltip = StateEffect.define<LanguageTooltip | null>();
const hideHints = StateEffect.define<null>();
const tooltip = StateField.define<LanguageTooltip | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTooltip)) return effect.value;
      if (effect.is(hideHints) && value?.kind) return null;
    }
    return transaction.docChanged ||
      transaction.selection ||
      transaction.startState.facet(context)[0] !== transaction.state.facet(context)[0] ||
      transaction.startState.readOnly !== transaction.state.readOnly ||
      (value?.kind && completionBlocksHints(transaction.state))
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

function callOpening(state: EditorState, fallback: number | null = null) {
  const head = state.selection.main.head;
  const tree = syntaxTree(state);
  for (let node = tree.resolveInner(head, -1); node.parent; node = node.parent) {
    if (!/^(ArgList|Args|Arguments|ArgumentList|ValueArguments)$/.test(node.name)) continue;
    const opening = node.firstChild;
    const closing = node.lastChild;
    if (
      opening?.name === "(" &&
      head > opening.from &&
      (closing?.name !== ")" || head <= closing.from)
    )
      return opening.from;
  }
  // Stream parsers expose tokens only. The LSP confirms that this parenthesis belongs to a call.
  if (
    fallback === null ||
    !(state.facet(language) instanceof StreamLanguage) ||
    head <= fallback ||
    state.sliceDoc(fallback, fallback + 1) !== "(" ||
    !/[\p{L}\p{N}_$>)\]]\s*$/u.test(state.sliceDoc(state.doc.lineAt(fallback).from, fallback))
  )
    return null;
  const token = tree.resolveInner(fallback, 1);
  if (/comment|string/i.test(token.name)) return null;
  const closing = matchBrackets(state, fallback, 1)?.end;
  return closing && head > closing.from ? null : fallback;
}

const languageTools = ViewPlugin.fromClass(
  class {
    private request = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private signature: { opening: number | null; readyAt: number } | null = null;
    private signatureBackoffUntil = 0;
    private documentationPending = false;
    private disposed = false;
    hoverDismissed = false;
    private hoverGeneration = 0;

    constructor(readonly view: EditorView) {}

    private allowed(settings: Context) {
      return (
        !this.disposed &&
        settings.wanted() &&
        settings.canEdit?.() !== false &&
        !this.view.state.readOnly &&
        !this.view.compositionStarted
      );
    }

    hover(settings: Context, pos: number, side: -1 | 1) {
      const generation = this.hoverGeneration;
      const wanted = () =>
        !this.disposed &&
        this.hoverGeneration === generation &&
        !this.hoverDismissed &&
        !this.documentationPending &&
        settings.wanted() &&
        this.view.state.facet(context)[0] === settings &&
        this.view.hasFocus &&
        !this.view.compositionStarted &&
        !this.view.state.field(tooltip) &&
        !completionBlocksHints(this.view.state);
      return documentationSource(settings.projectId, settings.path, wanted)(this.view, pos, side);
    }

    update(update: ViewUpdate) {
      const settings = update.state.facet(context)[0];
      const settingsChanged = settings !== update.startState.facet(context)[0];
      const listOpen = completionBlocksHints(update.state);
      const listChanged = listOpen !== completionBlocksHints(update.startState);
      const lostFocus = update.focusChanged && !this.view.hasFocus;
      if (
        this.documentationPending &&
        (lostFocus ||
          update.docChanged ||
          update.selectionSet ||
          currentCompletions(update.state).length > 0 ||
          settingsChanged)
      ) {
        this.documentationPending = false;
        this.request++;
      }
      if (lostFocus) this.dismissHover();
      if (!settings || !this.allowed(settings) || !this.view.hasFocus) {
        if (this.signature) this.stopTracking();
        return;
      }
      if (settingsChanged && this.signature) this.stopTracking();
      if (!update.docChanged && !update.selectionSet && !listChanged) return;
      const head = update.state.selection.main.head;
      const previous = this.signature;
      const previousOpening =
        previous?.opening == null
          ? null
          : update.changes.mapPos(previous.opening, 1, MapMode.TrackAfter);
      let typedOpening = false;
      let accepted = false;
      if (settings.autoParameterInfo !== false && Date.now() >= this.signatureBackoffUntil) {
        for (const transaction of update.transactions) {
          typedOpening ||= transaction.docChanged && transaction.isUserEvent("input.type");
          accepted ||= transaction.docChanged && transaction.isUserEvent("input.complete");
        }
      }
      if (!previous && !typedOpening && !accepted) return;
      const afterOpening =
        typedOpening && head > 0 && update.state.sliceDoc(head - 1, head) === "(";
      let insertedOpening = afterOpening ? head - 1 : null;
      let acceptedFrom: number | null = null;
      if (accepted) {
        update.changes.iterChanges((_from, _to, from, to) => {
          if (from >= head || to < head) return;
          acceptedFrom = from;
          const index = update.state.sliceDoc(from, head).lastIndexOf("(");
          if (index >= 0) insertedOpening = from + index;
        });
      }
      if (!previous && insertedOpening === null) return;
      const opening = callOpening(update.state, insertedOpening ?? previousOpening);
      this.stopTracking();
      if (opening === null) return;
      if (previous && opening === previousOpening) this.signature = { ...previous, opening };
      else if (opening === insertedOpening || (acceptedFrom !== null && opening >= acceptedFrom))
        this.signature = { opening, readyAt: Date.now() + 1000 };
      if (!this.signature || listOpen) return;
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          void this.run("parameter-info", true);
        },
        Math.max(120, this.signature.readyAt - Date.now()),
      );
    }

    private stopTracking() {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.signature = null;
      this.request++;
    }

    dismissHover() {
      this.hoverDismissed = true;
      this.hoverGeneration++;
    }

    close(focus = false) {
      const open = !!this.view.state.field(tooltip);
      const pending = !!this.signature || this.documentationPending;
      this.dismissHover();
      this.documentationPending = false;
      this.stopTracking();
      if (open || hasHoverTooltips(this.view.state))
        this.view.dispatch({ effects: setTooltip.of(null) });
      if (focus) this.view.focus();
      return open || pending;
    }

    async run(action: EditorLanguageAction, automatic = false) {
      const { view } = this;
      const settings = view.state.facet(context)[0];
      if (!settings || !settings.wanted() || view.compositionStarted) return;
      if (action === "quick-documentation") {
        this.close();
        if (currentCompletions(view.state).length) {
          if (!showCompletionDocumentation(view)) settings.notify(t("没有找到快速文档。"));
          return;
        }
        const request = this.request;
        this.documentationPending = true;
        const wanted = () =>
          !this.disposed && settings.wanted() && view.hasFocus && this.request === request;
        const tip = await documentationSource(settings.projectId, settings.path, wanted)(
          view,
          view.state.selection.main.head,
          0,
        );
        if (this.request === request) this.documentationPending = false;
        if (!wanted()) return;
        if (tip) view.dispatch({ effects: setTooltip.of({ ...tip, kind: "documentation" }) });
        else settings.notify(t("没有找到快速文档。"));
        return;
      }
      if (!this.allowed(settings)) return;
      if (!automatic) {
        this.close();
        if (action === "parameter-info") closeCompletion(view);
      }
      const request = ++this.request;
      const state = view.state;
      const { doc, selection } = state;
      const { head, from, to } = selection.main;
      const { projectId, path, notify } = settings;
      const wanted = () =>
        this.allowed(settings) &&
        this.request === request &&
        view.state.doc === doc &&
        view.state.selection.eq(selection) &&
        (!automatic || view.hasFocus) &&
        (action !== "parameter-info" || !completionBlocksHints(view.state));
      const content = doc.toString();
      try {
        if (action === "parameter-info") {
          if (!automatic) this.signature = { opening: callOpening(state), readyAt: Date.now() };
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
              this.signature = null;
              if (!automatic) notify(t("当前位置没有参数提示。"));
              return;
            }
            view.dispatch({
              effects: setTooltip.of({
                kind: "signature",
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
            this.signature = null;
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
  {
    eventObservers: {
      mousemove() {
        this.hoverDismissed = false;
      },
      mouseleave() {
        this.dismissHover();
      },
    },
  },
);

export function dismissEditorLanguageTooltip(view: EditorView) {
  return view.plugin(languageTools)?.close() ?? false;
}

export function runEditorLanguageAction(view: EditorView, action: EditorLanguageAction) {
  return view.plugin(languageTools)?.run(action);
}

export function editorLanguageTools(settings: Context) {
  const hover = hoverTooltip(
    (view, pos, side) => view.plugin(languageTools)?.hover(settings, pos, side) ?? null,
    {
      hoverTime: 400,
      hideOnChange: true,
      hideOn: (transaction) =>
        completionBlocksHints(transaction.state) ||
        transaction.effects.some((effect) => effect.is(setTooltip) || effect.is(hideHints)),
    },
  );
  return [
    tooltip,
    context.of(settings),
    languageTools,
    settings.hoverEnabled ? hover : [],
    EditorView.focusChangeEffect.of((_state, focusing) => (focusing ? null : hideHints.of(null))),
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
        {
          key: "F1",
          run: (view) => {
            if (!settings.wanted() || view.compositionStarted) return false;
            void runEditorLanguageAction(view, "quick-documentation");
            return true;
          },
        },
      ]),
    ),
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            const hoverOpen = !!view.state.field(hover.active, false)?.length;
            const closed = dismissEditorLanguageTooltip(view) || hoverOpen;
            return closed && !completionStatus(view.state);
          },
        },
      ]),
    ),
  ];
}
