import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

// shortcut: requires bracket tokens in the syntax tree; extend for stream parsers when needed.
const opening = new Set(["(", "[", "{", "${", "InterpolationStart"]);
const closing = new Set([")", "]", "}", "InterpolationEnd"]);
const marks = [0, 1, 2].map((level) => Decoration.mark({ class: `cm-rainbow-bracket-${level}` }));

function decorate(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    let depth = 0;
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.to <= from || node.from >= to) return false;
        if (node.from < from) {
          // Restore nesting from ancestors when scrolling or folding hides opening brackets.
          for (
            let child = node.node.firstChild;
            child && child.to <= from;
            child = child.nextSibling
          ) {
            if (opening.has(child.name)) depth++;
            else if (closing.has(child.name)) depth = Math.max(0, depth - 1);
          }
          return;
        }
        const open = opening.has(node.name);
        const close = closing.has(node.name);
        if (!open && !close) return;
        if (close) depth = Math.max(0, depth - 1);
        ranges.push(marks[depth % marks.length]!.range(node.to - 1, node.to));
        if (open) depth++;
      },
    });
  }
  return Decoration.set(ranges, true);
}

export const rainbowBrackets = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = decorate(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
  EditorView.baseTheme({
    ".cm-content .cm-rainbow-bracket-0": { color: "var(--icon-config)" },
    ".cm-content .cm-rainbow-bracket-1": { color: "var(--icon-data)" },
    ".cm-content .cm-rainbow-bracket-2": { color: "var(--icon-image)" },
  }),
];
