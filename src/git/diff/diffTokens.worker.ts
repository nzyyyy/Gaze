import type { HunkData } from "react-diff-view";
import { tokenizeDiff } from "./diffTokens";

interface DiffTokensRequest {
  hunks: HunkData[];
  language?: string;
  inlineEdits?: boolean;
}

self.onmessage = (event: MessageEvent<DiffTokensRequest>) => {
  const { hunks, language, inlineEdits } = event.data;
  try {
    self.postMessage({ tokens: tokenizeDiff(hunks, language, inlineEdits) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
