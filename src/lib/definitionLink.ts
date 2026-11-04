import { syntaxTree } from "@codemirror/language";
import { api } from "./api";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { TextPosition } from "./types";

function modifier(event: MouseEvent | KeyboardEvent) {
  return (
    !event.shiftKey &&
    !event.altKey &&
    (/Mac/.test(navigator.userAgent)
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey)
  );
}

interface Candidate {
  from: number;
  to: number;
  pos: number;
  href?: string;
  module?: boolean;
}
type Target = { path: string; fragment: string | null } | "definition";

function candidateAt(view: EditorView, pos: number): Candidate | null {
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  let node = tree.resolveInner(pos, 1);
  if (
    node.from === pos &&
    !/^(VariableName|VariableDefinition|PropertyName|PropertyDefinition|TypeName|TypeDefinition|Identifier|FieldName|String|AttributeValue|UnquotedAttributeValue)$/.test(
      node.name,
    )
  )
    node = tree.resolveInner(pos, -1);
  for (let current: typeof node | null = node; current; current = current.parent) {
    const attribute =
      current.name === "AttributeValue" || current.name === "UnquotedAttributeValue";
    const string = current.name === "String";
    if (attribute || string) {
      const name = current.parent?.getChild("AttributeName");
      const file = attribute && !!name && /^(src|href)$/i.test(doc.sliceString(name.from, name.to));
      const parent = current.parent;
      const call = parent?.name === "ArgList" ? parent.parent : parent;
      const callee = call?.getChild("VariableName");
      const module =
        string &&
        (/^(ImportDeclaration|ExportDeclaration|DynamicImport)$/.test(parent?.name ?? "") ||
          (call?.name === "CallExpression" &&
            !!callee &&
            doc.sliceString(callee.from, callee.to) === "require"));
      if (!file && !module) return null;
      let from = current.from,
        to = current.to;
      if (/^["']/.test(doc.sliceString(from, from + 1))) {
        const quote = doc.sliceString(from, from + 1);
        from++;
        if (doc.sliceString(to - 1, to) !== quote) return null;
        to--;
      }
      const href = doc.sliceString(from, to);
      if (!href || /[\\\u0000-\u001f]/.test(href) || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href))
        return null;
      return pos >= from && pos <= to
        ? { from, to, pos: Math.min(pos, to - 1), href, module }
        : null;
    }
    if (/Comment|TemplateString/.test(current.name)) return null;
  }
  if (
    !/^(VariableName|VariableDefinition|PropertyName|PropertyDefinition|TypeName|TypeDefinition|Identifier|FieldName)$/.test(
      node.name,
    )
  )
    return null;
  return { from: node.from, to: node.to, pos: pos === node.to ? node.from : pos };
}

async function resolveCandidate(
  projectId: string,
  path: string,
  view: EditorView,
  candidate: Candidate,
): Promise<Target | null> {
  if (candidate.href && !candidate.module)
    return api.resolveMarkdownLink(projectId, path, candidate.href);
  const doc = view.state.doc;
  const line = doc.lineAt(candidate.pos);
  await api.syncDocument(projectId, path, doc.toString()).catch(() => undefined);
  const result = await api.findDefinitions(projectId, path, {
    line: line.number - 1,
    character: candidate.pos - line.from,
  });
  if (result.locations.length) return "definition";
  if (candidate.href) return api.resolveMarkdownLink(projectId, path, candidate.href);
  return null;
}

