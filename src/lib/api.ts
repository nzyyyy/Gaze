import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";

import type {
  DirectoryListing,
  DirEntry,
  FileContent,
  FileFingerprint,
  FsChangeEvent,
  ImportResult,
  LineEnding,
  LspStatus,
  NavigationResult,
  OutlineResult,
  PathIndexStatus,
  PathSearchResponse,
  PasteResult,
  OpenFilesResult,
  ReplaceApplyResult,
  ReplacePreview,
  ReplaceTarget,
  SearchEvent,
  SearchOptions,
  SymbolSearchResult,
  TerminalEvent,
  TerminalSessionInfo,
  TextEncodingKind,
  TextPosition,
  ThemePreference,
  ToolCapabilities,
  WorkspaceSnapshot,
  WriteResult,
} from "./types";

export interface RecoveryRecord {
  projectId: string;
  path: string;
  content: string;
  originalFingerprint: FileFingerprint;
  updatedAtMs: number;
}

export interface CompletionEdit {
  from: number;
  to: number;
  insert: string;
}

export interface CodeCompletion {
  label: string;
  detail: string | null;
  documentation: string | null;
  kind: number | null;
  filterText: string | null;
  insertText: string;
  edit: CompletionEdit | null;
  additionalEdits: CompletionEdit[];
}

export interface HoverContent {
  value: string;
  kind: "markdown" | "plaintext";
  language: string | null;
}

