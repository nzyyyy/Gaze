import { useCallback, useRef, useState, type RefObject } from "react";

import { t } from "../lib/i18n";
import type { WorkspaceSession } from "../lib/workspace/session";
import type { EditorPane } from "../lib/types";
import type { CodeReaderHandle, EditorTab } from "./types";

export const paneOf = (tab: EditorTab): EditorPane => tab.pane ?? "primary";

interface UseEditorPanesOptions {
  initialSession: WorkspaceSession;
  fileOperationBusyRef: RefObject<boolean>;
  gitOperationBusyRef: RefObject<boolean>;
  editorsRef: RefObject<Map<string, CodeReaderHandle>>;
  isTabDirty: (key: string) => boolean;
  notify: (message: string) => void;
  syncActiveProject: (projectId: string) => void;
  onPaneActiveChange: (pane: EditorPane) => void;
  clearReveal: () => void;
  leaveGit: () => void;
  openQuickOpen: () => void;
}

export function useEditorPanes({
  initialSession,
  fileOperationBusyRef,
  gitOperationBusyRef,
  editorsRef,
  isTabDirty,
  notify,
  syncActiveProject,
  onPaneActiveChange,
  clearReveal,
  leaveGit,
  openQuickOpen,
}: UseEditorPanesOptions) {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<EditorPane>(initialSession.activePane);
  const [splitOpen, setSplitOpen] = useState(
    initialSession.splitOpen || initialSession.tabs.some((tab) => tab.pane === "secondary"),
  );
  const [paneActive, setPaneActive] = useState<Record<EditorPane, string | null>>({
    primary: null,
    secondary: null,
  });
  const tabsRef = useRef(tabs);
  const activeKeyRef = useRef(activeKey);
  const activePaneRef = useRef(activePane);
  const splitOpenRef = useRef(splitOpen);
  const paneActiveRef = useRef(paneActive);
  tabsRef.current = tabs;
  activeKeyRef.current = activeKey;
  activePaneRef.current = activePane;
  splitOpenRef.current = splitOpen;
  paneActiveRef.current = paneActive;

  const setPaneActiveKey = useCallback(
    (pane: EditorPane, key: string | null) => {
      onPaneActiveChange(pane);
      const next = { ...paneActiveRef.current, [pane]: key };
      paneActiveRef.current = next;
      setPaneActive(next);
      if (activePaneRef.current === pane) {
        activeKeyRef.current = key;
        setActiveKey(key);
      }
    },
    [onPaneActiveChange],
  );

  const activatePane = useCallback(
    (pane: EditorPane) => {
      if (fileOperationBusyRef.current || gitOperationBusyRef.current) return;
      activePaneRef.current = pane;
      setActivePane(pane);
      const key = paneActiveRef.current[pane];
      activeKeyRef.current = key;
      setActiveKey(key);
      clearReveal();
      const tab = tabsRef.current.find((item) => item.key === key);
      if (tab) syncActiveProject(tab.projectId);
    },
    [clearReveal, syncActiveProject],
  );

  const removeTabs = useCallback(
    (closing: EditorTab[]) => {
      const keys = new Set(closing.map((tab) => tab.key));
      if (keys.size === 0) return;
      const current = tabsRef.current;
      const next = current.filter((tab) => !keys.has(tab.key));
      const nextPaneActive = { ...paneActiveRef.current };
      for (const pane of ["primary", "secondary"] as const) {
        const key = nextPaneActive[pane];
        if (!key || !keys.has(key)) continue;
        const paneTabs = current.filter((tab) => paneOf(tab) === pane);
        const index = paneTabs.findIndex((tab) => tab.key === key);
        const remaining = paneTabs.filter((tab) => !keys.has(tab.key));
        nextPaneActive[pane] = remaining[Math.min(index, remaining.length - 1)]?.key ?? null;
      }
      paneActiveRef.current = nextPaneActive;
      setPaneActive(nextPaneActive);

      const collapseSplit =
        splitOpenRef.current &&
        closing.some((tab) => paneOf(tab) === "secondary") &&
        !next.some((tab) => paneOf(tab) === "secondary");
      if (collapseSplit) {
        splitOpenRef.current = false;
        setSplitOpen(false);
        if (activePaneRef.current === "secondary") {
          activePaneRef.current = "primary";
          setActivePane("primary");
        }
      }

      const active = activeKeyRef.current;
      if (active && keys.has(active)) {
        let pane = activePaneRef.current;
        if (!nextPaneActive[pane]) {
          const other = pane === "primary" ? "secondary" : "primary";
          if (nextPaneActive[other]) {
            pane = other;
            activePaneRef.current = other;
            setActivePane(other);
          }
        }
        activeKeyRef.current = nextPaneActive[pane];
        setActiveKey(nextPaneActive[pane]);
        clearReveal();
      }
      tabsRef.current = next;
      setTabs(next);
      return next;
    },
    [clearReveal],
  );

  const toggleSplit = useCallback(() => {
    if (gitOperationBusyRef.current) return;
    if (splitOpenRef.current) {
      const secondary = tabsRef.current.filter((tab) => paneOf(tab) === "secondary");
      const nextPrimary =
        activePaneRef.current === "secondary"
          ? (paneActiveRef.current.secondary ?? paneActiveRef.current.primary)
          : (paneActiveRef.current.primary ?? paneActiveRef.current.secondary);
      if (secondary.length > 0) {
        tabsRef.current = tabsRef.current.map((tab) =>
          paneOf(tab) === "secondary" ? { ...tab, pane: "primary" } : tab,
        );
        setTabs(tabsRef.current);
      }
      const nextPaneActive = { ...paneActiveRef.current, primary: nextPrimary, secondary: null };
      paneActiveRef.current = nextPaneActive;
      setPaneActive(nextPaneActive);
      activePaneRef.current = "primary";
      setActivePane("primary");
      activeKeyRef.current = nextPrimary;
      setActiveKey(nextPrimary);
      splitOpenRef.current = false;
      setSplitOpen(false);
      clearReveal();
      return;
    }
    splitOpenRef.current = true;
    setSplitOpen(true);
    activePaneRef.current = "secondary";
    setActivePane("secondary");
    setPaneActiveKey("secondary", null);
    openQuickOpen();
  }, [clearReveal, openQuickOpen, setPaneActiveKey]);

  const reorderTabs = useCallback((sourceKey: string, targetKey: string, after: boolean) => {
    if (fileOperationBusyRef.current || gitOperationBusyRef.current || sourceKey === targetKey)
      return;
    const current = tabsRef.current;
    const source = current.find((tab) => tab.key === sourceKey);
    const target = current.find((tab) => tab.key === targetKey);
    if (!source || !target || paneOf(source) !== paneOf(target)) return;
    const next = current.filter((tab) => tab.key !== sourceKey);
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const handleActivateTab = useCallback(
    (tab: EditorTab, pane: EditorPane = paneOf(tab)) => {
      if (gitOperationBusyRef.current) {
        notify(t("Git 操作进行中，请稍候。"));
        return;
      }
      const previous = activeKeyRef.current;
      if (previous && previous !== tab.key && isTabDirty(previous)) {
        void editorsRef.current.get(previous)?.save();
      }
      leaveGit();
      activePaneRef.current = pane;
      setActivePane(pane);
      setPaneActiveKey(pane, tab.key);
      clearReveal();
      syncActiveProject(tab.projectId);
    },
    [clearReveal, isTabDirty, leaveGit, notify, setPaneActiveKey, syncActiveProject],
  );

  return {
    tabs,
    activeKey,
    activePane,
    splitOpen,
    paneActive,
    activeTab: tabs.find((tab) => tab.key === activeKey) ?? null,
    tabsRef,
    activeKeyRef,
    activePaneRef,
    splitOpenRef,
    paneActiveRef,
    setTabs,
    setActiveKey,
    setActivePane,
    setSplitOpen,
    setPaneActive,
    setPaneActiveKey,
    activatePane,
    removeTabs,
    toggleSplit,
    reorderTabs,
    handleActivateTab,
  };
}
