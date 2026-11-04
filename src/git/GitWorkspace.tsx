import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch } from "lucide-react";
import { EditorSplitResizer } from "../components/EditorSplitResizer";
import type { Project } from "../lib/types";
import { api, type FileChange, type GitContext, type RepositorySummary } from "./api";
import { ConflictEditor } from "./ConflictEditor";
import { BranchComparisonView, DiffView } from "./DiffView";
import { I18nProvider } from "./i18n";
import { GitProjectList } from "./components/GitProjectList";
import { MemoBranchesPane } from "./components/BranchesPane";
import { MemoChangesOverview, MemoChangesPane } from "./components/ChangesPane";
import { BlameView } from "./components/BlameView";
import { CommitDetailView } from "./components/CommitDetailView";
import { FileHistoryView } from "./components/FileHistoryView";
import { GitOutputPanel } from "./components/GitOutputPanel";
import { InteractiveRebase } from "./components/InteractiveRebase";
import { MemoHistoryCanvas, MemoHistoryPane } from "./components/HistoryPane";
import { RowMenu } from "./components/RepositoryPane";
import { MemoStashesPane } from "./components/StashesPane";
import { ConfirmDialog, FormDialog } from "./components/dialogs";
import { useHistory } from "./hooks/useHistory";
import { useFileInspection } from "./hooks/useFileInspection";
import { useGitOperations } from "./hooks/useGitOperations";
import { useWorkingTree } from "./hooks/useWorkingTree";
import type { PrepareGitOperation } from "./editorOperations";
import { errorMessage, shortOid, type DialogSpec, type Tab } from "./types";
import "./styles.css";

interface Props {
  project: Project | null;
  projects: Project[];
  sidebarContainer: HTMLElement | null;
  onSelectProject: (project: Project) => void;
  active: boolean;
  preload?: boolean;
  prepareOperation: PrepareGitOperation;
  onOpenFile: (root: string, path: string) => void;
  onOpenTerminal: () => void;
  onNotice?: (message: string) => void;
}

