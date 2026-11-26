import { useEffect, useState } from "react";
import type { HunkData, HunkTokens } from "react-diff-view";

export function useDiffTokens(
  hunks: HunkData[] | undefined,
  language: string | undefined,
  inlineEdits = false,
) {
  const [result, setResult] = useState<{
    hunks: HunkData[];
    language?: string;
    inlineEdits: boolean;
    tokens: HunkTokens;
  } | null>(null);

  useEffect(() => {
    if (!hunks || (!language && !inlineEdits)) return;
    let cancelled = false;
    let worker: Worker | null = null;
    const apply = (tokens: HunkTokens) => {
      if (!cancelled) setResult({ hunks, language, inlineEdits, tokens });
    };
    const fallback = () => {
      void import("./diffTokens")
        .then(({ tokenizeDiff }) => {
          if (!cancelled) apply(tokenizeDiff(hunks, language, inlineEdits));
        })
        .catch(() => undefined);
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
        worker.postMessage({ hunks, language, inlineEdits });
      } catch {
        fallback();
      }
    }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [hunks, language, inlineEdits]);

  return result?.hunks === hunks &&
    result?.language === language &&
    result?.inlineEdits === inlineEdits
    ? result.tokens
    : null;
}

export const languageForPath = (path: string) => {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return (
    {
      ts: "typescript",
      mts: "typescript",
      cts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      mjs: "javascript",
      cjs: "javascript",
      json: "json",
      html: "markup",
      htm: "markup",
      xml: "markup",
      svg: "markup",
      css: "css",
      rs: "rust",
      py: "python",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      md: "markdown",
      markdown: "markdown",
      yaml: "yaml",
      yml: "yaml",
      toml: "ini",
    } as Record<string, string>
  )[extension];
};