export function definitionLink(
  projectId: string,
  path: string,
  enabled: () => boolean,
  navigate: (position: TextPosition) => void,
  openFile: (path: string, fragment: string | null) => void,
) {
  return [
    ViewPlugin.fromClass(
      class {
        decorations = Decoration.none;
        pointer: { x: number; y: number } | null = null;
        candidate: Candidate | null = null;
        pending: Promise<Target | null> | null = null;
        timer: ReturnType<typeof setTimeout> | null = null;
        destroyed = false;
        from = -1;
        to = -1;

        constructor(readonly view: EditorView) {
          window.addEventListener("keydown", this.keyChange);
          window.addEventListener("keyup", this.keyChange);
          window.addEventListener("blur", this.leave);
        }

        word(pointer: { x: number; y: number }) {
          if (!enabled()) return null;
          const pos = this.view.posAtCoords(pointer);
          if (pos === null) return null;
          const word = candidateAt(this.view, pos);
          if (!word) return null;
          const start = this.view.coordsAtPos(word.from),
            end = this.view.coordsAtPos(word.to);
          if (
            start &&
            end &&
            start.top === end.top &&
            (pointer.x < Math.min(start.left, end.left) ||
              pointer.x > Math.max(start.right, end.right))
          )
            return null;
          return word;
        }

        highlight(word: Candidate | null, dispatch = true) {
          const from = word?.from ?? -1,
            to = word?.to ?? -1;
          if (this.from === from && this.to === to) return;
          this.from = from;
          this.to = to;
          this.decorations = word
            ? Decoration.set([Decoration.mark({ class: "cm-definition-link" }).range(from, to)])
            : Decoration.none;
          if (dispatch) this.view.dispatch({});
        }

        reset(dispatch = true) {
          if (this.timer !== null) clearTimeout(this.timer);
          this.timer = null;
          this.candidate = null;
          this.pending = null;
          this.highlight(null, dispatch);
        }

        select(candidate: Candidate) {
          if (this.candidate?.from === candidate.from && this.candidate.to === candidate.to) return;
          this.reset();
          this.candidate = candidate;
        }

        lookup(candidate: Candidate) {
          this.select(candidate);
          if (this.timer !== null) clearTimeout(this.timer);
          this.timer = null;
          if (!this.pending) {
            const current = this.candidate,
              doc = this.view.state.doc;
            this.pending = resolveCandidate(projectId, path, this.view, candidate).catch(
              () => null,
            );
            void this.pending.then((target) => {
              if (
                !this.destroyed &&
                this.candidate === current &&
                this.view.state.doc === doc &&
                enabled()
              )
                this.highlight(target ? current : null);
            });
          }
          return this.pending;
        }

        hover(candidate: Candidate | null) {
          if (!candidate) {
            this.reset();
            return;
          }
          if (this.candidate?.from === candidate.from && this.candidate.to === candidate.to) return;
          this.select(candidate);
          this.timer = setTimeout(() => this.lookup(candidate), 120);
        }

        keyChange = (event: KeyboardEvent) => {
          this.hover(this.pointer && modifier(event) ? this.word(this.pointer) : null);
        };

        leave = () => {
          this.pointer = null;
          this.reset();
        };

        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged || update.selectionSet || !enabled()) {
            this.pointer = null;
            this.reset(false);
          }
        }

        destroy() {
          this.destroyed = true;
          this.reset(false);
          window.removeEventListener("keydown", this.keyChange);
          window.removeEventListener("keyup", this.keyChange);
          window.removeEventListener("blur", this.leave);
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
        eventHandlers: {
          mousemove(event) {
            if (
              !(event.target instanceof Element) ||
              !event.target.closest(".cm-content") ||
              event.buttons
            ) {
              this.leave();
              return;
            }
            this.pointer = { x: event.clientX, y: event.clientY };
            this.hover(modifier(event) ? this.word(this.pointer) : null);
          },
          mouseleave() {
            this.leave();
          },
          mousedown(event) {
            if (
              !modifier(event) ||
              event.button !== 0 ||
              !(event.target instanceof Element) ||
              !event.target.closest(".cm-content")
            )
              return false;
            const word = this.word({ x: event.clientX, y: event.clientY });
            if (!word) return false;
            const doc = this.view.state.doc;
            const result = this.lookup(word);
            const line = doc.lineAt(word.pos);
            event.preventDefault();
            this.view.dispatch({ selection: { anchor: word.pos } });
            this.view.focus();
            void result.then((target) => {
              if (!target || this.destroyed || this.view.state.doc !== doc || !enabled()) return;
              if (target === "definition")
                navigate({ line: line.number - 1, character: word.pos - line.from });
              else openFile(target.path, target.fragment);
            });
            return true;
          },
        },
      },
    ),
    EditorView.baseTheme({
      "&light .cm-definition-link": { color: "#006dcc" },
      "&dark .cm-definition-link": { color: "#548af7" },
      ".cm-definition-link": {
        textDecoration: "underline",
        textDecorationThickness: "1px",
        textUnderlineOffset: "1px",
        textDecorationSkipInk: "none",
        cursor: "pointer",
      },
      ".cm-definition-link *": { color: "inherit" },
    }),
  ];
}
