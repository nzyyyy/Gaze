import { useCallback, useRef, useState, type RefObject } from "react";

import { t } from "../lib/i18n";
import type { RecentFile } from "../lib/workspace/session";
import type { EditorPane, Project } from "../lib/types";
import { basename, tabKey } from "../lib/utils";
import { paneOf } from "./useEditorPanes";
import type { CodeReaderHandle, EditorTab, RevealRequest } from "./types";

export interface NavigationHistoryEntry {
  projectId: string;
  path: string;
  request?: Omit<RevealRequest, "nonce">;
}

interface UseEditorNavigationOptions {
  tabsRef: RefObject<EditorTab[]>;
  activeKeyRef: RefObject<string | null>;
  activePaneRef: RefObject<EditorPane>;
  splitOpenRef: RefObject<boolean>;
  paneActiveRef: RefObject<Record<EditorPane, string | null>>;
  editorsRef: RefObject<Map<string, CodeReaderHandle>>;
  gitOperationBusyRef: RefObject<boolean>;
  setTabs: (tabs: EditorTab[]) => void;
  setActivePane: (pane: EditorPane) => void;
  setSplitOpen: (open: boolean) => void;
  setPaneActiveKey: (pane: EditorPane, key: string | null) => void;
  isWorkspaceReady: () => boolean;
  resolveProject: (projectId: string) => Project | undefined;
  isTabDirty: (key: string) => boolean;
  notify: (message: string) => void;
  syncActiveProject: (projectId: string) => void;
  leaveGit: () => void;
  clearMarkdownNavigation: () => void;
  setReveal: (request: RevealRequest | null) => void;
}

