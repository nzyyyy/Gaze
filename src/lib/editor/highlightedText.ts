import { highlightingFor, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";

export function syntaxTokens(state: EditorState, from: number, to: number) {
  const ranges: { from: number; to: number; classes: string }[] = [];
  highlightTree(
    syntaxTree(state),
    { style: (tags) => highlightingFor(state, tags) },
    (start, end, classes) =>
      ranges.push({ from: Math.max(from, start), to: Math.min(to, end), classes }),
    from,
    to,
  );
  return ranges;
}

export function appendHighlightedText(
  element: HTMLElement,
  state: EditorState,
  from: number,
  to: number,
) {
  let position = from;
  for (const token of syntaxTokens(state, from, to)) {
    if (token.from > position) element.append(state.doc.sliceString(position, token.from));
    const span = element.ownerDocument.createElement("span");
    span.className = token.classes;
    span.textContent = state.doc.sliceString(token.from, token.to);
    element.append(span);
    position = token.to;
  }
  if (position < to) element.append(state.doc.sliceString(position, to));
}
