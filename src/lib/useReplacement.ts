import { useCallback, useRef, type RefObject } from "react";

import type { CodeReaderHandle, EditorTab } from "../components/CodeReader";
import { api } from "./api";
import type {
  Project,
  ReplaceApplyRequest,
  ReplaceApplyResult,
  ReplacePreview,
  ReplaceTarget,
  SearchOptions,
} from "./types";

interface ReplacementOperation {
  requestId: string;
  query: string;
  replacement: string;
  options: SearchOptions;
  handles: { tab: EditorTab; handle: CodeReaderHandle }[];
  preview: ReplacePreview | null;
  cancelled: boolean;
  applying: boolean;
}

interface UseReplacementOptions {
  editorsRef: RefObject<Map<string, CodeReaderHandle>>;
  tabsRef: RefObject<EditorTab[]>;
  getProjects: () => Project[] | null;
  fileOperationBusyRef: RefObject<boolean>;
  gitOperationBusyRef: RefObject<boolean>;
  closingTabsRef: RefObject<boolean>;
  setOperationBusy: (busy: boolean) => void;
  flushFsChanges: () => void;
}

export function useReplacement({
  editorsRef,
  tabsRef,
  getProjects,
  fileOperationBusyRef,
  gitOperationBusyRef,
  closingTabsRef,
  setOperationBusy,
  flushFsChanges,
}: UseReplacementOptions) {
  const replacementRef = useRef<ReplacementOperation | null>(null);
  const lastReplacementRef = useRef<ReplaceTarget[]>([]);

  const finishReplacement = useCallback(
    (operation: ReplacementOperation, applied = new Set<string>()) => {
      if (replacementRef.current !== operation) return;
      for (const { tab, handle } of operation.handles) {
        handle.finishFileOperation({ reload: applied.has(tab.key) });
      }
      replacementRef.current = null;
      fileOperationBusyRef.current = false;
      gitOperationBusyRef.current = false;
      setOperationBusy(false);
      flushFsChanges();
    },
    [flushFsChanges, setOperationBusy],
  );

  const cancelReplacement = useCallback(() => {
    const operation = replacementRef.current;
    if (!operation || operation.applying) return;
    operation.cancelled = true;
    void api.cancelReplacePreview(operation.requestId).catch(() => undefined);
    if (operation.preview) finishReplacement(operation);
  }, [finishReplacement]);

  const handlePreviewReplace = useCallback(
    async (query: string, replacement: string, options: SearchOptions) => {
      if (fileOperationBusyRef.current || gitOperationBusyRef.current || closingTabsRef.current) {
        throw new Error("文件或 Git 操作进行中，请稍候。");
      }
      const operation: ReplacementOperation = {
        requestId: crypto.randomUUID(),
        query,
        replacement,
        options,
        handles: [],
        preview: null,
        cancelled: false,
        applying: false,
      };
      replacementRef.current = operation;
      fileOperationBusyRef.current = true;
      gitOperationBusyRef.current = true;
      setOperationBusy(true);
      try {
        const projects = getProjects();
        if (!projects) throw new Error("工作区尚未准备好。");
        const root = (projectId: string) =>
          projects.find((project) => project.id === projectId)?.root;
        const absolute = (projectId: string, path: string) => {
          const base = root(projectId);
          return base === undefined
            ? null
            : `${base.replaceAll("\\", "/").replace(/\/$/, "")}/${path}`;
        };
        // Saving a candidate can reveal other candidates; keep locking until the final preview is covered.
        while (true) {
          const preview = await api.previewReplace(
            operation.requestId,
            query,
            replacement,
            options,
          );
          if (operation.cancelled) throw new Error("替换预览已取消。");
          if (preview.truncated || preview.files.length === 0) {
            finishReplacement(operation);
            return preview;
          }
          const paths = new Set(preview.files.map((file) => absolute(file.projectId, file.path)));
          const affected = tabsRef.current.filter(
            (tab) =>
              paths.has(absolute(tab.projectId, tab.path)) &&
              !operation.handles.some((item) => item.tab.key === tab.key),
          );
          if (affected.length === 0) {
            operation.preview = preview;
            return preview;
          }
          for (const tab of affected) {
            const handle = editorsRef.current.get(tab.key);
            if (!handle) throw new Error(`编辑器 ${tab.path} 尚未准备好。`);
            operation.handles.push({ tab, handle });
            const result = await handle.prepareFileOperation();
            if (result.status !== "clean" && result.status !== "saved") {
              throw new Error(result.message ?? `无法保存 ${tab.path}。`);
            }
            if (operation.cancelled) throw new Error("替换预览已取消。");
          }
        }
      } catch (error) {
        finishReplacement(operation);
        throw error;
      }
    },
    [finishReplacement, getProjects],
  );

  const handleApplyReplace = useCallback(
    async (request: ReplaceApplyRequest): Promise<ReplaceApplyResult> => {
      const operation = replacementRef.current;
      if (!operation?.preview || operation.applying) throw new Error("请先生成替换预览。");
      const applied = new Set<string>();
      operation.applying = true;
      try {
        if (
          operation.preview.truncated ||
          request.targets.length === 0 ||
          request.query !== operation.query ||
          request.replacement !== operation.replacement ||
          JSON.stringify(request.options) !== JSON.stringify(operation.options) ||
          request.targets.some(
            (target) =>
              !operation.preview!.files.some(
                (file) =>
                  file.projectId === target.projectId &&
                  file.path === target.path &&
                  JSON.stringify(file.fingerprint) === JSON.stringify(target.fingerprint),
              ),
          )
        )
          throw new Error("替换预览已失效，请重新预览。");
        const result = await api.applyReplace(
          operation.query,
          operation.replacement,
          request.targets,
          operation.options,
        );
        const undoTargets = request.targets.filter((target) =>
          result.outcomes.some(
            (item) =>
              item.status === "applied" &&
              item.projectId === target.projectId &&
              item.path === target.path,
          ),
        );
        if (undoTargets.length > 0) lastReplacementRef.current = undoTargets;
        const projects = getProjects();
        if (projects) {
          const paths = new Set(
            result.outcomes
              .filter((item) => item.status === "applied")
              .map((item) => {
                const project = projects.find((project) => project.id === item.projectId);
                return (
                  project && `${project.root.replaceAll("\\", "/").replace(/\/$/, "")}/${item.path}`
                );
              }),
          );
          for (const { tab } of operation.handles) {
            if (paths.has(`${tab.root?.replaceAll("\\", "/").replace(/\/$/, "")}/${tab.path}`))
              applied.add(tab.key);
          }
        }
        return result;
      } finally {
        finishReplacement(operation, applied);
      }
    },
    [finishReplacement, getProjects],
  );

  const handleUndoReplace = useCallback(async (): Promise<ReplaceApplyResult> => {
    if (fileOperationBusyRef.current || gitOperationBusyRef.current || closingTabsRef.current)
      throw new Error("文件或 Git 操作进行中，请稍候。");
    const targets = lastReplacementRef.current;
    if (targets.length === 0) throw new Error("没有可撤销的替换。");
    fileOperationBusyRef.current = true;
    gitOperationBusyRef.current = true;
    setOperationBusy(true);
    const affected = tabsRef.current.filter((tab) =>
      targets.some((target) => target.projectId === tab.projectId && target.path === tab.path),
    );
    const handles = affected.map((tab) => ({ tab, handle: editorsRef.current.get(tab.key) }));
    const restored = new Set<string>();
    try {
      for (const { tab, handle } of handles) {
        if (!handle) throw new Error(`编辑器 ${tab.path} 尚未准备好。`);
        const result = await handle.prepareFileOperation();
        if (result.status !== "clean" && result.status !== "saved")
          throw new Error(result.message ?? `无法保存 ${tab.path}。`);
      }
      const result = await api.undoReplace();
      for (const { tab } of handles) {
        if (
          result.outcomes.some(
            (item) =>
              item.status === "applied" &&
              item.projectId === tab.projectId &&
              item.path === tab.path,
          )
        )
          restored.add(tab.key);
      }
      lastReplacementRef.current = targets.filter((target) =>
        result.outcomes.some(
          (item) =>
            item.status !== "applied" &&
            item.projectId === target.projectId &&
            item.path === target.path,
        ),
      );
      return result;
    } finally {
      for (const { tab, handle } of handles)
        handle?.finishFileOperation({ reload: restored.has(tab.key) });
      fileOperationBusyRef.current = false;
      gitOperationBusyRef.current = false;
      setOperationBusy(false);
      flushFsChanges();
    }
  }, [flushFsChanges, setOperationBusy]);

  const shouldBlockKeyboard = useCallback(() => {
    const operation = replacementRef.current;
    return !operation || operation.applying;
  }, []);

  return {
    handlePreviewReplace,
    handleApplyReplace,
    handleUndoReplace,
    cancelReplacement,
    shouldBlockKeyboard,
  };
}
