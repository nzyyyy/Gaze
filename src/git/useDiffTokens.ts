import { useEffect, useState } from "react";
import type { FileData, HunkTokens } from "react-diff-view";

export function useDiffTokens(file: FileData | undefined, language: string | undefined) {
  const [result, setResult] = useState<{
    file: FileData;
    language: string;
    tokens: HunkTokens;
  } | null>(null);

  useEffect(() => {
    if (!file || !language) return;
    let cancelled = false;
    let worker: Worker | null = null;
    const apply = (tokens: HunkTokens) => {
      if (!cancelled) setResult({ file, language, tokens });
    };
    const fallback = () => {
      void import("./diffTokens").then(
        ({ tokenizeDiff }) => apply(tokenizeDiff(file.hunks, language)),
        () => undefined,
      );
    };

    if (typeof Worker === "undefined") {
      fallback();
    } else {
      try {
        worker = new Worker(new URL("./diffTokens.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<{ tokens?: HunkTokens; error?: string }>) => {
          if (event.data.tokens) apply(event.data.tokens);
          else fallback();
        };
        worker.onerror = fallback;
        worker.postMessage({ hunks: file.hunks, language });
      } catch {
        fallback();
      }
    }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [file, language]);

  return result && result.file === file && result.language === language ? result.tokens : null;
}
