import type { EditorLanguageAction } from "../lib/editor/editorLanguageTools";
import type { EditorViewState } from "../lib/workspace/session";
import type { EditorPane, PositionEncoding, TextPosition } from "../lib/types";

export interface MarkdownPreviewRequest {
  fragment: string | null;
  nonce: number;
}

export interface EditorTab {
  key: string;
  projectId: string;
  projectName: string;
  path: string;
  name: string;
  root?: string;
  pane?: EditorPane;
}

export interface RevealRequest {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  encoding?: PositionEncoding;
  nonce: number;
}

export interface SaveResult {
  status: "saved" | "clean" | "readonly" | "conflict" | "error";
  message?: string;
}

export interface CodeReaderHandle {
  getCursor(): TextPosition | null;
  getNavigationAnchor(position: TextPosition): { x: number; top: number; bottom: number } | null;
  getViewState(): EditorViewState | null;
  reveal(request: RevealRequest): void;
  openFileSearch(): void;
  dismissPopups(): void;
  runEditorAction(action: EditorLanguageAction): Promise<void> | undefined;
  focus(): void;
  getText(): string | null;
  isDirty(): boolean;
  save(options?: { force?: boolean }): Promise<SaveResult>;
  discardRecovery(): Promise<void>;
  reloadFromDisk(): void;
  prepareFileOperation(options?: { save?: boolean }): Promise<SaveResult>;
  finishFileOperation(options?: { reload?: boolean }): void;
}
