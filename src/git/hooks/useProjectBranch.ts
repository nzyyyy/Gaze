import { t as tr, useLanguage } from "../../lib/i18n";
import { useEffect, useState } from "react";
import { gitApi } from "../../lib/api";
import type { Project } from "../../lib/types";
import { shortOid } from "../types";

export function useProjectBranch(project: Project | null) {
  const language = useLanguage();
  const projectId = project?.id;
  const root = project?.root;
  const [status, setStatus] = useState<{
    projectId: string;
    root: string;
    branch: string | null;
  }>();

  useEffect(() => {
    if (!projectId || !root) return;
    let disposed = false;
    let version = 0;
    let repositoryId: number | undefined;
    const refresh = async () => {
      const request = ++version;
      try {
        const { repository } = await gitApi.context(projectId);
        if (disposed || request !== version) return;
        repositoryId = repository?.id;
        const branch =
          repository?.branch ||
          (repository?.headOid ? tr("分离 HEAD · {0}", shortOid(repository.headOid)) : null);
        setStatus({ projectId, root, branch });
      } catch {
        if (!disposed && request === version) {
          repositoryId = undefined;
          setStatus({ projectId, root, branch: null });
        }
      }
    };
    const focus = () => void refresh();
    const unlisten = gitApi
      .onRepositoryChange((id) => {
        if (repositoryId == null || repositoryId === id) void refresh();
      })
      .catch(() => () => {});
    window.addEventListener("focus", focus);
    void refresh();
    return () => {
      disposed = true;
      window.removeEventListener("focus", focus);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [projectId, root, language]);

  return status?.projectId === projectId && status?.root === root ? (status?.branch ?? null) : null;
}
