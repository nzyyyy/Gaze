// Adapted from GitDock; see THIRD_PARTY_NOTICES.md.
/* Types */
export type BlameFile = {
  path: string;
  content: string[];
  hunks: BlameHunk[];
};

export type BlameHunk = {
  oid: string;
  author: string;
  authorTime: number;
  startLine: number;
  lineCount: number;
};

export type Bootstrap = {
  git: GitInfo;
  settings: Settings;
  repositories: RepositorySummary[];
};

export type BranchInfo = {
  committedAt: string | null;
  name: string;
  oid: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
};

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "typeChanged"
  | "unknown";

export type CommitDetail = {
  oid: string;
  author: string;
  email: string;
  authoredAt: string;
  message: string;
  files: CommitFileChange[];
};

export type CommitFileChange = {
  path: string;
  originalPath: string | null;
  additions: number | null;
  deletions: number | null;
};

export type CommitInfo = {
  oid: string;
  parents: string[];
  author: string;
  authoredAt: string;
  subject: string;
  refs: string[];
  lane: GraphLane;
};

export type CommitPage = {
  commits: CommitInfo[];
  nextCursor: HistoryCursor | null;
};

export type ConflictChoice = "current" | "incoming" | "both";

export type ConflictDocument = {
  id: string;
  path: string;
  segments: ConflictSegment[];
};

export type ConflictResolution = {
  blockId: string;
  choice: ConflictChoice;
};

export type ConflictSegment =
  | { type: "context"; text: string }
  | { type: "conflict"; id: string; base: string; current: string; incoming: string };

export type ConflictSide = "ours" | "theirs";

export type DiffFile = {
  path: string;
  staged: boolean;
  binary: boolean;
  tooLarge: boolean;
  patch: string;
  hunks: DiffHunk[];
};

export type DiffHunk = {
  id: string;
  header: string;
  patch: string;
};

export type FileChange = {
  path: string;
  originalPath: string | null;
  kind: ChangeKind;
  indexStatus: string | null;
  worktreeStatus: string | null;
  staged: boolean;
  unstaged: boolean;
  conflict: boolean;
  ignored: boolean;
  additions: number | null;
  deletions: number | null;
};

export type FileHistoryEntry = {
  oid: string;
  author: string;
  authoredAt: string;
  subject: string;
};

export type GitInfo = {
  path: string | null;
  version: string | null;
  supported: boolean;
  error: string | null;
};

export type GraphLane = {
  column: number;
  parentColumns: number[];
};

export type HistoryCursor = {
  offset: number;
  activeLanes: string[];
};

export type HistorySearch = { type: "message"; query: string } | { type: "sha"; query: string };

export type Language = "en" | "zh-CN";

export type MergeMode = "fastForward" | "normal" | "squash";

export type OngoingGitState = {
  kind: OngoingKind;
  canContinue: boolean;
  canSkip: boolean;
  canAbort: boolean;
};

export type OngoingKind = "merge" | "rebase" | "cherryPick" | "revert";

export type OperationEvent = {
  operationId: number;
  repositoryId: number | null;
  kind: OperationEventKind;
  message: string;
  exitCode: number | null;
  outcome: OperationOutcome | null;
};

export type OperationEventKind = "started" | "stdout" | "stderr" | "finished";

export type OperationOutcome = "succeeded" | "failed" | "cancelled";

export type OperationPreview = {
  title: string;
  summary: string;
  risk: RiskLevel;
  affectedPaths: string[];
  affectedRefs: string[];
  recoverable: boolean;
  requiresConfirmation: boolean;
};

