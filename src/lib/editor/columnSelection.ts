import { invertedEffects } from "@codemirror/commands";
import {
  countColumn,
  EditorSelection,
  EditorState,
  findClusterBreak,
  findColumn,
  Prec,
  StateEffect,
  StateField,
  type ChangeSet,
  type ChangeSpec,
} from "@codemirror/state";
import { EditorView, keymap, layer, RectangleMarker, ViewPlugin } from "@codemirror/view";
import { pasteEditorText } from "./editorClipboard";

type Point = { line: number; column: number };
type Block = { anchor: Point; head: Point };
const pointerBlocks = new WeakMap<EditorSelection, Block>();
const setMode = StateEffect.define<boolean>();
const setBlock = StateEffect.define<Block | null>();
const MAX_COLUMN_DISTANCE = 999;
const columnState = StateField.define<{ on: boolean; block: Block | null }>({
  create: () => ({ on: false, block: null }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMode)) return { on: effect.value, block: null };
      if (effect.is(setBlock)) return { ...value, block: value.on ? effect.value : null };
    }
    if (transaction.selection || transaction.docChanged) {
      const block = transaction.selection && pointerBlocks.get(transaction.selection);
      return { ...value, block: block || null };
    }
    return value;
  },
});

export function columnMode(state: EditorState) {
  return state.field(columnState, false)?.on ?? false;
}

export function toggleColumnSelection(view: EditorView) {
  const state = view.state;
  view.dispatch({ effects: setMode.of(!columnMode(state)) });
  return true;
}

function columnAt(state: EditorState, position: number): Point {
  const line = state.doc.lineAt(position);
  return { line: line.number, column: countColumn(line.text, state.tabSize, position - line.from) };
}

function rectangle(state: Pick<EditorState, "doc" | "tabSize">, { anchor, head }: Block) {
  const ranges = [];
  const first = Math.min(anchor.line, head.line);
  const last = Math.max(anchor.line, head.line);
  for (let number = first; number <= last; number++) {
    const line = state.doc.line(number);
    const from = line.from + findColumn(line.text, anchor.column, state.tabSize);
    const to = line.from + findColumn(line.text, head.column, state.tabSize);
    // Distinguish successive mouse selections that project to the same document offsets.
    ranges.push(EditorSelection.range(from, to, head.column));
  }
  return EditorSelection.create(ranges, head.line - first);
}

function limitBlock({ anchor, head }: Block): Block {
  const offset = Math.max(
    -MAX_COLUMN_DISTANCE,
    Math.min(MAX_COLUMN_DISTANCE, head.line - anchor.line),
  );
  return { anchor, head: { ...head, line: anchor.line + offset } };
}

function selectBlock(view: EditorView, block: Block) {
  block = limitBlock(block);
  view.dispatch({
    selection: rectangle(view.state, block),
    effects: setBlock.of(block),
    scrollIntoView: true,
    userEvent: "select.column",
  });
  return true;
}

function extendBlock(view: EditorView, lines: number, columns: number) {
  const { state } = view;
  const mode = state.field(columnState);
  if (!mode.on || view.compositionStarted) return false;
  const main = state.selection.main;
  const anchor = mode.block?.anchor ?? columnAt(state, main.anchor);
  const head = mode.block?.head ?? columnAt(state, main.head);
  return selectBlock(view, {
    anchor,
    head: {
      line: Math.max(1, Math.min(state.doc.lines, head.line + lines)),
      column: Math.max(0, head.column + columns),
    },
  });
}

function pointerColumn(view: EditorView, event: MouseEvent): Point {
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  const point = columnAt(view.state, position);
  if (view.state.doc.line(point.line).to !== position) return point;
  const end = view.coordsAtPos(position, -1);
  if (end && event.clientY >= end.top && event.clientY <= end.bottom) {
    point.column += Math.max(
      0,
      Math.round((event.clientX - end.right) / (view.defaultCharacterWidth * view.scaleX)),
    );
  }
  return point;
}

function virtualPart(state: EditorState, range: EditorSelection["main"], block: Block) {
  const line = state.doc.lineAt(range.head);
  const width = countColumn(line.text, state.tabSize);
  const from = Math.max(0, Math.min(block.anchor.column, block.head.column) - width);
  const to = Math.max(0, Math.max(block.anchor.column, block.head.column) - width);
  return { from, to, head: Math.max(0, block.head.column - width) };
}