export const api = {
  bootstrapWorkspace: () => invoke<WorkspaceSnapshot>("bootstrap_workspace"),
  importProjects: (paths: string[]) => invoke<ImportResult>("import_projects", { paths }),
  removeProject: (projectId: string) => invoke<WorkspaceSnapshot>("remove_project", { projectId }),
  setActiveProject: (projectId: string | null) => invoke<void>("set_active_project", { projectId }),
  setTheme: (theme: ThemePreference) => invoke<void>("set_theme", { theme }),
  saveSettings: (settings: import("./preferences").AppSettings) =>
    invoke<void>("save_settings", { settings }),
  listDirectory: (projectId: string, path: string) =>
    invoke<DirectoryListing>("list_directory", { projectId, path }),
  createEntry: (projectId: string, parentPath: string, name: string, isDir: boolean) =>
    invoke<DirEntry>("create_entry", { projectId, parentPath, name, isDir }),
  moveEntry: (projectId: string, path: string, destinationPath: string) =>
    invoke<DirEntry>("move_entry", { projectId, path, destinationPath }),
  trashEntry: (projectId: string, path: string) => invoke<void>("trash_entry", { projectId, path }),
  hasFileClipboard: () => invoke<boolean>("has_file_clipboard"),
  copyEntry: (projectId: string, path: string) => invoke<void>("copy_entry", { projectId, path }),
  pasteEntries: (projectId: string, parentPath: string) =>
    invoke<PasteResult>("paste_entries", { projectId, parentPath }),
  copyDroppedFiles: (projectId: string, parentPath: string, paths: string[]) =>
    invoke<PasteResult>("copy_dropped_files", { projectId, parentPath, paths }),
  openExternalFiles: (paths: string[]) => invoke<OpenFilesResult>("open_external_files", { paths }),
  closeExternalFile: (projectId: string, path: string) =>
    invoke<void>("close_external_file", { projectId, path }),
  takePendingFiles: () => invoke<string[]>("take_pending_files"),
  onOpenFiles: (handler: () => void): Promise<UnlistenFn> => listen("gaze://open-files", handler),
  onFileDrop: async (handler: (event: DragDropEvent) => void): Promise<UnlistenFn> => {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return getCurrentWebview().onDragDropEvent((event) => handler(event.payload));
  },
  copyEntryPath: (projectId: string, path: string, relative: boolean) =>
    invoke<void>("copy_entry_path", { projectId, path, relative }),
  revealEntry: (projectId: string, path: string) =>
    invoke<void>("reveal_entry", { projectId, path }),
  readFile: (projectId: string, path: string) =>
    invoke<FileContent>("read_file", { projectId, path }),
  readRecovery: (projectId: string, path: string) =>
    invoke<RecoveryRecord | null>("read_recovery", { projectId, path }),
  writeRecovery: (
    projectId: string,
    path: string,
    content: string,
    originalFingerprint: FileFingerprint,
  ) =>
    invoke<RecoveryRecord>("write_recovery", {
      projectId,
      path,
      content,
      originalFingerprint,
    }),
  deleteRecovery: (projectId: string, path: string) =>
    invoke<void>("delete_recovery", { projectId, path }),
  resolveMarkdownLink: (projectId: string, documentPath: string, href: string) =>
    invoke<{ path: string; fragment: string | null }>("resolve_markdown_link", {
      projectId,
      documentPath,
      href,
    }),
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
  writeFile: (
    projectId: string,
    path: string,
    content: string,
    baseFingerprint: FileFingerprint,
    encodingKind: TextEncodingKind,
    lineEnding: LineEnding,
    force: boolean,
  ) =>
    invoke<WriteResult>("write_file", {
      projectId,
      path,
      content,
      baseFingerprint,
      encodingKind,
      lineEnding,
      force,
    }),
  syncDocument: (projectId: string, path: string, content: string) =>
    invoke<void>("sync_document", { projectId, path, content }),
  hoverCode: (projectId: string, path: string, content: string, position: TextPosition) =>
    invoke<HoverContent[]>("hover_code", { projectId, path, content, position }),
  completeCode: (
    projectId: string,
    path: string,
    content: string,
    position: TextPosition,
    trigger: string | null,
  ) =>
    invoke<{ items: CodeCompletion[] }>("complete_code", {
      projectId,
      path,
      content,
      position,
      trigger,
    }),
  getCapabilities: () => invoke<ToolCapabilities>("get_capabilities"),
  searchPaths: (query: string) => invoke<PathSearchResponse>("search_paths", { query }),
  pathIndexStatus: () => invoke<PathIndexStatus[]>("path_index_status"),
  startSearch: (requestId: string, query: string, options: SearchOptions) =>
    invoke<void>("start_search", { requestId, query, options }),
  continueSearch: (requestId: string) => invoke<void>("continue_search", { requestId }),
  cancelSearch: (requestId: string) => invoke<void>("cancel_search", { requestId }),
  previewReplace: (requestId: string, query: string, replacement: string, options: SearchOptions) =>
    invoke<ReplacePreview>("preview_replace", { requestId, query, replacement, options }),
  cancelReplacePreview: (requestId: string) =>
    invoke<void>("cancel_replace_preview", { requestId }),
  applyReplace: (
    query: string,
    replacement: string,
    targets: ReplaceTarget[],
    options: SearchOptions,
  ) => invoke<ReplaceApplyResult>("apply_replace", { query, replacement, targets, options }),
  undoReplace: () => invoke<ReplaceApplyResult>("undo_replace"),
  getOutline: (projectId: string, path: string) =>
    invoke<OutlineResult>("get_outline", { projectId, path }),
  searchSymbols: (projectId: string, query: string) =>
    invoke<SymbolSearchResult>("search_symbols", { projectId, query }),
  findDefinitions: (projectId: string, path: string, position: TextPosition) =>
    invoke<NavigationResult>("find_definitions", { projectId, path, position }),
  findReferences: (projectId: string, path: string, position: TextPosition) =>
    invoke<NavigationResult>("find_references", { projectId, path, position }),
  findImplementations: (projectId: string, path: string, position: TextPosition) =>
    invoke<NavigationResult>("find_implementations", { projectId, path, position }),
  onSearchEvent: (handler: (event: SearchEvent) => void): Promise<UnlistenFn> =>
    listen<SearchEvent>("gaze://search", (event) => handler(event.payload)),
  onFsChange: (handler: (event: FsChangeEvent) => void): Promise<UnlistenFn> =>
    listen<FsChangeEvent>("gaze://fs-change", (event) => handler(event.payload)),
  onPathIndexStatus: (handler: (event: PathIndexStatus) => void): Promise<UnlistenFn> =>
    listen<PathIndexStatus>("gaze://path-index", (event) => handler(event.payload)),
  onLspStatus: (handler: (event: LspStatus) => void): Promise<UnlistenFn> =>
    listen<LspStatus>("gaze://lsp-status", (event) => handler(event.payload)),
  createTerminal: (sessionId: string, projectId: string | null, cols: number, rows: number) =>
    invoke<TerminalSessionInfo>("create_terminal", { sessionId, projectId, cols, rows }),
  writeTerminal: (sessionId: string, data: string) =>
    invoke<void>("write_terminal", { sessionId, data }),
  resizeTerminal: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("resize_terminal", { sessionId, cols, rows }),
  closeTerminal: (sessionId: string) => invoke<void>("close_terminal", { sessionId }),
  onTerminalEvent: (handler: (event: TerminalEvent) => void): Promise<UnlistenFn> =>
    listen<TerminalEvent>("gaze://terminal", (event) => handler(event.payload)),
};

import type * as Git from "../git/models";
import type { OperationRequest, SessionLogLine } from "../git/models";
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