export type OperationRequest =
  | { type: "stageFiles"; paths: string[] }
  | { type: "unstageFiles"; paths: string[] }
  | { type: "stageHunk"; snapshotId: number; hunkId: string }
  | { type: "unstageHunk"; snapshotId: number; hunkId: string }
  | { type: "discardHunk"; snapshotId: number; hunkId: string }
  | { type: "discardTracked"; paths: string[] }
  | { type: "trashUntracked"; paths: string[] }
  | { type: "commit"; message: string; amend: boolean; signoff: boolean }
  | { type: "fetch"; remote: string | null; prune: boolean }
  | { type: "pull"; strategy: PullStrategy | null }
  | { type: "push"; remote: string | null; branch: string | null }
  | { type: "forcePushWithLease"; remote: string; branch: string; expectedOid: string }
  | { type: "setUpstream"; remote: string; branch: string }
  | { type: "addRemote"; name: string; url: string }
  | { type: "setRemoteUrl"; name: string; url: string }
  | { type: "removeRemote"; name: string }
  | { type: "deleteRemoteBranch"; remote: string; branch: string }
  | { type: "createBranch"; name: string; startPoint: string | null; checkout: boolean }
  | { type: "switchBranch"; name: string }
  | { type: "renameBranch"; oldName: string; newName: string }
  | { type: "deleteBranch"; name: string; force: boolean }
  | { type: "merge"; reference: string; mode: MergeMode }
  | { type: "rebase"; onto: string }
  | { type: "interactiveRebase"; onto: string; plan: RebaseStep[] }
  | { type: "cherryPick"; commits: string[] }
  | { type: "continue"; kind: OngoingKind }
  | { type: "skip"; kind: OngoingKind }
  | { type: "abort"; kind: OngoingKind }
  | { type: "chooseConflictSide"; path: string; side: ConflictSide }
  | { type: "markResolved"; paths: string[] }
  | {
      type: "resolveConflictBlocks";
      snapshotId: number;
      documentId: string;
      path: string;
      choices: ConflictResolution[];
    }
  | { type: "stashCreate"; message: string | null; includeUntracked: boolean }
  | { type: "stashApply"; index: number; pop: boolean }
  | { type: "stashDrop"; index: number }
  | { type: "createTag"; name: string; target: string | null; message: string | null }
  | { type: "deleteLocalTag"; name: string }
  | { type: "pushTag"; remote: string; name: string }
  | { type: "submoduleInit"; paths: string[]; recursive: boolean }
  | { type: "submoduleUpdate"; paths: string[]; recursive: boolean }
  | { type: "submoduleSync"; paths: string[]; recursive: boolean }
  | { type: "revert"; oid: string }
  | { type: "undoLastCommit" }
  | { type: "runDifftool"; path: string; staged: boolean }
  | { type: "runMergetool"; path: string | null };

export type OperationResult = {
  operationId: number;
  accepted: boolean;
};

export type PullStrategy = "merge" | "rebase" | "fastForwardOnly";

export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export type RebaseCommit = {
  oid: string;
  subject: string;
  author: string;
};

export type RebaseStep = {
  oid: string;
  action: RebaseAction;
  message: string | null;
};

export type RemoteInfo = {
  name: string;
  fetchUrls: string[];
  pushUrls: string[];
};

export type RepositoryCapabilities = {
  canRead: boolean;
  canWriteWorkTree: boolean;
  canManageRefs: boolean;
  canManageRemotes: boolean;
};

export type RepositoryKind = "workTree" | "bare" | "missing";

export type RepositoryOpenTarget = "terminal" | "finder" | "editor";

export type RepositoryPlacement = {
  id: number;
  group: string | null;
  favorite: boolean;
  order: number;
};

export type RepositoryRecord = {
  id: number;
  path: string;
  name: string;
  group: string | null;
  favorite: boolean;
  order: number;
};

export type RepositoryRefresh = {
  summary: RepositorySummary;
  snapshot: WorkingTreeSnapshot | null;
};

export type RepositorySummary = {
  id: number;
  path: string;
  name: string;
  group: string | null;
  favorite: boolean;
  order: number;
  kind: RepositoryKind;
  capabilities: RepositoryCapabilities;
  branch: string | null;
  headOid: string | null;
  changedCount: number;
  conflictCount: number;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  ongoing: OngoingGitState | null;
  error: string | null;
};

export type RiskLevel = "normal" | "caution" | "destructive";

export type SessionLogLine = {
  timestamp: string;
  kind: string;
  message: string;
};

export type Settings = {
  gitPath: string | null;
  editorPath?: string | null;
  selectedRepositoryId: number | null;
  leftWidth: number;
  rightWidth: number;
  outputHeight: number;
  language?: Language;
  groupOrder?: string[];
};

export type StashInfo = {
  index: number;
  oid: string;
  subject: string;
};

export type SubmoduleInfo = {
  path: string;
  oid: string;
  initialized: boolean;
  state: string;
};

export type TagInfo = {
  name: string;
  oid: string;
  subject: string;
};

export type WorkingTreeSnapshot = {
  id: number;
  repositoryId: number;
  headOid: string | null;
  files: FileChange[];
};

export interface GitContext {
  git: GitInfo;
  repository: RepositorySummary | null;
  projectPrefix: string;
  error: string | null;
}

/** A file's text at HEAD, used to decorate the editor with local changes. */
export type FileBase = {
  content: string;
  exists: boolean;
};