export function useEditorNavigation({
  tabsRef,
  activeKeyRef,
  activePaneRef,
  splitOpenRef,
  paneActiveRef,
  editorsRef,
  gitOperationBusyRef,
  setTabs,
  setActivePane,
  setSplitOpen,
  setPaneActiveKey,
  isWorkspaceReady,
  resolveProject,
  isTabDirty,
  notify,
  syncActiveProject,
  leaveGit,
  clearMarkdownNavigation,
  setReveal,
}: UseEditorNavigationOptions) {
  const navigationBackRef = useRef<NavigationHistoryEntry[]>([]);
  const navigationForwardRef = useRef<NavigationHistoryEntry[]>([]);
  const [navigationHistory, setNavigationHistory] = useState({ back: 0, forward: 0 });
  const revealNonceRef = useRef(0);

  const syncNavigationHistory = useCallback(() => {
    setNavigationHistory({
      back: navigationBackRef.current.length,
      forward: navigationForwardRef.current.length,
    });
  }, []);

  const currentNavigationEntry = useCallback((): NavigationHistoryEntry | null => {
    const key = activeKeyRef.current;
    const tab = tabsRef.current.find((item) => item.key === key);
    if (!tab) return null;
    const cursor = editorsRef.current.get(tab.key)?.getCursor();
    return {
      projectId: tab.projectId,
      path: tab.path,
      request: cursor
        ? {
            line: cursor.line,
            character: cursor.character,
            endLine: cursor.line,
            endCharacter: cursor.character,
          }
        : undefined,
    };
  }, []);

  const openLocation = useCallback(
    (
      projectId: string,
      path: string,
      request?: Omit<RevealRequest, "nonce">,
      options?: { trackHistory?: boolean; pane?: EditorPane },
    ) => {
      if (gitOperationBusyRef.current) {
        notify(t("Git 操作进行中，请稍候。"));
        return;
      }
      leaveGit();
      if (!isWorkspaceReady()) return;
      const project = resolveProject(projectId);
      if (!project) {
        notify(t("该项目已不在工作区中。"));
        return;
      }
      const existing = tabsRef.current.find(
        (tab) =>
          tab.key === tabKey(projectId, path) ||
          (tab.root &&
            `${tab.root}/${tab.path}`.replaceAll("\\", "/") ===
              `${project.root}/${path}`.replaceAll("\\", "/")),
      );
      const key = existing?.key ?? tabKey(projectId, path);
      const targetPane = options?.pane ?? activePaneRef.current;
      const previousKey = activeKeyRef.current;
      const previousLocation = currentNavigationEntry();
      clearMarkdownNavigation();
      if (!existing) {
        const tab: EditorTab = {
          key,
          projectId,
          projectName: project.name,
          path,
          name: basename(path),
          root: project.root,
          pane: targetPane,
        };
        tabsRef.current = [...tabsRef.current, tab];
        setTabs(tabsRef.current);
      } else if ((existing.pane ?? "primary") !== targetPane) {
        const previousPane = existing.pane ?? "primary";
        tabsRef.current = tabsRef.current.map((tab) =>
          tab.key === key ? { ...tab, pane: targetPane } : tab,
        );
        setTabs(tabsRef.current);
        const remaining = tabsRef.current.filter((tab) => paneOf(tab) === previousPane);
        if (paneActiveRef.current[previousPane] === key)
          setPaneActiveKey(previousPane, remaining[remaining.length - 1]?.key ?? null);
        if (previousPane === "secondary" && remaining.length === 0) {
          splitOpenRef.current = false;
          setSplitOpen(false);
        }
      }
      if (targetPane === "secondary") {
        splitOpenRef.current = true;
        setSplitOpen(true);
      }
      if (previousKey && previousKey !== key && isTabDirty(previousKey)) {
        void editorsRef.current.get(previousKey)?.save();
      }
      if (options?.trackHistory !== false && previousKey && (previousKey !== key || request)) {
        const entry = previousLocation;
        if (entry) {
          const back = navigationBackRef.current;
          if (JSON.stringify(back[back.length - 1]) !== JSON.stringify(entry)) back.push(entry);
          if (back.length > 100) back.shift();
          navigationForwardRef.current = [];
          syncNavigationHistory();
        }
      }
      activePaneRef.current = targetPane;
      setActivePane(targetPane);
      setPaneActiveKey(targetPane, key);
      syncActiveProject(existing?.projectId ?? projectId);
      if (request) {
        setReveal({ ...request, nonce: ++revealNonceRef.current });
      } else {
        setReveal(null);
      }
      return key;
    },
    [
      clearMarkdownNavigation,
      currentNavigationEntry,
      isTabDirty,
      isWorkspaceReady,
      leaveGit,
      notify,
      resolveProject,
      setPaneActiveKey,
      setReveal,
      syncActiveProject,
    ],
  );

  const navigateHistory = useCallback(
    (direction: "back" | "forward") => {
      if (gitOperationBusyRef.current) return;
      const source = direction === "back" ? navigationBackRef : navigationForwardRef;
      const destination = direction === "back" ? navigationForwardRef : navigationBackRef;
      const current = currentNavigationEntry();
      while (source.current.length > 0) {
        const target = source.current.pop()!;
        const key = openLocation(target.projectId, target.path, target.request, {
          trackHistory: false,
        });
        if (!key) continue;
        if (current) {
          destination.current.push(current);
          if (destination.current.length > 100) destination.current.shift();
        }
        break;
      }
      syncNavigationHistory();
    },
    [currentNavigationEntry, openLocation, syncNavigationHistory],
  );

  const moveTabToOtherPane = useCallback(
    (tab: EditorTab) => {
      const target: EditorPane = paneOf(tab) === "primary" ? "secondary" : "primary";
      openLocation(tab.projectId, tab.path, undefined, {
        trackHistory: false,
        pane: target,
      });
    },
    [openLocation],
  );

  const openRecentLocation = useCallback(
    ({ projectId, path, position }: RecentFile) => {
      openLocation(
        projectId,
        path,
        position && {
          ...position,
          endLine: position.line,
          endCharacter: position.character,
        },
      );
    },
    [openLocation],
  );

  const getNavigationEntries = useCallback(
    () => [
      ...[...navigationBackRef.current].reverse(),
      ...[...navigationForwardRef.current].reverse(),
    ],
    [],
  );

  return {
    navigationHistory,
    currentNavigationEntry,
    openLocation,
    navigateHistory,
    moveTabToOtherPane,
    openRecentLocation,
    getNavigationEntries,
  };
}
