import { useEffect, useState } from "react";

import { gitApi } from "../../lib/api";

/**
 * The file's committed (HEAD) text, used to paint local changes in the editor.
 * `null` means "show no change markers": not a repository, binary, or unavailable.
 */
export function useFileBase(projectId: string, path: string, active = true): string | null {
  const [base, setBase] = useState<string | null>(null);

  useEffect(() => {
    setBase(null);
  }, [projectId, path]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = await gitApi.getFileBase(projectId, path);
        if (!disposed) setBase(result ? result.content : null);
      } catch {
        // Git decorations are optional; the editor works without them.
        if (!disposed) setBase(null);
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 200);
    };
    void load();
    let stop: (() => void) | undefined;
    try {
      void gitApi
        .onRepositoryChange(schedule)
        .then((unlisten) => {
          if (disposed) unlisten();
          else stop = unlisten;
        })
        .catch(() => undefined);
    } catch {
      // The test environment has no Tauri runtime.
    }
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      stop?.();
    };
  }, [projectId, path, active]);

  return base;
}