export default function GitWorkspace({
  project,
  projects,
  sidebarContainer,
  onSelectProject,
  active,
  preload = false,
  prepareOperation,
  onOpenFile,
  onOpenTerminal,
  onNotice,
}: Props) {
  const [context, setContext] = useState<{ projectId: string; root: string; value: GitContext }>();
  const contextRequest = useRef<{ key: string; promise: Promise<GitContext> } | undefined>(
    undefined,
  );
  const activationRefresh = useRef<{ id: number; pending: boolean } | undefined>(undefined);
  const enabled = active || preload;
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [tab, setTab] = useState<Tab>("changes");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<DialogSpec>();
  const [rebaseOnto, setRebaseOnto] = useState<string>();
  const contextMatches = context?.projectId === project?.id && context?.root === project?.root;
  const selectedId = contextMatches ? context?.value.repository?.id : undefined;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selected = repositories.find((repository) => repository.id === selectedId);
  const setRepositoriesRef = useRef(setRepositories);
  setRepositoriesRef.current = setRepositories;
  const reportError = useCallback((message: string) => setError(message), []);
  const workingTree = useWorkingTree({
    reportError,
    selectedIdRef,
    selectedId,
    setRepositoriesRef,
  });
  const inspection = useFileInspection({ reportError, selectedId, selectedIdRef });
  const closeDiff = workingTree.closeDiff;
  const closeInspection = inspection.close;
  const reset = useCallback(() => {
    closeDiff();
    closeInspection();
  }, [closeDiff, closeInspection]);
  const history = useHistory({ reportError, selectedIdRef, selectedId, tab, onReset: reset });
  const generation = useRef(0);
  const setSnapshot = workingTree.setSnapshot;
  const reloadOpenDiff = workingTree.reloadOpenDiff;
  const refresh = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id) return;
    const request = ++generation.current;
    try {
      const next = await api.refreshRepository(id);
      if (request !== generation.current || selectedIdRef.current !== id) return;
      setRepositories([next.summary]);
      setSnapshot(next.snapshot ?? undefined);
      if (next.summary.kind === "workTree" && !next.snapshot)
        reportError(next.summary.error || "无法读取变更");
      await reloadOpenDiff(next.snapshot);
    } catch (cause) {
      if (request === generation.current && selectedIdRef.current === id)
        reportError(errorMessage(cause));
    }
  }, [setSnapshot, reportError, reloadOpenDiff]);
  const diffPath = workingTree.diff?.path;
  const prepareWithPath: PrepareGitOperation = useCallback(
    (root, request) => prepareOperation(root, request, diffPath),
    [prepareOperation, diffPath],
  );
  const operations = useGitOperations(
    selected,
    prepareWithPath,
    refresh,
    active ? onNotice : undefined,
  );
  const { run } = operations;
  const errorCount = operations.logs.filter((line) => line.kind === "error").length;

  useEffect(() => {
    if (!active) {
      setDialog(undefined);
      setRebaseOnto(undefined);
      if (operations.pending) operations.cancelPending();
    }
  }, [active, operations.pending]);

  useEffect(() => {
    if (!enabled || !project) return;
    if (
      contextMatches &&
      (!active ||
        (activationRefresh.current?.id === selectedId && activationRefresh.current?.pending))
    )
      return;
    let cancelled = false;
    setError("");
    const key = JSON.stringify([project.id, project.root, retry]);
    if (contextRequest.current?.key !== key)
      contextRequest.current = { key, promise: api.context(project.id) };
    const request = contextRequest.current;
    request.promise
      .then((value) => {
        if (cancelled) return;
        setContext({ projectId: project.id, root: project.root, value });
        setRepositories(value.repository ? [value.repository] : []);
      })
      .catch((cause) => {
        if (!cancelled) reportError(errorMessage(cause));
      })
      .finally(() => {
        if (contextRequest.current === request) contextRequest.current = undefined;
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.root, active, enabled, retry, reportError]);

  useEffect(() => {
    generation.current++;
    activationRefresh.current = undefined;
    setSnapshot(undefined);
    reset();
    setDialog(undefined);
    setRebaseOnto(undefined);
  }, [selectedId, reset, setSnapshot]);

  useEffect(() => {
    if (!enabled || !selectedId) return;
    if (
      activationRefresh.current?.id === selectedId &&
      (!active || activationRefresh.current.pending)
    )
      return;
    const request = { id: selectedId, pending: true };
    activationRefresh.current = request;
    void refresh().finally(() => {
      request.pending = false;
    });
  }, [active, enabled, selectedId, refresh]);

  useEffect(() => {
    if (!active) return;
    const stop = api.onRepositoryChange((id) => {
      if (id === selectedIdRef.current) void refresh();
    });
    return () => {
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [active, refresh]);

  const openFile = useCallback(
    (path: string) => {
      if (selected) onOpenFile(selected.path, path);
    },
    [onOpenFile, selected],
  );
  const showFileHistory = useCallback(
    (path: string) => {
      workingTree.closeDiff();
      void inspection.openFileHistory(path);
    },
    [workingTree.closeDiff, inspection.openFileHistory],
  );
  const showBlame = useCallback(
    (path: string) => {
      workingTree.closeDiff();
      void inspection.openBlame(path);
    },
    [workingTree.closeDiff, inspection.openBlame],
  );
  const openDiff = useCallback(
    (file: FileChange, staged: boolean) => {
      inspection.close();
      void workingTree.openDiff(file, staged);
    },
    [inspection.close, workingTree.openDiff],
  );
  const showDialog = useCallback((spec: DialogSpec) => setDialog(spec), []);
  const forcePush = () => {
    if (!selected?.branch) return;
    const repository = selected;
    showDialog({
      title: "带 lease 的强制推送",
      fields: [{ name: "remote", label: "远程仓库", value: "origin", required: true }],
      onSubmit: async ({ remote }) => {
        const name = String(remote).trim();
        const branches = await api.getBranches(repository.id);
        const expectedOid = branches.find(
          (branch) => branch.remote && branch.name === `${name}/${repository.branch}`,
        )?.oid;
        if (!expectedOid) throw new Error("请先 Fetch，确认远程分支的当前提交。");
        await run({
          type: "forcePushWithLease",
          remote: name,
          branch: repository.branch!,
          expectedOid,
        });
      },
    });
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    reset();
  };
  const {
    diff,
    companionDiff,
    diffSnapshotId,
    conflict,
    commitDetail,
    detailKind,
    selectedCommit,
    branchComparison,
  } = workingTree;
  const canvas =
    inspection.view === "history" && inspection.path ? (
      <FileHistoryView
        path={inspection.path}
        entries={inspection.entries}
        selectedOid={inspection.selectedOid}
        diff={inspection.diff}
        loading={inspection.loading}
        error={inspection.error}
        onBack={inspection.close}
        onSelect={inspection.selectHistoryOid}
      />
    ) : inspection.view === "blame" ? (
      <BlameView
        blame={inspection.blameFile}
        path={inspection.path}
        loading={inspection.loading}
        error={inspection.error}
        onBack={inspection.close}
      />
    ) : conflict ? (
      <ConflictEditor
        key={conflict.id}
        document={conflict}
        onBack={closeDiff}
        onResolve={(choices) =>
          void run(
            {
              type: "resolveConflictBlocks",
              snapshotId: conflict.snapshotId,
              documentId: conflict.id,
              path: conflict.path,
              choices,
            },
            (outcome) => {
              if (outcome === "succeeded") workingTree.setConflict(undefined);
            },
          )
        }
      />
    ) : branchComparison ? (
      <BranchComparisonView comparison={branchComparison} onBack={closeDiff} />
    ) : diff ? (
      <DiffView
        diff={diff}
        companionDiff={companionDiff}
        snapshotId={diffSnapshotId}
        onBack={commitDetail ? workingTree.closeCommitFile : closeDiff}
        onRun={run}
        onHunkSettled={workingTree.reloadOpenDiff}
        fileActions={workingTree.diffIsFile}
        onFileHistory={showFileHistory}
        onBlame={showBlame}
        ignoreWhitespace={workingTree.ignoreWhitespace}
        onToggleWhitespace={workingTree.diffIsFile ? workingTree.toggleWhitespace : undefined}
        caption={commitDetail ? shortOid(commitDetail.oid) : undefined}
      />
    ) : commitDetail ? (
      <CommitDetailView
        detail={commitDetail}
        kind={detailKind}
        onBack={closeDiff}
        onOpenFile={workingTree.openCommitFile}
      />
    ) : tab === "changes" ? (
      <MemoChangesOverview repository={selected} snapshot={workingTree.snapshot} />
    ) : tab === "history" ? (
      <MemoHistoryCanvas
        commits={history.commits}
        selectedOid={selectedCommit}
        onSelect={workingTree.openCommit}
      />
    ) : (
      <div className="canvas-empty">
        <h2>{tab === "branches" ? "分支与引用" : "保存的工作进度"}</h2>
        <p>选择条目查看详情，保留当前文件与编辑器位置。</p>
      </div>
    );

  const sidebar = (
    <section
      className="gaze-git-workspace git-sidebar-workspace"
      aria-label="Git 管理列表"
      hidden={!active}
    >
      <GitProjectList
        projects={projects}
        selectedProjectId={project?.id}
        selectedRepository={selected}
        snapshot={workingTree.snapshot}
        active={active}
        busy={operations.busy}
        onSelect={onSelectProject}
      />
    </section>
  );

  return (
    <I18nProvider language="zh-CN">
      {sidebarContainer && createPortal(sidebar, sidebarContainer)}
      <section className="gaze-git-workspace" aria-label="Git 工作区" hidden={!active}>
        {!project ? (
          <div className="canvas-empty">
            <h2>请先选择项目</h2>
          </div>
        ) : !error &&
          (!contextMatches || (selected?.kind === "workTree" && !workingTree.snapshot)) ? (
          <div className="reader-state" role="status">
            正在加载 Git 工作区…
          </div>
        ) : !selected ? (
          <div className="canvas-empty">
            <h2>Git 暂不可用</h2>
            <p role="status">{error || context?.value.error || "该项目尚未初始化 Git。"}</p>
            <p>可在终端初始化仓库；找不到 Git 时，在配置中设置 tools.git 路径。</p>
            <div>
              <button onClick={onOpenTerminal}>打开终端</button>
              <button onClick={() => setRetry((value) => value + 1)}>重新检测</button>
            </div>
          </div>
        ) : (
          <>
            <header className="git-workspace-header">
              <div>
                <strong>{project.name}</strong>
                <span className="git-workspace-branch">
                  {selected.branch && <GitBranch size={16} strokeWidth={1.75} aria-hidden />}
                  {selected.branch
                    ? selected.branch
                    : selected.headOid
                      ? `分离 HEAD · ${shortOid(selected.headOid)}`
                      : "尚无提交"}
                </span>
                <span data-tooltip="同步数量来自本地跟踪引用；Fetch 后更新。">
                  ↑{selected.ahead} ↓{selected.behind}
                </span>
              </div>
              <div className="git-sync-actions">
                <button
                  disabled={operations.busy}
                  onClick={() => void run({ type: "fetch", remote: null, prune: false })}
                >
                  Fetch
                </button>
                <button
                  disabled={operations.busy || !selected.capabilities.canWriteWorkTree}
                  onClick={() => void run({ type: "pull", strategy: "fastForwardOnly" })}
                >
                  Pull ↓{selected.behind}
                </button>
                <button
                  disabled={operations.busy || !selected.branch}
                  onClick={() => void run({ type: "push", remote: null, branch: null })}
                >
                  Push ↑{selected.ahead}
                </button>
                <button
                  disabled={operations.busy}
                  onClick={() => {
                    setError("");
                    void refresh();
                  }}
                >
                  刷新
                </button>
                <button
                  className="git-output-toggle"
                  aria-expanded={operations.outputOpen}
                  onClick={() => operations.setOutputOpen((value) => !value)}
                >
                  输出
                  {errorCount > 0 && (
                    <span className="git-output-badge" aria-label={`${errorCount} 条错误`}>
                      {errorCount}
                    </span>
                  )}
                </button>
                <RowMenu label="更多 Git 操作" glyph="•••" disabled={operations.busy}>
                  <button disabled={!selected.branch} onClick={forcePush}>
                    带 lease 的强制推送
                  </button>
                  <button onClick={() => void run({ type: "undoLastCommit" })}>
                    撤回上次提交（保留修改）
                  </button>
                  <button onClick={onOpenTerminal}>打开终端</button>
                </RowMenu>
              </div>
            </header>
            <div className="git-repository-path">
              {selected.path} · 整个仓库
              {context?.value.projectPrefix
                ? `（当前项目位于 ${context.value.projectPrefix}）`
                : ""}
              {selected.kind === "bare" ? " · 裸仓库，只读" : ""}
            </div>

            {error && (
              <div className="git-error" role="alert">
                {error}
                <button onClick={() => setError("")}>关闭提示</button>
              </div>
            )}
            {operations.busy && (
              <div className="git-operation-status" role="status">
                Git 操作进行中，相关编辑器已暂停自动保存。
                <button disabled={operations.operationId == null} onClick={operations.cancel}>
                  停止操作
                </button>
              </div>
            )}
            <nav className="git-workflow-nav" aria-label="Git 工作流">
              {(
                [
                  ["changes", "更改"],
                  ["history", "历史"],
                  ["branches", "分支"],
                  ["stashes", "Stash"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={tab === value}
                  disabled={operations.busy}
                  onClick={() => switchTab(value)}
                >
                  {label}
                  {value === "changes" ? ` ${selected.changedCount}` : ""}
                </button>
              ))}
            </nav>
            <fieldset
              className="git-workspace-body"
              disabled={operations.busy || (selected.kind === "bare" && tab !== "history")}
            >
              <legend className="sr-only">
                {tab === "history" ? "仓库历史" : "仓库操作与详情"}
              </legend>

              <aside className="git-details-pane" aria-label="Git 变更与引用列表">
                {tab === "changes" && (
                  <MemoChangesPane
                    repository={selected}
                    snapshot={workingTree.snapshot}
                    onOpen={openDiff}
                    onOpenExternal={openFile}
                    onRun={run}
                    onFileHistory={showFileHistory}
                    onBlame={showBlame}
                  />
                )}
                {tab === "history" && (
                  <MemoHistoryPane
                    search={history.search}
                    onSearch={history.submitSearch}
                    error={history.historyError}
                    branches={history.branches}
                    branchRef={history.branchRef}
                    onBranchChange={history.selectBranch}
                    commits={history.commits}
                    selectedOid={selectedCommit}
                    loading={history.historyLoading}
                    hasMore={history.hasMore}
                    onLoadMore={history.loadMoreHistory}
                    onSelect={workingTree.openCommit}
                    onRun={run}
                  />
                )}
                {tab === "branches" && (
                  <MemoBranchesPane
                    repositoryId={selected.id}
                    onRun={run}
                    onDialog={showDialog}
                    onDiff={workingTree.showBranchDiff}
                    onError={reportError}
                    onInteractiveRebase={setRebaseOnto}
                  />
                )}
                {tab === "stashes" && (
                  <MemoStashesPane
                    repositoryId={selected.id}
                    selectedOid={detailKind === "stash" ? selectedCommit : undefined}
                    onSelect={workingTree.openStash}
                    onRun={run}
                    onDialog={showDialog}
                    onError={reportError}
                  />
                )}
              </aside>
              <EditorSplitResizer
                layoutKey="gitHistorySplitRatio"
                label="调整 Git 列表与详情宽度"
              />
              <section className="canvas">
                {diff && workingTree.diffIsFile && (
                  <div className="git-open-file">
                    <button onClick={() => openFile(diff.path)}>在编辑器打开</button>
                  </div>
                )}
                {canvas}
              </section>
            </fieldset>
            <GitOutputPanel
              open={operations.outputOpen}
              logs={operations.logs}
              status={operations.status}
              onClear={operations.clearLogs}
              onExport={() => void operations.exportLogs()}
              onClose={() => operations.setOutputOpen(false)}
            />
          </>
        )}
        {operations.pending && (
          <ConfirmDialog
            pending={operations.pending}
            onCancel={operations.cancelPending}
            onConfirm={operations.confirmPending}
          />
        )}
        {dialog && <FormDialog spec={dialog} onClose={() => setDialog(undefined)} />}
        {rebaseOnto !== undefined && selectedId && (
          <InteractiveRebase
            repositoryId={selectedId}
            initialOnto={rebaseOnto}
            onClose={() => setRebaseOnto(undefined)}
            onRun={run}
          />
        )}
      </section>
    </I18nProvider>
  );
}
