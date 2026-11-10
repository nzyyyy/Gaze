import { t as tr } from "../lib/i18n";
import type { CodeReaderHandle } from "../components/CodeReader";
import type { OperationRequest } from "./models";
import type { OperationOutcome } from "./types";

export type PrepareGitOperation = (
  root: string,
  request: OperationRequest,
  pathHint?: string,
) => Promise<(outcome: OperationOutcome) => Promise<void>>;

const worktreeOperations = new Set<OperationRequest["type"]>([
  "discardHunk",
  "discardTracked",
  "trashUntracked",
  "switchBranch",
  "merge",
  "rebase",
  "interactiveRebase",
  "cherryPick",
  "continue",
  "skip",
  "abort",
  "chooseConflictSide",
  "markResolved",
  "resolveConflictBlocks",
  "stashCreate",
  "stashApply",
  "revert",
  "runMergetool",
  "pull",
  "submoduleUpdate",
]);

export function changesWorktree(request: OperationRequest) {
  return (
    worktreeOperations.has(request.type) || (request.type === "createBranch" && request.checkout)
  );
}

export function locksEditors(request: OperationRequest) {
  return !["fetch", "push", "forcePushWithLease"].includes(request.type);
}

export function insideWorktree(absolute: string, root: string) {
  const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/$/, "");
  let path = normalize(absolute),
    base = normalize(root);
  if (/^[a-z]:/i.test(base)) {
    path = path.toLowerCase();
    base = base.toLowerCase();
  }
  return path === base || path.startsWith(base + "/");
}

export async function prepareEditors(
  editors: Pick<CodeReaderHandle, "prepareFileOperation" | "finishFileOperation" | "isDirty">[],
  request: OperationRequest,
) {
  if (!locksEditors(request)) return () => {};
  const discard = ["discardHunk", "discardTracked", "trashUntracked"].includes(request.type);
  const save = !discard && request.type !== "commit" && request.type !== "undoLastCommit";
  const locked: typeof editors = [];
  try {
    for (const editor of editors) {
      locked.push(editor);
      const result = await editor.prepareFileOperation({ save });
      if (result.status !== "saved" && result.status !== "clean")
        throw new Error(result.message ?? tr("请先处理文件保存问题。"));
    }
  } catch (error) {
    locked.forEach((editor) => editor.finishFileOperation());
    throw error;
  }
  return (outcome: OperationOutcome) => {
    locked.forEach((editor) =>
      editor.finishFileOperation({
        reload:
          changesWorktree(request) && (!editor.isDirty() || (discard && outcome === "succeeded")),
      }),
    );
  };
}