export function selectedEditorText(state: EditorState): string | null {
  const block = state.field(columnState, false)?.block;
  if (block && block.anchor.column !== block.head.column) {
    return state.selection.ranges
      .map((range) => {
        const { from, to } = virtualPart(state, range, block);
        return state.sliceDoc(range.from, range.to) + " ".repeat(to - from);
      })
      .join(state.lineBreak);
  }
  const selected = state.selection.ranges.filter((range) => !range.empty);
  return selected.length
    ? selected.map((range) => state.sliceDoc(range.from, range.to)).join(state.lineBreak)
    : null;
}

export function deleteEditorSelection(view: EditorView, userEvent: string) {
  const { state } = view;
  if (state.readOnly) return;
  const block = state.field(columnState, false)?.block;
  const changes = state.replaceSelection("");
  if (block) {
    const column = Math.min(block.anchor.column, block.head.column);
    commitColumnDeletion(view, block, column, state.changes(changes.changes), userEvent);
  } else {
    view.dispatch(changes, { userEvent, scrollIntoView: true });
  }
}

export function isWithinEditorSelection(view: EditorView, position: number, clientX: number) {
  const block = view.state.field(columnState, false)?.block;
  return view.state.selection.ranges.some((range) => {
    if (position < range.from || position > range.to) return false;
    const line = view.state.doc.lineAt(position);
    if (!block || position !== line.to) return true;
    const end = view.coordsAtPos(position, -1);
    if (!end || clientX <= end.right)
      return !range.empty || virtualPart(view.state, range, block).from === 0;
    const { from, to } = virtualPart(view.state, range, block);
    const x = (clientX - end.right) / (view.defaultCharacterWidth * view.scaleX);
    return from <= x && x <= to;
  });
}

function collapseSelections(view: EditorView) {
  const { state } = view;
  if (!state.field(columnState).block && state.selection.ranges.length === 1) return false;
  view.dispatch({ selection: { anchor: state.selection.main.head }, userEvent: "select" });
  return true;
}

const mouseAndKeyboard = ViewPlugin.fromClass(
  class {
    private releasedOption = 0;
    private doubleOption = false;
    private optionUsed = false;

    constructor(readonly view: EditorView) {}

    keydown(event: KeyboardEvent) {
      if (
        event.key === "Alt" &&
        !event.repeat &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        this.doubleOption = Date.now() - this.releasedOption < 450;
        this.optionUsed = this.doubleOption;
        return false;
      }
      this.optionUsed = true;
      if (
        !event.isComposing &&
        !this.view.compositionStarted &&
        this.doubleOption &&
        event.altKey &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        const direction = event.key === "ArrowUp" ? -1 : 1;
        if (extendBlock(this.view, direction, 0)) return true;
        const { state } = this.view;
        const next = this.view.moveVertically(state.selection.main, direction > 0);
        if (
          !state.selection.ranges.some((range) => range.from <= next.head && next.head <= range.to)
        ) {
          this.view.dispatch({
            selection: state.selection.addRange(next),
            scrollIntoView: true,
            userEvent: "select",
          });
        }
        return true;
      }
      this.doubleOption = false;
      this.releasedOption = 0;
      return false;
    }

    keyup(event: KeyboardEvent) {
      if (event.key !== "Alt") return;
      this.releasedOption = this.optionUsed ? 0 : Date.now();
      this.doubleOption = false;
    }

    blur() {
      this.releasedOption = 0;
      this.doubleOption = false;
    }
  },
  {
    eventHandlers: {
      keydown(event) {
        return this.keydown(event);
      },
      keyup(event) {
        this.keyup(event);
      },
      blur() {
        this.blur();
      },
      mousedown(event, view) {
        if (
          event.button !== 0 ||
          !event.altKey ||
          !event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          view.compositionStarted
        )
          return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const { selection } = view.state;
        const index = selection.ranges.findIndex((range) => range.from <= pos && pos <= range.to);
        if (index < 0) {
          view.dispatch({
            selection: selection.addRange(EditorSelection.cursor(pos)),
            userEvent: "select.pointer",
          });
        } else if (selection.ranges.length > 1) {
          const ranges = selection.ranges.filter((_, i) => i !== index);
          const primary = Math.max(0, selection.mainIndex - (index <= selection.mainIndex ? 1 : 0));
          view.dispatch({
            selection: EditorSelection.create(ranges, primary),
            userEvent: "select.pointer",
          });
        }
        view.focus();
        return true;
      },
      copy(event, view) {
        const block = view.state.field(columnState).block;
        if (!block || block.anchor.column === block.head.column || !event.clipboardData)
          return false;
        event.clipboardData.setData("text/plain", selectedEditorText(view.state) ?? "");
        return true;
      },
      cut(event, view) {
        const block = view.state.field(columnState).block;
        if (!block || block.anchor.column === block.head.column || !event.clipboardData)
          return false;
        event.clipboardData.setData("text/plain", selectedEditorText(view.state) ?? "");
        deleteEditorSelection(view, "delete.cut");
        return true;
      },
      paste(event, view) {
        if (!view.state.field(columnState).block || !event.clipboardData || view.state.readOnly)
          return false;
        const text = event.clipboardData.getData("text/plain");
        if (!text) return false;
        pasteEditorText(view, text);
        return true;
      },
    },
  },
);

