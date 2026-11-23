import {
  acceptCompletion,
  autocompletion,
  completeAnyWord,
  completionKeymap,
  pickedCompletion,
  selectedCompletion,
  snippet,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { api, type CodeCompletion, type CompletionEdit } from "./api";
import { errorCode } from "./utils";

interface RankedCompletion extends Completion {
  serverSort?: string;
  description?: string | null;
}

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
        options: result.items.flatMap((item) => {
          const insertion = item.edit?.insert ?? item.insertText;
          if (item.snippet && snippetTemplate(insertion) === null) return [];
          let request: Promise<CodeCompletion | null> | undefined;
          let resolved: CodeCompletion | null | undefined;
          const resolve = () => {
            if (!item.resolve) return Promise.resolve(null);
            return (request ??= api
              .resolveCompletion(projectId, path, doc.toString(), item.resolve)
              .catch(() => null)
              .then((value) => (resolved = value)));
          };
          const option: RankedCompletion = {
            label: item.filterText ?? item.label,
            displayLabel:
              item.filterText && item.filterText !== item.label ? item.label : undefined,
            detail: item.detail ?? undefined,
            description: item.description,
            serverSort: item.sortText ?? undefined,
            info: item.documentation ?? undefined,
            type: kinds[item.kind ?? 0] ?? "text",
            boost: 1,
            apply(view, completion, start, end) {
              const selection = view.state.selection;
              if (view.state.readOnly || view.state.doc !== doc) return;
              const accept = (candidate: CodeCompletion | null) => {
                if (
                  view.state.doc !== doc ||
                  view.state.readOnly ||
                  !view.state.selection.eq(selection) ||
                  (item.resolve && (!view.dom.isConnected || !view.hasFocus))
                )
                  return;
                applyLspCompletion(view, completion, item, candidate, start, end);
              };
              if (item.resolve && resolved === undefined) void resolve().then(accept);
              else accept(resolved ?? null);
            },
          };
          if (item.resolve) {
            option.info = async () => {
              await new Promise((ready) => setTimeout(ready, 260));
              if (
                context.aborted ||
                !context.view ||
                context.view.state.doc !== doc ||
                selectedCompletion(context.view.state) !== option
              )
                return null;
              const current = await resolve();
              const text = current?.documentation || item.documentation || current?.detail;
              if (!text) return null;
              const node = document.createElement("div");
              node.className = "completion-documentation";
              node.textContent = text;
              return node;
            };
          }
          return [option];
        }),
      };
    } catch (error) {
      unavailable = ["toolMissing", "unsupported"].includes(errorCode(error) ?? "");
      // Missing or unavailable language servers leave local completions usable.
      return null;
    }
  };
}

function applyLspCompletion(
  view: EditorView,
  completion: Completion,
  item: CodeCompletion,
  resolved: CodeCompletion | null,
  start: number,
  end: number,
) {
  const initial = item.edit ?? { from: start, to: end, insert: item.insertText };
  const next =
    resolved?.edit ?? (resolved && { from: start, to: end, insert: resolved.insertText });
  const useResolved =
    next &&
    next.from === initial.from &&
    next.to === initial.to &&
    (!resolved?.snippet || snippetTemplate(next.insert) !== null);
  const main = useResolved ? next : initial;
  const isSnippet = useResolved ? resolved?.snippet : item.snippet;
  const extra = resolved?.additionalEdits.length ? resolved.additionalEdits : item.additionalEdits;
  const edits = checkedEdits(main, extra, view.state.doc.length);
  if (!edits) return;
  const template = isSnippet ? snippetTemplate(main.insert) : null;
  if (template !== null) {
    snippet(template)(
      {
        state: view.state,
        dispatch(transaction) {
          view.dispatch(
            view.state.update(
              { changes: edits.filter((edit) => edit !== main) },
              {
                changes: transaction.changes,
                selection: transaction.selection,
                effects: transaction.effects,
                annotations: [
                  Transaction.userEvent.of("input.complete"),
                  pickedCompletion.of(completion),
                ],
                scrollIntoView: true,
              },
            ),
          );
        },
      },
      completion,
      main.from,
      main.to,
    );
    return;
  }
  const changes = view.state.changes(edits);
  view.dispatch({
    changes,
    selection: {
      anchor: changes.mapPos(main.from, -1) + view.state.toText(main.insert).length,
    },
    annotations: [Transaction.userEvent.of("input.complete"), pickedCompletion.of(completion)],
    scrollIntoView: true,
  });
}

export function snippetTemplate(text: string): string | null {
  // shortcut: map numbered tab stops and defaults; add a TextMate parser for choices, variables and transforms.
  const parts = text.matchAll(/\\[\$}]|\$\{\d+(?::[^{}$\\\r\n]*)?\}|\$(\d+)|\$/g);
  let template = "";
  let end = 0;
  const literal = (value: string) => value.replace(/[{}]/g, "\\$&");
  for (const part of parts) {
    template += literal(text.slice(end, part.index));
    if (part[0] === "$") return null;
    if (part[0][0] === "\\") template += literal(part[0].slice(1));
    else template += part[1] ? "${" + part[1] + "}" : part[0];
    end = part.index + part[0].length;
  }
  return template + literal(text.slice(end));
}

function checkedEdits(main: CompletionEdit, extra: CompletionEdit[], length: number) {
  const edits = [main, ...extra].sort((a, b) => a.from - b.from || a.to - b.to);
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

export interface CompletionContribution {
  sources(state: EditorState, pos: number): { autocomplete: CompletionSource }[] | undefined;
  extension: Extension;
}

export function codeCompletion(
  projectId: string,
  path: string,
  contribution?: CompletionContribution,
  semantic = true,
) {
  const sources = semantic
    ? [{ autocomplete: lspCompletionSource(projectId, path) }, { autocomplete: completeAnyWord }]
    : [{ autocomplete: completeAnyWord }];
  return [
    autocompletion({
      interactionDelay: 0,
      maxRenderedOptions: 32,
      compareCompletions(a: RankedCompletion, b: RankedCompletion) {
        if (a.serverSort !== undefined && b.serverSort !== undefined)
          return a.serverSort < b.serverSort ? -1 : a.serverSort > b.serverSort ? 1 : 0;
        return a.label.localeCompare(b.label);
      },
      addToOptions: [
        {
          position: 85,
          render(completion: RankedCompletion) {
            if (!completion.description) return null;
            const description = document.createElement("span");
            description.className = "completion-origin";
            description.textContent = completion.description;
            return description;
          },
        },
      ],
    }),
    EditorState.languageData.of((state, pos) => contribution?.sources(state, pos) ?? sources),
    Prec.high(keymap.of([...completionKeymap, { key: "Tab", run: acceptCompletion }])),
    contribution?.extension ?? [],
  ];
}
