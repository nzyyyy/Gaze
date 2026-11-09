export interface Project {
  id: string;
  name: string;
  root: string;
}

export interface WorkspaceSnapshot {
  language?: import("./i18n").Language;
  projects: Project[];
  activeProjectId: string | null;
  theme: ThemePreference;
  preferences: import("./preferences").Preferences;
  colorSchemes: import("./colorSchemes").ColorSchemes;
  fonts: import("./fonts").FontSettings;
}

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type EditorPane = "primary" | "secondary";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modifiedMs: number | null;
}

export interface DirectoryListing {
  projectId: string;
  path: string;
  entries: DirEntry[];
}

export interface PasteResult {
  entries: DirEntry[];
  failures: { name: string; message: string }[];
}

export interface OpenFilesResult {
  files: { project: Project; path: string; temporary: boolean }[];
  failures: { path: string; message: string }[];
}

export interface FileFingerprint {
  size: number;
  // 纳秒时间戳超过 JS number 的安全整数范围，后端以字符串传输，前端只原样回传。
  modifiedNs: string;
}

export type FileMode = "normal" | "large" | "longLine";
export type TextEncodingKind = "utf8" | "utf8Bom" | "utf16Le" | "utf16Be" | "lossyUtf8";
export type LineEnding = "lf" | "crlf";

interface FileLocation {
  projectId: string;
  path: string;
  fingerprint: FileFingerprint;
  size: number;
}

export interface TextFile extends FileLocation {
  kind: "text";
  content: string;
  encoding: string;
  encodingKind: TextEncodingKind;
  lineEnding: LineEnding;
  mode: FileMode;
  editable: boolean;
  editBlockedReason: string | null;
  warnings: string[];
}

export interface WriteResult {
  fingerprint: FileFingerprint;
  size: number;
}

export interface BinaryFile extends FileLocation {
  kind: "binary";
}

export type FileContent = TextFile | BinaryFile;

export interface ImportFailure {
  path: string;
  message: string;
}

export interface ImportResult {
  projects: Project[];
  failures: ImportFailure[];
}

export interface LspCapability {
  id: string;
  languages: string[];
  available: boolean;
}

export interface ToolCapabilities {
  rgAvailable: boolean;
  ctagsAvailable: boolean;
  ctagsMessage: string | null;
  configMessage: string | null;
  lspServers: LspCapability[];
}

export interface PathSearchHit {
  projectId: string;
  projectName: string;
  path: string;
  score: number;
}

export interface PathSearchResponse {
  hits: PathSearchHit[];
  indexing: boolean;
  message: string | null;
}

export interface PathIndexStatus {
  projectId: string;
  entryCount: number;
  indexing: boolean;
  message: string | null;
}

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextRange {
  start: number;
  end: number;
}

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  includeIgnored: boolean;
  includeHidden: boolean;
  projectIds?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export interface SearchHit {
  projectId: string;
  projectName: string;
  path: string;
  line: number;
  preview: string;
  ranges: TextRange[];
}

export interface ReplacePreviewLine {
  lineNumber: number;
  before: string;
  after: string;
}

export interface ReplaceFilePreview {
  projectId: string;
  path: string;
  fingerprint: FileFingerprint;
  matchCount: number;
  lines: ReplacePreviewLine[];
}

export interface ReplaceSkip {
  path: string;
  reason: string;
}

export interface ReplacePreview {
  files: ReplaceFilePreview[];
  skipped: ReplaceSkip[];
  truncated: boolean;
}

export interface ReplaceTarget {
  projectId: string;
  path: string;
  fingerprint: FileFingerprint;
}

export type ReplaceStatus = "applied" | "skipped" | "conflict" | "error";

export interface ReplaceOutcome {
  projectId: string;
  path: string;
  status: ReplaceStatus;
  matchCount: number;
  message: string | null;
}

export interface ReplaceApplyResult {
  outcomes: ReplaceOutcome[];
}

export interface ReplaceApplyRequest {
  query: string;
  replacement: string;
  targets: ReplaceTarget[];
  options: SearchOptions;
}

export type SearchEvent =
  | {
      type: "batch";
      requestId: string;
      matches: SearchHit[];
      received: number;
    }
  | {
      type: "paused";
      requestId: string;
      received: number;
      hasMore: boolean;
    }
  | {
      type: "done";
      requestId: string;
      received: number;
      truncated: boolean;
    }
  | {
      type: "error";
      requestId: string;
      code: string;
      message: string;
    };

export interface SymbolLocation {
  projectId: string;
  path: string;
  name: string;
  kind: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  source: "ctags" | "lsp";
}

export interface DocumentSymbol {
  name: string;
  detail: string | null;
  kind: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  children: DocumentSymbol[];
}

export interface OutlineResult {
  symbols: DocumentSymbol[];
  source: "ctags" | "lsp";
  message: string | null;
}

export interface NavigationResult {
  locations: SymbolLocation[];
  source: "lsp" | "ctags";
  message: string | null;
}

export interface SymbolSearchResult {
  symbols: SymbolLocation[];
  indexing: boolean;
  message: string | null;
}

export interface LspStatus {
  projectId: string;
  serverId: string;
  state: "starting" | "ready" | "error" | "stopped";
  message: string | null;
}

export interface FsChangeEvent {
  projectId: string;
  rescan?: boolean;
  changedFiles: string[];
  changedDirectories: string[];
  removedPaths: string[];
}

export interface EditorStatus {
  path: string;
  language: string;
  mode: FileMode;
  lines: number;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  autoSavePaused: boolean;
  warnings: string[];
  encoding: string;
}

export interface TerminalSessionInfo {
  sessionId: string;
  projectId: string | null;
  cwd: string;
  shell: string;
}

export interface TerminalEvent {
  sessionId: string;
  kind: "data" | "exit";
  data?: string;
  exitCode?: number;
}
