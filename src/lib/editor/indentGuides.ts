import { matchBrackets, syntaxTree } from "@codemirror/language";
import {
  countColumn,
  EditorSelection,
  RangeSet,
  RangeValue,
  type EditorState,
} from "@codemirror/state";
import { BlockType, EditorView, layer, RectangleMarker, ViewPlugin } from "@codemirror/view";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";

const commentHighlighter = tagHighlighter([{ tag: tags.comment, class: "comment" }]);
const leadingIndent = /^[ \t]*/;

class IndentGuide extends RangeValue {
  constructor(readonly column: number) {
    super();
  }
}

interface GuideSegment {
  from: number;
  lastLine: number;
  column: number;
  x: number;
  top: number;
  bottom: number;
  active: boolean;
}

function buildGuides(state: EditorState) {
  const comments: { from: number; to: number }[] = [];
  highlightTree(syntaxTree(state), commentHighlighter, (from, to) => comments.push({ from, to }));

  const ranges = [];
  const open: { from: number; value: IndentGuide }[] = [];
  let from = 0;
  let previousLine = 0;
  let previousCodeLine = 0;
  let previousColumn = 0;
  let commentIndex = 0;

  for (const line of state.doc.iterLines()) {
    const indent = leadingIndent.exec(line)![0].length;
    const first = from + indent;
    while (comments[commentIndex] && comments[commentIndex]!.to <= first) commentIndex++;
    const comment = comments[commentIndex];

    if (indent < line.length && (!comment || first < comment.from)) {
      const column = countColumn(line, state.tabSize, indent);
      // Blank and comment lines can extend to a closing delimiter even when it dedents.
      const end = "}])".includes(line[indent]!) ? previousLine : previousCodeLine;
      while (open.length && column <= open[open.length - 1]!.value.column) {
        const guide = open.pop()!;
        ranges.push(guide.value.range(guide.from, end));
      }
      if (previousColumn > 0 && column - previousColumn > 1) {
        open.push({ from: previousCodeLine, value: new IndentGuide(previousColumn) });
      }
      previousCodeLine = from;
      previousColumn = column;
    }

    previousLine = from;
    from += line.length + 1;
  }
  for (const guide of open) ranges.push(guide.value.range(guide.from, previousLine));
  return RangeSet.of(ranges, true);
}

const guideCache = ViewPlugin.fromClass(
  class {
    private state?: EditorState;
    private guides: RangeSet<IndentGuide> = RangeSet.empty;

    get(state: EditorState) {
      if (
        this.state?.doc !== state.doc ||
        this.state.tabSize !== state.tabSize ||
        syntaxTree(this.state) !== syntaxTree(state)
      ) {
        this.guides = buildGuides(state);
        this.state = state;
      }
      return this.guides;
    }
  },
);

function guideSegments(view: EditorView): GuideSegment[] {
  if (!view.inView) return [];
  const {
    state,
    scrollDOM,
    contentDOM,
    scaleX,
    lineWrapping,
    defaultCharacterWidth,
    defaultLineHeight,
  } = view;
  const guides = view.plugin(guideCache)?.get(state);
  if (!guides?.size) return [];

  const line = view.contentDOM.querySelector(".cm-line");
  if (!line) return [];

  const head = state.selection.main.head;
  const caretLine = state.doc.lineAt(head);
  const caretColumn = countColumn(caretLine.text, state.tabSize, head - caretLine.from);
  const content = contentDOM.getBoundingClientRect();
  const style = getComputedStyle(line);
  const contentLeft =
    content.left - scrollDOM.getBoundingClientRect().left + scrollDOM.scrollLeft * scaleX;
  const left = contentLeft + (parseFloat(style.paddingLeft) || 0) * scaleX;
  const right = contentLeft + content.width - (parseFloat(style.paddingRight) || 0) * scaleX;
  const topPadding = view.documentPadding.top;
  const segments: GuideSegment[] = [];
  const pending = new Map<IndentGuide, GuideSegment>();

  for (const lineBlock of view.viewportLineBlocks) {
    const blocks = typeof lineBlock.type === "number" ? [lineBlock] : lineBlock.type;
    for (const block of blocks) {
      if (block.type !== BlockType.Text || block.height <= 0) continue;
      guides.between(lineBlock.from, lineBlock.from, (start, end, guide) => {
        if (start === lineBlock.from) return;
        const x = Math.round(left + guide.column * defaultCharacterWidth) - 1;
        if (lineWrapping && x >= right) return;
        const active =
          guide.column === caretColumn && caretLine.from >= start && caretLine.from <= end;
        const top = topPadding + block.top;
        const height =
          lineWrapping && !active ? Math.min(block.height, defaultLineHeight) : block.height;
        const bottom = top + height;
        const previous = pending.get(guide);
        if (previous && Math.abs(previous.bottom - top) < 0.01) {
          previous.bottom = bottom;
        } else {
          if (previous) segments.push(previous);
          pending.set(guide, {
            from: start,
            lastLine: end,
            column: guide.column,
            x,
            top,
            bottom,
            active,
          });
        }
      });
    }
  }
  for (const segment of pending.values()) segments.push(segment);
  return segments;
}

