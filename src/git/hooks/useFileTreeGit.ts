import { useLanguage } from "../../lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { gitApi } from "../../lib/api";
import type { Project } from "../../lib/types";
import type { FileChange } from "../models";
import { fileTreeStatus } from "../fileTreeStatus";

interface ProjectStatus {
  root: string;
  prefix: string;
  files: FileChange[];
}

export function useFileTreeGit(projects: Project[], refreshToken: number, active = true) {
  const language = useLanguage();
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const scheduleRef = useRef(() => {});
  const activeRef = useRef(active);
  activeRef.current = active;
  const scope = JSON.stringify(projects.map((project) => [project.id, project.root]));

  useEffect(() => {
    const visible = projects;
    const contexts = new Map<string, { repositoryId: number; prefix: string }>();
    const versions = new Map<number, number>();
    let disposed = false;
    let timer: number | undefined;
    setStatuses((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id, status]) =>
          projects.some((project) => project.id === id && project.root === status.root),
        ),
      ),
    );
    const refresh = async () => {
      await Promise.all(
        visible.map(async (project) => {
          if (contexts.has(project.id)) return;
          try {
            const context = await gitApi.context(project.id);
            if (!disposed && context.repository?.kind === "workTree")
              contexts.set(project.id, {
                repositoryId: context.repository.id,
                prefix: context.projectPrefix,
              });
          } catch {
            /* Git decorations are optional; file browsing remains available. */
          }
          if (!disposed && !contexts.has(project.id))
            setStatuses((current) =>
              Object.fromEntries(Object.entries(current).filter(([id]) => id !== project.id)),
            );
        }),
      );
      if (disposed) return;
      await Promise.all(
        [...new Set([...contexts.values()].map((context) => context.repositoryId))].map(
          async (repositoryId) => {
            const version = (versions.get(repositoryId) ?? 0) + 1;
            versions.set(repositoryId, version);
            try {
              const snapshot = await gitApi.getStatus(repositoryId, false);
              if (disposed || versions.get(repositoryId) !== version) return;
              setStatuses((current) => {
                const next = { ...current };
                for (const project of visible) {
                  const context = contexts.get(project.id);
                  if (context?.repositoryId === repositoryId)
                    next[project.id] = {
                      root: project.root,
                      prefix: context.prefix,
                      files: snapshot.files,
                    };
                }
                return next;
              });
            } catch {
              if (disposed || versions.get(repositoryId) !== version) return;
              const affected = new Set(
                [...contexts]
                  .filter(([, context]) => context.repositoryId === repositoryId)
                  .map(([projectId]) => projectId),
              );
              setStatuses((current) =>
                Object.fromEntries(
                  Object.entries(current).filter(([projectId]) => !affected.has(projectId)),
                ),
              );
              for (const [projectId, context] of contexts)
                if (context.repositoryId === repositoryId) contexts.delete(projectId);
            }
          },
        ),
      );
    };
    const schedule = () => {
      if (disposed || !activeRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refresh();
      }, 120);
    };
    scheduleRef.current = schedule;
    const unlisten = gitApi
      .onRepositoryChange((repositoryId) => {
        if (
          [...contexts.values()].some((context) => context.repositoryId === repositoryId) ||
          contexts.size < visible.length
        )
          schedule();
      })
      .catch(() => () => {});
    window.addEventListener("focus", schedule);
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", schedule);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
    // Project membership and roots own subscriptions; selection and expansion don't clear status.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (refreshToken) scheduleRef.current();
  }, [refreshToken]);

  useEffect(() => {
    if (active) scheduleRef.current();
  }, [active]);

  return useMemo(
    () =>
      new Map(
        projects
          .filter((project) => statuses[project.id]?.root === project.root)
          .map((project) => {
            const status = statuses[project.id]!;
            return [project.id, fileTreeStatus(status.files, status.prefix)] as const;
          }),
      ),
    [projects, statuses, language],
  );
}
