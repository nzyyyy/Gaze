import { t as tr, useLanguage } from "../../lib/i18n";
import { useEffect, useState } from "react";
import type { Project } from "../../lib/types";
import { api, type RepositorySummary, type WorkingTreeSnapshot } from "../api";
import { errorMessage, shortOid } from "../types";

interface ProjectStatus {
  root: string;
  repository?: RepositorySummary;
  snapshot?: WorkingTreeSnapshot;
  error?: string;
}

export function GitProjectList({
  projects,
  selectedProjectId,
  selectedRepository,
  snapshot,
  active,
  onSelect,
}: {
  projects: Project[];
  selectedProjectId?: string;
  selectedRepository?: RepositorySummary;
  snapshot?: WorkingTreeSnapshot;
  active: boolean;
  onSelect: (project: Project) => void;
}) {
  useLanguage();
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const scope = JSON.stringify(projects.map(({ id, root }) => [id, root]));

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | undefined;
    const contexts = new Map<string, RepositorySummary>();
    const versions = new Map<number, number>();
    setStatuses((current) =>
      Object.fromEntries(
        projects
          .filter(({ id, root }) => current[id]?.root === root)
          .map(({ id }) => [id, current[id]!]),
      ),
    );
    const refresh = async (repositoryId?: number) => {
      await Promise.all(
        projects.map(async (project) => {
          if (contexts.has(project.id)) return;
          try {
            const context = await api.context(project.id);
            if (disposed) return;
            if (context.repository) contexts.set(project.id, context.repository);
            else
              setStatuses((current) => ({
                ...current,
                [project.id]: { root: project.root, error: context.error || tr("未初始化 Git") },
              }));
          } catch (cause) {
            if (!disposed)
              setStatuses((current) => ({
                ...current,
                [project.id]: { root: project.root, error: errorMessage(cause) },
              }));
          }
        }),
      );
      if (disposed) return;
      await Promise.all(
        [...new Set([...contexts.values()].map(({ id }) => id))]
          .filter((id) => repositoryId == null || id === repositoryId)
          .map(async (id) => {
            const version = (versions.get(id) ?? 0) + 1;
            versions.set(id, version);
            let status: Omit<ProjectStatus, "root">;
            try {
              const next = await api.refreshRepository(id);
              status = {
                repository: next.summary,
                snapshot: next.snapshot ?? undefined,
                error: next.summary.error || undefined,
              };
              if (next.summary.kind === "workTree" && !next.snapshot)
                status.error = tr("无法读取变更");
            } catch (cause) {
              status = { error: errorMessage(cause) };
            }
            if (disposed || versions.get(id) !== version) return;
            setStatuses((current) => {
              const next = { ...current };
              for (const project of projects)
                if (contexts.get(project.id)?.id === id)
                  next[project.id] = { root: project.root, ...status };
              return next;
            });
          }),
      );
    };
    const pending = new Set<number>();
    let refreshAll = false;
    const schedule = (id?: number) => {
      if (disposed) return;
      if (id != null) pending.add(id);
      else refreshAll = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const ids = [...pending];
        pending.clear();
        if (refreshAll) {
          refreshAll = false;
          void refresh();
        } else for (const repositoryId of ids) void refresh(repositoryId);
      }, 120);
    };
    const focus = () => schedule();
    const unlisten = api.onRepositoryChange(schedule).catch(() => () => {});
    window.addEventListener("focus", focus);
    void refresh();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", focus);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
    // Project membership and roots own requests; names and selection only affect rendering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, active]);

  return (
    <nav className="git-projects" aria-label={tr("Git 项目")}>
      <div className="git-projects-heading">
        {tr("已导入项目")}
        <span>{projects.length}</span>
      </div>
      <ul>
        {projects.map((project) => {
          const status =
            statuses[project.id]?.root === project.root ? statuses[project.id] : undefined;
          const repository =
            status?.repository ??
            (!status && project.id === selectedProjectId ? selectedRepository : undefined);
          const current =
            !status?.error &&
            repository != null &&
            repository.id === selectedRepository?.id &&
            snapshot?.repositoryId === repository.id &&
            snapshot.id >= (status?.snapshot?.id ?? 0);
          const summary = current ? selectedRepository : repository;
          const files = (current ? snapshot?.files : status?.snapshot?.files)?.filter(
            (file) => !file.ignored,
          );
          const changed = !!files?.length;
          const conflict = files?.some((file) => file.conflict);
          const additions = files?.reduce((total, file) => total + (file.additions ?? 0), 0) ?? 0;
          const deletions = files?.reduce((total, file) => total + (file.deletions ?? 0), 0) ?? 0;
          const unknown =
            files?.filter((file) => file.additions == null || file.deletions == null).length ?? 0;
          const error = current ? summary?.error : status?.error;
          return (
            <li key={project.id}>
              <button
                className={`git-project-row${changed ? " has-changes" : ""}${conflict ? " has-conflicts" : ""}`}
                aria-current={project.id === selectedProjectId ? "true" : undefined}
                data-tooltip={tr("{0} · 整个仓库{1}", project.root, error ? ` · ${error}` : "")}
                onClick={() => onSelect(project)}
              >
                <span className="git-project-heading">
                  <strong>{project.name}</strong>
                  {!error && summary && (summary.ahead > 0 || summary.behind > 0) && (
                    <span
                      className="git-sync-counts"
                      data-tooltip={tr("同步数量来自本地跟踪引用；Fetch 后更新。")}
                    >
                      {summary.ahead > 0 && (
                        <span
                          className="git-sync-count has-pending"
                          aria-label={tr("待推送 {0} 个提交", summary.ahead)}
                        >
                          ↑{summary.ahead}
                        </span>
                      )}
                      {summary.behind > 0 && (
                        <span
                          className="git-sync-count has-pending"
                          aria-label={tr("待拉取 {0} 个提交", summary.behind)}
                        >
                          ↓{summary.behind}
                        </span>
                      )}
                    </span>
                  )}
                </span>
                <span className="git-project-branch">
                  {summary?.branch ||
                    (summary?.headOid
                      ? tr("分离 HEAD · {0}", shortOid(summary.headOid))
                      : summary
                        ? tr("尚无提交")
                        : error
                          ? tr("Git 不可用")
                          : tr("正在读取…"))}
                </span>
                {changed && (
                  <span
                    className="git-project-stats"
                    aria-label={tr(
                      "新增 {0} 行，删除 {1} 行{2}",
                      additions,
                      deletions,
                      unknown ? tr("，{0} 个文件无法统计行数", unknown) : "",
                    )}
                  >
                    <span className="git-project-additions">+{additions}</span>
                    <span className="git-project-deletions">−{deletions}</span>
                    {unknown > 0 && (
                      <span data-tooltip={tr("{0} 个文件无法统计行数", unknown)}>*</span>
                    )}
                  </span>
                )}
                <small>
                  {error
                    ? tr("读取失败")
                    : files
                      ? changed
                        ? tr("{0} 个变更{1}", files.length, conflict ? tr(" · 含冲突") : "")
                        : tr("工作区干净")
                      : summary?.kind === "bare"
                        ? tr("裸仓库 · 只读")
                        : ""}
                </small>
              </button>
            </li>
          );
        })}
      </ul>
      {!projects.length && <p className="pane-empty">{tr("请先导入项目。")}</p>}
    </nav>
  );
}
