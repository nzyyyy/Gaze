import { isolateHistory } from "@codemirror/commands";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { api } from "../platform/api";
import type { CodeAction, DocumentRevision, LspRange, TextEdit } from "../types";

export function editorRange(doc: Text, from: number, to: number): LspRange {
  const position = (offset: number) => {
    const line = doc.lineAt(offset);
    return { line: line.number - 1, character: offset - line.from };
  };
  return { start: position(from), end: position(to) };
}

export async function codeActionEdits(
  projectId: string,
  path: string,
  doc: Text,
  action: CodeAction,
): Promise<TextEdit[] | undefined> {
  if (action.disabledReason) return;
  if (!action.edit && action.resolve) {
    const resolved = await api.lspResolveCodeAction(
      projectId,
      path,
      doc.toString(),
      action.resolve,
    );
    if (!resolved || resolved.disabledReason) return;
    action = resolved;
  }
  const files = action.edit?.files;
  return files?.length === 1 && files[0]?.path === path ? files[0].edits : undefined;
}

export async function applyEditorEdits(
  view: EditorView,
  doc: Text,
  edits: readonly TextEdit[],
  target: { projectId: string; path: string; revision?: DocumentRevision | null },
  wanted: () => boolean,
): Promise<"applied" | "unchanged" | "invalid" | "stale"> {
  const current = () =>
    view.state.doc === doc && !view.state.readOnly && !view.compositionStarted && wanted();
  if (!current()) return "stale";
  const ordered = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let end = 0;
  const validOffset = (offset: number) =>
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset <= doc.length &&
    (offset === 0 ||
      offset === doc.length ||
      !/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(doc.sliceString(offset - 1, offset + 1)));
  for (const { from, to } of ordered) {
    if (!validOffset(from) || !validOffset(to) || from < end || to < from) return "invalid";
    end = to;
  }
  const changes = ordered.filter(({ from, to, insert }) => doc.sliceString(from, to) !== insert);
  if (!changes.length) return "unchanged";
  if (
    target.revision &&
    !(await api.lspEditorRevisionMatches(
      target.projectId,
      target.path,
      doc.toString(),
      target.revision,
    ))
  )
    return "stale";
  if (!current()) return "stale";
  view.dispatch({ changes, annotations: isolateHistory.of("full"), userEvent: "input.complete" });
  return "applied";
}
