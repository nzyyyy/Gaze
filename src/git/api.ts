import { invoke, listen } from "../lib/ipc";
import type * as Git from "./models";
import type { OperationRequest, SessionLogLine } from "./models";

export const gitApi = {
  onOperationEvent: (handler: (event: Git.OperationEvent) => void) =>
    listen<Git.OperationEvent>("operation-event", (event) => handler(event.payload)),
  onRepositoryChange: (handler: (repositoryId: number) => void) =>
    listen<{ repositoryId: number }>("repository-changed", (event) =>
      handler(event.payload.repositoryId),
    ),
  context: (projectId: string) => invoke<Git.GitContext>("git_context", { projectId }),
  refreshRepository: (repositoryId: number) =>
    invoke<Git.RepositoryRefresh>("refresh_repository", { repositoryId }),
  getStatus: (repositoryId: number, includeIgnored: boolean) =>
    invoke<Git.WorkingTreeSnapshot>("get_status", { repositoryId, includeIgnored }),
  getDiff: (
    repositoryId: number,
    snapshotId: number,
    path: string,
    staged: boolean,
    ignoreWhitespace: boolean,
  ) =>
    invoke<Git.DiffFile>("get_diff", {
      repositoryId,
      snapshotId,
      path,
      staged,
      ignoreWhitespace,
    }),
  getFileBase: (projectId: string, path: string) =>
    invoke<Git.FileBase | null>("get_file_base", { projectId, path }),
  getConflictDocument: (repositoryId: number, snapshotId: number, path: string) =>
    invoke<Git.ConflictDocument>("get_conflict_document", { repositoryId, snapshotId, path }),
  getHistory: (
    repositoryId: number,
    cursor: {
      offset: number;
      activeLanes: string[];
    } | null,
    limit: number,
    branchRef: string | null,
    search: { type: "message"; query: string } | { type: "sha"; query: string } | null,
  ) => invoke<Git.CommitPage>("get_history", { repositoryId, cursor, limit, branchRef, search }),
  exportSessionLog: (fileName: string, lines: SessionLogLine[]) =>
    invoke<boolean>("export_session_log", { fileName, lines }),
  getCommitDetail: (repositoryId: number, oid: string) =>
    invoke<Git.CommitDetail>("get_commit_detail", { repositoryId, oid }),
  getStashDetail: (repositoryId: number, oid: string) =>
    invoke<Git.CommitDetail>("get_stash_detail", { repositoryId, oid }),
  compareBranches: (repositoryId: number, base: string, head: string) =>
    invoke<string>("compare_branches", { repositoryId, base, head }),
  getBranches: (repositoryId: number) => invoke<Git.BranchInfo[]>("get_branches", { repositoryId }),
  getTags: (repositoryId: number) => invoke<Git.TagInfo[]>("get_tags", { repositoryId }),
  getRemotes: (repositoryId: number) => invoke<Git.RemoteInfo[]>("get_remotes", { repositoryId }),
  getStashes: (repositoryId: number) => invoke<Git.StashInfo[]>("get_stashes", { repositoryId }),
  getSubmodules: (repositoryId: number) =>
    invoke<Git.SubmoduleInfo[]>("get_submodules", { repositoryId }),
  getRebaseCommits: (repositoryId: number, onto: string) =>
    invoke<Git.RebaseCommit[]>("get_rebase_commits", { repositoryId, onto }),
  getFileHistory: (repositoryId: number, path: string) =>
    invoke<Git.FileHistoryEntry[]>("get_file_history", { repositoryId, path }),
  getCommitFileDiff: (repositoryId: number, oid: string, path: string) =>
    invoke<string>("get_commit_file_diff", { repositoryId, oid, path }),
  getStashFileDiff: (repositoryId: number, oid: string, path: string) =>
    invoke<string>("get_stash_file_diff", { repositoryId, oid, path }),
  getBlame: (repositoryId: number, path: string) =>
    invoke<Git.BlameFile>("get_blame", { repositoryId, path }),
  previewOperation: (repositoryId: number, request: OperationRequest) =>
    invoke<Git.OperationPreview>("preview_operation", { repositoryId, request }),
  startOperation: (repositoryId: number, request: OperationRequest, confirmed: boolean) =>
    invoke<Git.OperationResult>("start_operation", { repositoryId, request, confirmed }),
  cancelOperation: (operationId: number) => invoke<null>("cancel_operation", { operationId }),
};

export const api = gitApi;
export type * from "./models";