function guideSelectionEnd(state: EditorState, guide: GuideSegment) {
  const { doc, tabSize } = state;
  const end = Math.min(doc.lineAt(guide.lastLine).to + 1, doc.length);
  if (end === doc.length) return end;

  const next = doc.lineAt(end);
  const indent = leadingIndent.exec(next.text)![0].length;
  const delimiter = next.text[indent];
  if (
    !delimiter ||
    !"}])".includes(delimiter) ||
    countColumn(next.text, tabSize, indent) !== guide.column
  ) {
    return end;
  }

  const close = end + indent + 1;
  const match = matchBrackets(state, close, -1);
  if (!match?.matched || !match.end || match.end.from < guide.from) return end;
  const spaces = leadingIndent.exec(doc.sliceString(close, next.to))![0].length;
  return close + spaces === next.to ? Math.min(next.to + 1, doc.length) : close + spaces;
}

export const indentDoubleClick = EditorView.mouseSelectionStyle.of((view, event) => {
  if (
    event.detail !== 2 ||
    event.button !== 0 ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return null;
  }

  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  const line = view.state.doc.lineAt(pos);
  const indent = leadingIndent.exec(line.text)![0].length;
  if (!indent) return null;
  const indentEnd = line.from + indent;
  if (indent < line.length && pos >= indentEnd) {
    // A click in the last half of a tab can resolve to the offset after it.
    const edge = pos === indentEnd ? view.coordsAtPos(indentEnd, -1) : null;
    if (!edge || event.clientX >= edge.left) return null;
  }

  const rect = view.scrollDOM.getBoundingClientRect();
  const x = event.clientX - rect.left + view.scrollDOM.scrollLeft * view.scaleX;
  const y = event.clientY - rect.top + view.scrollDOM.scrollTop * view.scaleY;
  const guide = guideSegments(view).find(
    (segment) => Math.abs(x - (segment.x + 0.5)) <= 2 && y >= segment.top && y < segment.bottom,
  );
  // A whitespace selection would mark every matching indent in the viewport.
  let selection = guide
    ? EditorSelection.single(guide.from, guideSelectionEnd(view.state, guide))
    : EditorSelection.single(pos);
  return {
    get: () => selection,
    update: (update) => {
      if (update.docChanged) selection = selection.map(update.changes);
    },
  };
});

export const indentGuides = [
  guideCache,
  layer({
    above: false,
    class: "cm-indent-guides",
    markers: (view) =>
      guideSegments(view).map(
        ({ x, top, bottom, active }) =>
          new RectangleMarker(
            active ? "cm-indent-guide-active" : "cm-indent-guide",
            x,
            top,
            1,
            bottom - top,
          ),
      ),
    update: (update) =>
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.startState.tabSize !== update.state.tabSize ||
      syntaxTree(update.startState) !== syntaxTree(update.state) ||
      update.transactions.some((transaction) => transaction.reconfigured),
  }),
  EditorView.baseTheme({
    ".cm-indent-guides": { pointerEvents: "none" },
    ".cm-indent-guide": { backgroundColor: "var(--border)", opacity: "0.55" },
    ".cm-indent-guide-active": { backgroundColor: "var(--text-faint)", opacity: "0.6" },
  }),
];
