import { t } from "./i18n";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { EditorTab } from "../components/CodeReader";
import type { TreeRefresh } from "../components/FileTree";
import { api } from "./api";
import type { FsChangeEvent } from "./types";

const SELF_SAVE_EVENT_WINDOW_MS = 2500;

interface UseFileChangesOptions {
  tabsRef: RefObject<EditorTab[]>;
  activeKeyRef: RefObject<string | null>;
  fileOperationBusyRef: RefObject<boolean>;
  isProjectLocked?: (projectId: string) => boolean;
  isWorkspaceReady: () => boolean;
  isTabDirty: (key: string) => boolean;
  notify: (message: string) => void;
}

export function useFileChanges({
  tabsRef,
  activeKeyRef,
  fileOperationBusyRef,
  isProjectLocked,
  isWorkspaceReady,
  isTabDirty,
  notify,
}: UseFileChangesOptions) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [treeRefresh, setTreeRefresh] = useState<TreeRefresh>({
    token: 0,
    directories: new Map(),
  });
  const [fileRevisions, setFileRevisions] = useState<Record<string, number>>({});
  const [externalChanges, setExternalChanges] = useState<Record<string, number>>({});
  const selfSaveRef = useRef(new Map<string, number>());
  const queuedFsChangesRef = useRef<FsChangeEvent[]>([]);
  const treeDirsRef = useRef(new Map<string, Set<string> | null>());
  const treeFlushRef = useRef<number | null>(null);

  const handleSaved = useCallback((key: string) => {
    selfSaveRef.current.set(key, Date.now());
  }, []);

  const forgetFileState = useCallback((key: string) => {
    selfSaveRef.current.delete(key);
    setExternalChanges((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setFileRevisions((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const refreshFiles = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  const reloadFiles = useCallback((tabs: EditorTab[]) => {
    setFileRevisions((current) => {
      const next = { ...current };
      for (const tab of tabs) next[tab.key] = (next[tab.key] ?? 0) + 1;
      return next;
    });
  }, []);

  const processFsChange = useCallback(
    (event: FsChangeEvent) => {
      if (!isWorkspaceReady()) return;
      refreshFiles();
      let directories = treeDirsRef.current.get(event.projectId);
      if (event.rescan) directories = null;
      else if (directories !== null) {
        directories ??= new Set<string>();
        for (const directory of event.changedDirectories) directories.add(directory);
      }
      treeDirsRef.current.set(event.projectId, directories);
      const snapshot = new Map<string, string[] | null>(
        [...treeDirsRef.current].map(([id, paths]) => [id, paths === null ? null : [...paths]]),
      );
      setTreeRefresh((previous) => ({ token: previous.token + 1, directories: snapshot }));
      if (treeFlushRef.current === null) {
        treeFlushRef.current = window.setTimeout(() => {
          treeFlushRef.current = null;
          treeDirsRef.current.clear();
        }, 0);
      }
      const affectedTabs = tabsRef.current.filter((tab) => {
        if (tab.projectId !== event.projectId) return false;
        if (event.rescan) return true;
        const exact =
          event.changedFiles.includes(tab.path) || event.removedPaths.includes(tab.path);
        const underRemoved = event.removedPaths.some(
          (path) => tab.path === path || tab.path.startsWith(`${path}/`),
        );
        return exact || underRemoved;
      });
      const now = Date.now();
      const actionable = affectedTabs.filter(
        (tab) => now - (selfSaveRef.current.get(tab.key) ?? 0) >= SELF_SAVE_EVENT_WINDOW_MS,
      );
      if (actionable.length > 0) {
        const dirtyTabs = actionable.filter((tab) => isTabDirty(tab.key));
        const cleanTabs = actionable.filter((tab) => !isTabDirty(tab.key));
        if (cleanTabs.length > 0) {
          reloadFiles(cleanTabs);
        }
        if (dirtyTabs.length > 0) {
          setExternalChanges((current) => {
            const next = { ...current };
            for (const tab of dirtyTabs) {
              next[tab.key] = (next[tab.key] ?? 0) + 1;
            }
            return next;
          });
        }
        const active = tabsRef.current.find((tab) => tab.key === activeKeyRef.current);
        if (active) {
          if (
            dirtyTabs.some((tab) => tab.key === active.key) ||
            (cleanTabs.some((tab) => tab.key === active.key) &&
              event.removedPaths.includes(active.path))
          ) {
            notify(
              dirtyTabs.some((tab) => tab.key === active.key)
                ? t("当前文件已在磁盘上修改，未保存的编辑已保留。")
                : t("当前文件已在磁盘上删除。"),
            );
          }
        }
      }
    },
    [activeKeyRef, isWorkspaceReady, isTabDirty, notify, refreshFiles, reloadFiles, tabsRef],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    api
      .onFsChange((event) => {
        if (fileOperationBusyRef.current || isProjectLocked?.(event.projectId))
          queuedFsChangesRef.current.push(event);
        else processFsChange(event);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      if (treeFlushRef.current !== null) window.clearTimeout(treeFlushRef.current);
      treeFlushRef.current = null;
      treeDirsRef.current.clear();
    };
  }, [fileOperationBusyRef, isProjectLocked, processFsChange]);

  const flushFsChanges = useCallback(() => {
    for (const event of queuedFsChangesRef.current.splice(0)) {
      if (fileOperationBusyRef.current || isProjectLocked?.(event.projectId))
        queuedFsChangesRef.current.push(event);
      else processFsChange(event);
    }
  }, [fileOperationBusyRef, isProjectLocked, processFsChange]);

  return {
    refreshToken,
    treeRefresh,
    fileRevisions,
    externalChanges,
    handleSaved,
    forgetFileState,
    refreshFiles,
    reloadFiles,
    flushFsChanges,
  };
}