export const columnSelection = [
  columnState,
  invertedEffects.of((transaction) => {
    if (!transaction.docChanged) return [];
    const previous = transaction.startState.field(columnState).block;
    return previous || transaction.effects.some((effect) => effect.is(setBlock))
      ? [setBlock.of(previous)]
      : [];
  }),
  Prec.high(mouseAndKeyboard),
  EditorView.clickAddsSelectionRange.of(() => false),
  EditorView.mouseSelectionStyle.of((view, event) => {
    if (
      !columnMode(view.state) ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.detail > 1
    )
      return null;
    let anchor =
      (event.shiftKey && view.state.field(columnState).block?.anchor) || pointerColumn(view, event);
    return {
      update(update) {
        if (!update.docChanged) return;
        const oldLine = update.startState.doc.line(anchor.line);
        anchor = {
          ...anchor,
          line: update.state.doc.lineAt(update.changes.mapPos(oldLine.from)).number,
        };
      },
      get(event) {
        const block = limitBlock({ anchor, head: pointerColumn(view, event) });
        const selection = rectangle(view.state, block);
        pointerBlocks.set(selection, block);
        return selection;
      },
    };
  }),
  Prec.high(
    keymap.of([
      { key: "Shift-ArrowUp", run: (view) => extendBlock(view, -1, 0) },
      { key: "Shift-ArrowDown", run: (view) => extendBlock(view, 1, 0) },
      { key: "Shift-ArrowLeft", run: (view) => extendBlock(view, 0, -1) },
      { key: "Shift-ArrowRight", run: (view) => extendBlock(view, 0, 1) },
      { key: "ArrowLeft", run: (view) => moveVirtualCaret(view, -1) },
      { key: "ArrowRight", run: (view) => moveVirtualCaret(view, 1) },
      { key: "Backspace", run: (view) => deleteVirtualSelection(view, false) },
      { key: "Delete", run: (view) => deleteVirtualSelection(view, true) },
      { key: "Escape", run: collapseSelections },
    ]),
  ),
  EditorState.transactionFilter.of((transaction) => {
    const state = transaction.startState;
    const block = state.field(columnState).block;
    if (!block || state.readOnly || !transaction.docChanged || !transaction.isUserEvent("input"))
      return transaction;
    const padding = new Map(
      state.selection.ranges.map((range) => [range.from, virtualPart(state, range, block).from]),
    );
    const changes: ChangeSpec[] = [];
    transaction.changes.iterChanges((from, _to, insertedAt, _end, insert) => {
      const spaces = padding.get(from) ?? 0;
      if (spaces && insert.length) changes.push({ from: insertedAt, insert: " ".repeat(spaces) });
    }, true);
    return changes.length ? [transaction, { changes, sequential: true }] : transaction;
  }),
  EditorView.editorAttributes.compute([columnState], (state): Record<string, string> =>
    state.field(columnState).block ? { class: "cm-column-block" } : {},
  ),
  layer({
    class: "cm-column-layer",
    above: true,
    markers(view) {
      const block = view.state.field(columnState).block;
      if (!block) return [];
      return view.state.selection.ranges.flatMap((range) => {
        if (range.head < view.viewport.from || range.head > view.viewport.to) return [];
        const base = RectangleMarker.forRange(view, "", EditorSelection.cursor(range.head, -1))[0];
        if (!base) return [];
        const { from, to, head } = virtualPart(view.state, range, block);
        const char = view.defaultCharacterWidth;
        const markers = [
          new RectangleMarker("cm-column-caret", base.left + head * char, base.top, 1, base.height),
        ];
        if (to > from) {
          const line = view.state.doc.lineAt(range.head);
          const end = RectangleMarker.forRange(view, "", EditorSelection.cursor(line.to, -1))[0];
          if (end)
            markers.unshift(
              new RectangleMarker(
                "cm-column-padding",
                end.left + from * char,
                end.top,
                (to - from) * char,
                end.height,
              ),
            );
        }
        return markers;
      });
    },
    update: (update) =>
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.startState.field(columnState) !== update.state.field(columnState),
  }),
  EditorView.baseTheme({
    "&.cm-column-block .cm-cursorLayer": { visibility: "hidden" },
    ".cm-column-padding": { backgroundColor: "var(--selection)" },
    ".cm-column-caret": { backgroundColor: "var(--accent)", visibility: "hidden" },
    "&.cm-focused .cm-column-caret": { visibility: "visible" },
  }),
];

