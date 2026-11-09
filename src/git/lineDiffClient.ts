import { t as tr } from "../lib/i18n";
import { computeChangeBlocks, type ChangeBlock } from "./lineDiff";

interface PendingRequest {
  resolve: (blocks: ChangeBlock[]) => void;
  reject: (reason: Error) => void;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./lineDiff.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (
      event: MessageEvent<{ id: number; blocks?: ChangeBlock[]; error?: string }>,
    ) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.blocks ?? []);
    };
    worker.onerror = () => {
      const error = new Error(tr("Git 变更计算线程失败。"));
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

export function computeChangeBlocksAsync(base: string, current: string): Promise<ChangeBlock[]> {
  const diffWorker = getWorker();
  if (!diffWorker) return Promise.resolve().then(() => computeChangeBlocks(base, current));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    diffWorker.postMessage({ id, base, current });
  });
}
