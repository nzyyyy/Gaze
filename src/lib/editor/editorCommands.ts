import { copyLineDown, deleteLine, moveLineDown, moveLineUp } from "@codemirror/commands";
import { gotoLine, openSearchPanel, SearchCursor } from "@codemirror/search";
import { EditorSelection, StateEffect, StateField, type EditorState } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import { toggleColumnSelection } from "./columnSelection";
import { moveStatement } from "./moveStatement";
import { extendSyntaxSelection, shrinkSyntaxSelection } from "./readingTools";

const MAX_MATCHES = 1000;
type MatchSelection = { wholeWord: boolean; added: readonly number[] };
const setMatches = StateEffect.define<MatchSelection>();

export const matchSelection = StateField.define<MatchSelection | null>({
  create: () => null,
  update(value, transaction) {
    const effect = transaction.effects.find((effect) => effect.is(setMatches));
    return effect?.value ?? (transaction.selection || transaction.docChanged ? null : value);
  },
});

function* matchingRanges(
  state: EditorState,
  text: string,
  wholeWord: boolean,
  from = 0,
  to = state.doc.length,
) {
  for (const match of new SearchCursor(state.doc, text, from, to)) {
    if (state.sliceDoc(match.from, match.to) !== text) continue;
    if (wholeWord) {
      const word = state.wordAt(match.from);
      if (word?.from !== match.from || word.to !== match.to) continue;
    }
    yield EditorSelection.range(match.from, match.to);
  }
}

const selectNextMatch: Command = (view) => {
  const { state } = view;
  const { selection } = state;
  const { main, ranges } = selection;
  if (main.empty) {
    const word = state.wordAt(main.head);
    if (word)
      view.dispatch({
        selection: selection.replaceRange(word),
        effects: setMatches.of({ wholeWord: true, added: [] }),
        userEvent: "select.match",
      });
    return true;
  }
  if (ranges.length >= MAX_MATCHES) return true;

  const previous = state.field(matchSelection);
  const wholeWord = previous?.wholeWord ?? false;
  const text = state.sliceDoc(main.from, main.to);
  const search = (from: number, to: number) => {
    for (const match of matchingRanges(state, text, wholeWord, from, to)) {
      if (!ranges.some((range) => range.from < match.to && range.to > match.from)) return match;
    }
  };
  const next = search(main.to, state.doc.length) ?? search(0, main.from);
  if (next)
    view.dispatch({
      selection: selection.addRange(next),
      effects: setMatches.of({ wholeWord, added: [...(previous?.added ?? []), next.from] }),
      scrollIntoView: true,
      userEvent: "select.match",
    });
  return true;
};

const deselectMatch: Command = (view) => {
  const { state } = view;
  const previous = state.field(matchSelection);
  const last = previous?.added.at(-1);
  if (!previous || last === undefined) return true;
  const added = previous.added.slice(0, -1);
  const ranges = state.selection.ranges.filter((range) => range.from !== last);
  const primary =
    added.at(-1) ??
    state.selection.ranges.find((range) => !previous.added.includes(range.from))?.from;
  if (ranges.length)
    view.dispatch({
      selection: EditorSelection.create(
        ranges,
        Math.max(
          0,
          ranges.findIndex((range) => range.from === primary),
        ),
      ),
      effects: setMatches.of({ ...previous, added }),
      scrollIntoView: true,
      userEvent: "select.match",
    });
  return true;
};

const selectAllMatches: Command = (view) => {
  const { state } = view;
  const main = state.selection.main;
  const target = main.empty ? state.wordAt(main.head) : main;
  if (!target) return true;
  const wholeWord = main.empty || (state.field(matchSelection)?.wholeWord ?? false);
  const ranges = [];
  for (const range of matchingRanges(state, state.sliceDoc(target.from, target.to), wholeWord)) {
    if (ranges.length >= MAX_MATCHES) return true;
    ranges.push(range);
  }
  if (ranges.length)
    view.dispatch({
      selection: EditorSelection.create(
        ranges,
        Math.max(
          0,
          ranges.findIndex((range) => range.from === target.from),
        ),
      ),
      effects: setMatches.of({ wholeWord, added: [] }),
      userEvent: "select.match",
    });
  return true;
};

const duplicate: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.every((range) => range.empty)) return copyLineDown(view);
  view.dispatch(
    state.changeByRange((range) => {
      if (range.empty) return { range };
      const length = range.to - range.from;
      return {
        changes: { from: range.to, insert: state.doc.slice(range.from, range.to) },
        range: EditorSelection.range(range.anchor + length, range.head + length),
      };
    }),
    { userEvent: "input.duplicate", scrollIntoView: true },
  );
  return true;
};

const editing =
  (command: Command): Command =>
  (view) => {
    if (!view.state.readOnly) command(view);
    return true;
  };

export const editorCommands = {
  "select-next-match": selectNextMatch,
  "deselect-match": deselectMatch,
  "select-all-matches": selectAllMatches,
  "column-selection": toggleColumnSelection,
  duplicate: editing(duplicate),
  "move-line-up": editing(moveLineUp),
  "move-line-down": editing(moveLineDown),
  "move-statement-up": editing((view) => moveStatement(view, true)),
  "move-statement-down": editing((view) => moveStatement(view, false)),
  "delete-line": editing(deleteLine),
  "go-to-line": (view: Parameters<Command>[0]) => {
    gotoLine(view);
    const field = view.dom.querySelector<HTMLInputElement>('.cm-goto-line input[name="line"]');
    field?.focus();
    field?.select();
    return true;
  },
  "replace-in-file": editing((view) => {
    openSearchPanel(view);
    const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]');
    field?.focus();
    field?.select();
    return true;
  }),
  "extend-selection": extendSyntaxSelection,
  "shrink-selection": shrinkSyntaxSelection,
};