function moveVirtualCaret(view: EditorView, direction: number) {
  const { state } = view;
  if (!columnMode(state) || view.compositionStarted || state.selection.ranges.length !== 1)
    return false;
  const main = state.selection.main;
  const block = state.field(columnState).block;
  const point = block?.head ?? columnAt(state, main.head);
  const line = state.doc.line(point.line);
  const width = countColumn(line.text, state.tabSize);
  if (main.empty && block && block.anchor.column !== block.head.column) {
    const edge = direction < 0 ? Math.min : Math.max;
    const next = { ...point, column: edge(block.anchor.column, block.head.column) };
    return selectBlock(view, { anchor: next, head: next });
  }
  if (!main.empty || main.head !== line.to || (direction < 0 && point.column <= width))
    return false;
  const next = { ...point, column: point.column + direction };
  return selectBlock(view, { anchor: next, head: next });
}

function deleteVirtualSelection(view: EditorView, forward: boolean) {
  const { state } = view;
  const block = state.field(columnState).block;
  if (!block || view.compositionStarted) return false;
  const ranges = state.selection.ranges;
  const virtual = ranges.map((range) => virtualPart(state, range, block).to > 0);
  if (!virtual.some(Boolean)) return false;
  if (state.readOnly) return true;

  if (block.anchor.column !== block.head.column) {
    deleteEditorSelection(view, "delete.selection");
    return true;
  }

  // Delete only within real columns. A virtual caret shares the line-end offset with the newline.
  const changes = state.changes(
    ranges.flatMap((range, index) => {
      if (virtual[index]) return [];
      const line = state.doc.lineAt(range.head);
      const other = line.from + findClusterBreak(line.text, range.head - line.from, forward);
      return other === range.head
        ? []
        : [{ from: Math.min(other, range.head), to: Math.max(other, range.head) }];
    }),
  );
  if (!forward || !changes.empty) {
    const column = Math.max(0, block.head.column - (forward ? 0 : 1));
    commitColumnDeletion(
      view,
      block,
      column,
      changes,
      forward ? "delete.forward" : "delete.backward",
    );
  }
  return true;
}

function commitColumnDeletion(
  view: EditorView,
  block: Block,
  column: number,
  changes: ChangeSet,
  userEvent: string,
) {
  const next = { anchor: { ...block.anchor, column }, head: { ...block.head, column } };
  view.dispatch({
    changes,
    selection: rectangle({ doc: changes.apply(view.state.doc), tabSize: view.state.tabSize }, next),
    effects: setBlock.of(next),
    userEvent,
    scrollIntoView: true,
  });
}
