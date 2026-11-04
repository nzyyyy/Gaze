import type { HunkData } from "react-diff-view";
import { tokenizeDiff } from "./diffTokens";

interface DiffTokensRequest {
  hunks: HunkData[];
  language: string;
}

self.onmessage = (event: MessageEvent<DiffTokensRequest>) => {
  const { hunks, language } = event.data;
  try {
    self.postMessage({ tokens: tokenizeDiff(hunks, language) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
