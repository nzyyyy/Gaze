import { computeChangeBlocks } from "./lineDiff";

interface LineDiffRequest {
  id: number;
  base: string;
  current: string;
}

self.onmessage = (event: MessageEvent<LineDiffRequest>) => {
  const { id, base, current } = event.data;
  try {
    self.postMessage({ id, blocks: computeChangeBlocks(base, current) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
