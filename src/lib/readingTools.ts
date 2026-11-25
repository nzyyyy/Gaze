import { selectParentSyntax } from "@codemirror/commands";
import { foldNodeProp, syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { appendHighlightedText } from "./highlightedText";
import { t } from "./i18n";

const setSelectionHistory = StateEffect.define<readonly EditorSelection[]>();
const selectionHistory = StateField.define<readonly EditorSelection[]>({
  create: () => [],
  update(history, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSelectionHistory)) return effect.value;
    }
    return transaction.docChanged || transaction.selection ? [] : history;
  },
});

export const syntaxSelection = [
  selectionHistory,
  keymap.of([
    {
      key: "Mod-Alt-Shift-ArrowUp",
      run: (view) =>
        selectParentSyntax({
          state: view.state,
          dispatch: (transaction) =>
            view.dispatch({
              selection: transaction.selection,
              scrollIntoView: true,
              effects: setSelectionHistory.of([
                ...view.state.field(selectionHistory),
                view.state.selection,
              ]),
            }),
        }),
    },
    {
      key: "Mod-Alt-Shift-ArrowDown",
      run(view) {
        const history = view.state.field(selectionHistory);
        const selection = history.at(-1);
        if (!selection) return false;
        view.dispatch({
          selection,
          effects: setSelectionHistory.of(history.slice(0, -1)),
          scrollIntoView: true,
        });
        return true;
      },
    },
  ]),
];

export function stickyHeaders(state: EditorState, lineNumber: number): number[] {
  const { doc } = state;
  const line = doc.line(lineNumber);
  const firstCode = line.from + (line.text.length - line.text.trimStart().length);
  const headers = new Set<number>();
  for (let node = syntaxTree(state).resolveInner(firstCode, 1); node.parent; node = node.parent) {
    if (!node.type.prop(foldNodeProp) || node.to <= firstCode) continue;
    const opening = doc.lineAt(node.from);
    const header =
      /^(Body|Block|ClassBody|Suite)$/.test(node.name) &&
      /^\s*(?:\{\s*)?$/.test(opening.text.slice(0, node.from - opening.from))
        ? doc.lineAt(node.parent.from)
        : opening;
    if (header.number < lineNumber) headers.add(header.number);
    if (headers.size === 3) break;
  }
  return [...headers].sort((a, b) => a - b);
}

export const stickyScroll = ViewPlugin.fromClass(
  class {
    readonly dom = document.createElement("div");
    private headers: number[] = [];
    private state: EditorState | undefined;

    constructor(readonly view: EditorView) {
      this.dom.className = "cm-sticky-headers";
      this.dom.setAttribute("role", "group");
      this.dom.setAttribute("aria-label", t("代码标题吸顶"));
      this.dom.hidden = true;
      view.dom.append(this.dom);
      this.measure();
    }

    update(update: ViewUpdate) {
      if (update.transactions.some((transaction) => transaction.reconfigured)) {
        this.state = undefined;
      }
      this.measure();
    }

    measure() {
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          if (!view.inView) return { line: 1, indent: 0 };
          const bounds = view.scrollDOM.getBoundingClientRect();
          const block = view.lineBlockAtHeight(bounds.top - view.documentTop);
          return {
            line: view.state.doc.lineAt(block.from).number,
            indent:
              view.contentDOM.getBoundingClientRect().left -
              bounds.left +
              view.scrollDOM.scrollLeft,
          };
        },
        write: ({ line, indent }, view) => {
          const headers = stickyHeaders(view.state, line);
          this.dom.style.setProperty("--sticky-gutter", `${Math.max(0, indent)}px`);
          if (
            this.state?.doc === view.state.doc &&
            syntaxTree(this.state) === syntaxTree(view.state) &&
            headers.length === this.headers.length &&
            headers.every((number, index) => number === this.headers[index])
          )
            return;
          this.state = view.state;
          this.headers = headers;
          this.dom.hidden = headers.length === 0;
          this.dom.replaceChildren(
            ...headers.map((number) => {
              const header = view.state.doc.line(number);
              const button = document.createElement("button");
              button.type = "button";
              appendHighlightedText(button, view.state, header.from, header.to);
              button.setAttribute(
                "aria-label",
                t("{0}，跳到第 {1} 行", header.text.trim(), number),
              );
              button.onclick = () => {
                view.dispatch({
                  selection: { anchor: header.from },
                  effects: EditorView.scrollIntoView(header.from, { y: "center" }),
                });
                view.focus();
              };
              return button;
            }),
          );
        },
      });
    }

    destroy() {
      this.dom.remove();
    }
  },
  {
    eventObservers: {
      scroll() {
        this.measure();
      },
    },
    provide: (plugin) =>
      EditorView.scrollMargins.of((view) => {
        const headers = view.plugin(plugin)?.dom;
        return headers && !headers.hidden ? { top: headers.offsetHeight } : null;
      }),
  },
);
