import type { FileContent } from "../../lib/types";

export interface LoadedState {
  content: FileContent;
  revision: number;
}

export type PauseReason = "conflict" | "external" | "error" | null;

export function normalizeDocumentText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
