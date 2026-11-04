import {
  acceptCompletion,
  autocompletion,
  completeAnyWord,
  completionKeymap,
  pickedCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, Prec, Transaction } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { api, type CodeCompletion, type CompletionEdit } from "./api";
import { errorCode } from "./utils";

const kinds: Record<number, string> = {
  2: "method",
  3: "function",
  4: "constructor",
  5: "property",
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace",
  10: "property",
  12: "constant",
  13: "enum",
  14: "keyword",
  15: "text",
  17: "text",
  20: "constant",
  22: "class",
  25: "type",
};

export function lspCompletionSource(projectId: string, path: string): CompletionSource {
  let unavailable = false;
  return async (context) => {
    if (unavailable || context.state.readOnly) return null;
    const word = context.matchBefore(/[\p{L}\p{N}_$]+/u);
    const trigger =
      !word && !context.explicit
        ? context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos)
        : null;
    if (!word && !context.explicit && (!trigger || /\s/u.test(trigger))) return null;
    context.addEventListener("abort", () => {}, { onDocChange: true });
    const doc = context.state.doc;
    const line = doc.lineAt(context.pos);
    try {
      const result = await api.completeCode(
        projectId,
        path,
        doc.toString(),
        {
          line: line.number - 1,
          character: context.pos - line.from,
        },
        trigger,
      );
      if (context.aborted || !result.items.length) return null;
      const from = word?.from ?? context.pos;
      return {
        from,
        options: result.items.map((item): Completion => ({
          label: item.filterText ?? item.label,
          displayLabel: item.label,
          detail: item.detail ?? undefined,
          info: item.documentation ?? undefined,
          type: kinds[item.kind ?? 0] ?? "text",
          boost: 1,
          apply(view, completion, start, end) {
            if (view.state.readOnly || view.state.doc !== doc) return;
            const main = item.edit ?? { from: start, to: end, insert: item.insertText };
            const edits = checkedEdits(main, item, doc.length);
            if (!edits) return;
            const changes = view.state.changes(edits);
            view.dispatch({
              changes,
              selection: {
                anchor: changes.mapPos(main.from, -1) + view.state.toText(main.insert).length,
              },
              annotations: [
                Transaction.userEvent.of("input.complete"),
                pickedCompletion.of(completion),
              ],
              scrollIntoView: true,
            });
          },
        })),
      };
    } catch (error) {
      unavailable = ["toolMissing", "unsupported"].includes(errorCode(error) ?? "");
      // Missing or unavailable language servers leave local completions usable.
      return null;
    }
  };
}

function checkedEdits(main: CompletionEdit, item: CodeCompletion, length: number) {
  const edits = [main, ...item.additionalEdits].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < 0 ||
      edit.from > edit.to ||
      edit.to > length
    )
      return null;
    const previous = edits[i - 1];
    if (previous && (previous.to > edit.from || previous.from === edit.from)) return null;
  }
  return edits;
}

export function codeCompletion(projectId: string, path: string) {
  const source = lspCompletionSource(projectId, path);
  return [
    autocompletion({ interactionDelay: 0 }),
    EditorState.languageData.of(() => [
      { autocomplete: source },
      { autocomplete: completeAnyWord },
    ]),
    Prec.high(keymap.of([...completionKeymap, { key: "Tab", run: acceptCompletion }])),
  ];
}
