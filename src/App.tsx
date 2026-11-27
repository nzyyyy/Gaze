import { PluginProvider } from "./plugins/runtime";
import { t, useLanguage, setLanguage, DEFAULT_LANGUAGE } from "./lib/i18n";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AlertCircle,
  BookOpen,
  GitBranch,
  FileSearch,
  Files,
  LoaderCircle,
  Monitor,
  Moon,
  RotateCcw,
  Search,
  Settings,
  Sun,
  X,
  Boxes,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { DragDropEvent } from "@tauri-apps/api/webview";

import { CodeReader } from "./components/CodeReader";
import { EditorPaneView } from "./components/EditorPane";
import { WorkspaceStatusBar } from "./components/WorkspaceStatusBar";
import type {
  CodeReaderHandle,
  EditorTab,
  MarkdownPreviewRequest,
  RevealRequest,
} from "./editor/types";
import { FileTree, type FileTreeHandle } from "./components/FileTree";
import {
  operationEntries,
  type FileOperation,
  type FileOperationResult,
  type BatchFileOperationResult,
} from "./components/FileOperationDialog";
import { LocationPicker } from "./components/LocationPicker";
import { QuickOpen, type PaletteAction } from "./components/QuickOpen";
import { ReferencePanel } from "./components/ReferencePanel";
import { SearchPanel } from "./components/SearchPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { SidebarLayout, type SidebarLayoutHandle } from "./components/SidebarLayout";
import { EditorSplitResizer } from "./components/EditorSplitResizer";
import { SymbolPanel } from "./components/SymbolPanel";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { Tooltip } from "./components/Tooltip";
import { UnsavedDialog } from "./components/UnsavedDialog";
import { api } from "./lib/api";
import { DEFAULT_PREFERENCES, type AppSettings, type Preferences } from "./lib/preferences";
import { useNativeMenu, type NativeMenuAction, type NativeMenuState } from "./lib/nativeMenu";
import {
  matchShortcut,
  resolveShortcuts,
  shortcutCommandLabel,
  shortcutFromEvent,
  shortcutLabel,
  type NavigationTarget,
} from "./lib/shortcuts";
import { saveLayout } from "./lib/layout";
import {
  readSession,
  saveSession,
  RECENT_FILE_LIMIT,
  type RecentFile,
  type WorkspaceSession,
} from "./lib/session";
import { colorSchemeVariables, DEFAULT_COLOR_SCHEMES, type ColorSchemes } from "./lib/colorSchemes";
import { DEFAULT_FONT_SETTINGS, fontStack, type FontSettings } from "./lib/fonts";
import { isMarkdownFile, isPythonFile } from "./lib/language";
import type {
  DirEntry,
  EditorPane,
  EditorStatus,
  NavigationResult,
  Project,
  ResolvedTheme,
  SymbolLocation,
  ThemePreference,
  ToolCapabilities,
  TextPosition,
} from "./lib/types";
import type { WorkspaceSnapshot } from "./lib/workspace";
import { paneOf, useEditorPanes } from "./editor/useEditorPanes";
import { useEditorNavigation } from "./editor/useEditorNavigation";
import { basename, errorMessage, normalizePath, parentPath, tabKey } from "./lib/utils";
import { fileDropTarget } from "./lib/fileDrop";
import { useAutoHideScrollbars } from "./lib/useAutoHideScrollbars";
import { useProjectBranch } from "./git/hooks/useProjectBranch";
import type { EditorDiffSnapshot } from "./git/EditorDiff";
import { useReplacement } from "./lib/useReplacement";
import { useFileChanges } from "./lib/useFileChanges";
import "./App.css";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; snapshot: WorkspaceSnapshot }
  | { status: "error"; message: string };

const GitWorkspace = lazy(() => import("./git/GitWorkspace"));
import {
  changesWorktree,
  insideWorktree,
  locksEditors,
  prepareEditors,
  type PrepareGitOperation,
} from "./git/editorOperations";

type WorkspaceCommand =
  | NativeMenuAction
  | "sidebar-files"
  | "sidebar-search"
  | "sidebar-symbols"
  | "copy-file"
  | "paste-file"
  | "delete-file"
  | "new-file"
  | "new-folder"
  | "rename";

type SidebarView = "files" | "search" | "symbols" | "git";

interface ToastState {
  id: number;
  message: string;
}

interface NavigationDialog {
  title: string;
  result: NavigationResult;
  anchor: { x: number; top: number; bottom: number } | null;
  references?: boolean;
}

type PendingAction =
  | { kind: "closeTabs"; tabs: EditorTab[] }
  | { kind: "removeProject"; project: Project }
  | { kind: "quit" };

const THEME_CYCLE: ThemePreference[] = ["system", "light", "dark"];
const noopStatus = () => undefined;

function dialogCopy(action: PendingAction) {
  if (action.kind === "closeTabs") {
    return {
      title:
        action.tabs.length === 1 ? t("关闭 {0}？", action.tabs[0]!.name) : t("关闭这些标签页？"),
      message: t("文件有未保存的修改，且自动保存没有完成。"),
      saveLabel: t("重试保存并关闭"),
      discardLabel: t("放弃修改并关闭"),
    };
  }
  if (action.kind === "removeProject") {
    return {
      title: t("移除项目 {0}？", action.project.name),
      message: t("该项目中有未保存的修改，且自动保存没有完成。"),
      saveLabel: t("重试保存并移除"),
      discardLabel: t("放弃修改并移除"),
    };
  }
  return {
    title: t("退出 Gaze？"),
    message: t("以下文件有未保存的修改，且自动保存没有完成。"),
    saveLabel: t("重试保存并退出"),
    discardLabel: t("放弃修改并退出"),
  };
}

export default function App() {
  const language = useLanguage();
  useAutoHideScrollbars();
  const [initialSession] = useState(readSession);
  const sessionRestoredRef = useRef(false);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const comparisonId = useRef(0);
  const [comparisons, setComparisons] = useState<
    Partial<
      Record<
        EditorPane,
        {
          id: number;
          sourceKey: string;
          snapshot: EditorDiffSnapshot;
          selected: boolean;
        }
      >
    >
  >({});
  const [dropHint, setDropHint] = useState<string | null>(null);
  const temporaryProjectsRef = useRef(new Map<string, Project>());
  const externalReleasesRef = useRef(Promise.resolve());
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [markdownNavigation, setMarkdownNavigation] = useState<{
    key: string;
    request: MarkdownPreviewRequest;
  } | null>(null);
  const [editorStatus, setEditorStatus] = useState<EditorStatus | null>(null);
  const [pythonRevisions, setPythonRevisions] = useState<Record<string, number>>({});
  const refreshPython = useCallback((projectId: string) => {
    setPythonRevisions((current) => ({ ...current, [projectId]: (current[projectId] ?? 0) + 1 }));
  }, []);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [colorSchemes, setColorSchemes] = useState<ColorSchemes>(DEFAULT_COLOR_SCHEMES);
  const [fonts, setFonts] = useState<FontSettings>(DEFAULT_FONT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const settingsBusyRef = useRef(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [menuBusy, setMenuBusy] = useState(false);
  const menuBusyRef = useRef(false);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [capabilities, setCapabilities] = useState<ToolCapabilities | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>("files");
  const sidebarLayoutRef = useRef<SidebarLayoutHandle>(null);
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  const [editorSearch, setEditorSearch] = useState<{ text: string } | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [navigationDialog, setNavigationDialog] = useState<NavigationDialog | null>(null);
  const [referenceResults, setReferenceResults] = useState<NavigationResult | null>(null);
  const [showReferences, setShowReferences] = useState(false);
  const recentFilesRef = useRef(initialSession.recentFiles);
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [symbolRefreshToken, setSymbolRefreshToken] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const gitOpen = sidebarView === "git";
  const [gitSidebar, setGitSidebar] = useState<HTMLDivElement | null>(null);
  const [gitMounted, setGitMounted] = useState(false);
  const [gitPreload, setGitPreload] = useState<{ id: string; root: string } | null>(null);
  const [gitProjectRoots, setGitProjectRoots] = useState<Record<string, string>>({});
  const toastTimer = useRef<number | null>(null);
  const editorsRef = useRef(new Map<string, CodeReaderHandle>());
  const dirtyKeysRef = useRef(new Set<string>());
  const allowCloseRef = useRef(false);
  const fileOperationBusyRef = useRef(false);
  const closingTabsRef = useRef(false);
  const gitOperationBusyRef = useRef(false);
  const gitLockedRootsRef = useRef(new Set<string>());
  const [gitLockedRoots, setGitLockedRoots] = useState<string[]>([]);
  const fileTreeRef = useRef<FileTreeHandle>(null);
  const loadStateRef = useRef(loadState);
  loadStateRef.current = loadState;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const shortcutBindings = useMemo(
    () => resolveShortcuts(preferences.shortcuts),
    [preferences.shortcuts],
  );
  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;
  const overlayGlassActive =
    isMac && loadState.status === "ready" && preferences.windowGlassEnabled;

  const notify = useCallback((message: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message });
    toastTimer.current = window.setTimeout(() => setToast(null), 5200);
  }, []);

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((current) => !current);
  }, []);

  const registerEditor = useCallback((key: string, handle: CodeReaderHandle | null) => {
    if (handle) editorsRef.current.set(key, handle);
    else editorsRef.current.delete(key);
  }, []);

  const syncActiveProject = useCallback((projectId: string) => {
    const current = loadStateRef.current;
    if (
      current.status !== "ready" ||
      current.snapshot.activeProjectId === projectId ||
      !current.snapshot.projects.some((project) => project.id === projectId)
    )
      return;
    const next: LoadState = {
      status: "ready",
      snapshot: { ...current.snapshot, activeProjectId: projectId },
    };
    loadStateRef.current = next;
    setLoadState(next);
    void api.setActiveProject(projectId).catch(() => undefined);
  }, []);

  const handleDirtyChange = useCallback((key: string, isDirty: boolean) => {
    const current = dirtyKeysRef.current;
    if (isDirty === current.has(key)) return;
    if (isDirty) current.add(key);
    else current.delete(key);
    setDirtyKeys(new Set(current));
  }, []);

  const isTabDirty = useCallback((key: string) => {
    const handle = editorsRef.current.get(key);
    return handle ? handle.isDirty() : dirtyKeysRef.current.has(key);
  }, []);

  const onPaneActiveChange = useCallback((pane: EditorPane) => {
    setComparisons((current) => {
      const comparison = current[pane];
      return comparison?.selected
        ? { ...current, [pane]: { ...comparison, selected: false } }
        : current;
    });
  }, []);
  const clearReveal = useCallback(() => setReveal(null), []);
  const leaveGit = useCallback(
    () => setSidebarView((view) => (view === "git" ? "files" : view)),
    [],
  );
  const openQuickOpen = useCallback(() => setQuickOpen(true), []);
  const {
    tabs,
    activeKey,
    activePane,
    splitOpen,
    paneActive,
    activeTab,
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
  } = useEditorPanes({
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
  });
  const isComparing = (pane: EditorPane, key: string | null) =>
    comparisons[pane]?.selected === true && comparisons[pane]?.sourceKey === key;
  const comparisonActive = !gitOpen && isComparing(activePane, activeKey);

  useEffect(() => {
    setComparisons((current) => {
      const missing = (pane: EditorPane) =>
        current[pane] &&
        !tabs.some((tab) => tab.key === current[pane]?.sourceKey && paneOf(tab) === pane);
      if (!missing("primary") && !missing("secondary")) return current;
      const next = { ...current };
      if (missing("primary")) delete next.primary;
      if (missing("secondary")) delete next.secondary;
      return next;
    });
  }, [tabs]);

  const isWorkspaceReady = useCallback(() => loadStateRef.current.status === "ready", []);
  const resolveProject = useCallback((projectId: string) => {
    const current = loadStateRef.current;
    if (current.status !== "ready") return undefined;
    return (
      current.snapshot.projects.find((item) => item.id === projectId) ??
      temporaryProjectsRef.current.get(projectId)
    );
  }, []);
  const clearMarkdownNavigation = useCallback(() => setMarkdownNavigation(null), []);
  const {
    navigationHistory,
    currentNavigationEntry,
    openLocation,
    navigateHistory,
    moveTabToOtherPane,
    openRecentLocation,
    getNavigationEntries,
  } = useEditorNavigation({
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
  });

  const gitBlocksPath = useCallback(
    (path: string) =>
      [...gitLockedRootsRef.current].some(
        (root) => insideWorktree(path, root) || insideWorktree(root, path),
      ),
    [],
  );
  const isGitProjectLocked = useCallback(
    (projectId: string) => {
      const current = loadStateRef.current;
      const project =
        current.status === "ready"
          ? current.snapshot.projects.find((item) => item.id === projectId)
          : undefined;
      return !!project && gitBlocksPath(project.root);
    },
    [gitBlocksPath],
  );
  const {
    refreshToken,
    treeRefresh,
    fileRevisions,
    externalChanges,
    handleSaved,
    forgetFileState,
    refreshFiles,
    reloadFiles,
    flushFsChanges,
  } = useFileChanges({
    tabsRef,
    activeKeyRef,
    fileOperationBusyRef,
    isProjectLocked: isGitProjectLocked,
    isWorkspaceReady,
    isTabDirty,
    notify,
  });

  const forgetTabState = useCallback(
    (key: string) => {
      dirtyKeysRef.current.delete(key);
      setDirtyKeys(new Set(dirtyKeysRef.current));
      forgetFileState(key);
      editorsRef.current.delete(key);
    },
    [forgetFileState],
  );

  const loadWorkspace = useCallback(async () => {
    setLoadState({ status: "loading" });
    try {
      const snapshot = await api.bootstrapWorkspace();
      setLoadState({ status: "ready", snapshot });
      setTheme(snapshot.theme);
      setLanguage(snapshot.language ?? DEFAULT_LANGUAGE);
      setPreferences(snapshot.preferences ?? DEFAULT_PREFERENCES);
      setColorSchemes(snapshot.colorSchemes ?? DEFAULT_COLOR_SCHEMES);
      setFonts(snapshot.fonts);
    } catch (error) {
      setLoadState({ status: "error", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    api
      .getCapabilities()
      .then((result) => {
        setCapabilities(result);
        if (result.configMessage) notify(result.configMessage);
      })
      .catch(() => {
        // Reading remains available when optional tools cannot be inspected.
      });
  }, [notify]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.overlayGlass = overlayGlassActive ? "enabled" : "disabled";
    if (overlayGlassActive) {
      root.style.setProperty(
        "--overlay-glass-opacity",
        `${preferences.windowSurfaceOpacity * 100}%`,
      );
    } else {
      root.style.removeProperty("--overlay-glass-opacity");
    }
    return () => {
      delete root.dataset.overlayGlass;
      root.style.removeProperty("--overlay-glass-opacity");
    };
  }, [overlayGlassActive, preferences.windowSurfaceOpacity]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.colorScheme = colorSchemes[resolvedTheme];
    const variables = colorSchemeVariables(colorSchemes[resolvedTheme], resolvedTheme);
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(variables)) root.style.removeProperty(name);
    };
  }, [colorSchemes, resolvedTheme]);

  useEffect(() => {
    const title = activeTab ? `${activeTab.name} — Gaze` : "Gaze";
    document.title = title;
    void Promise.resolve()
      .then(() => getCurrentWindow().setTitle(title))
      .catch(() => undefined);
  }, [activeTab?.name]);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-ui", fontStack(fonts.ui, "ui"));
    document.documentElement.style.setProperty("--font-mono", fontStack(fonts.editor, "editor"));
  }, [fonts]);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const updateSnapshot = (snapshot: WorkspaceSnapshot) => {
    loadStateRef.current = { status: "ready", snapshot };
    setLoadState({ status: "ready", snapshot });
    if (snapshot.theme !== theme) setTheme(snapshot.theme);
  };

  const updateRecentPositions = useCallback(
    () =>
      recentFilesRef.current.map((file) => ({
        ...file,
        position:
          editorsRef.current.get(tabKey(file.projectId, file.path))?.getCursor() ?? file.position,
      })),
    [],
  );

  const discardTabRecovery = useCallback(
    async (closing: EditorTab[]) => {
      // A clean tab may still hold a crash draft awaiting the user's decision.
      await Promise.all(
        closing
          .filter((tab) => isTabDirty(tab.key))
          .map(async (tab) => {
            try {
              const handle = editorsRef.current.get(tab.key);
              if (handle) await handle.discardRecovery();
              else await api.deleteRecovery(tab.projectId, tab.path);
            } catch {
              // Closing must remain available when best-effort recovery cleanup fails.
            }
          }),
      );
    },
    [isTabDirty],
  );

  const closeTabsForProject = useCallback(
    (projectId: string) => {
      const closing = tabsRef.current.filter((tab) => tab.projectId === projectId);
      const next = removeTabs(closing) ?? tabsRef.current;
      for (const tab of closing) forgetTabState(tab.key);
      for (const tab of closing) {
        if (!next.some((item) => item.projectId === tab.projectId))
          temporaryProjectsRef.current.delete(tab.projectId);
      }
    },
    [forgetTabState, removeTabs],
  );

  const closeTabs = useCallback(
    (closing: EditorTab[]) => {
      recentFilesRef.current = updateRecentPositions();
      const next = removeTabs(closing) ?? tabsRef.current;
      for (const tab of closing) {
        forgetTabState(tab.key);
        if (temporaryProjectsRef.current.has(tab.projectId)) {
          externalReleasesRef.current = externalReleasesRef.current
            .then(() => api.closeExternalFile(tab.projectId, tab.path))
            .catch((error) => notify(errorMessage(error)));
        }
      }
      for (const tab of closing) {
        if (!next.some((item) => item.projectId === tab.projectId))
          temporaryProjectsRef.current.delete(tab.projectId);
      }
    },
    [forgetTabState, notify, removeTabs, updateRecentPositions],
  );

  const handleImport = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: true,
        title: t("导入项目目录"),
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const result = await api.importProjects(paths);
      if (result.failures.length > 0) {
        notify(result.failures[0]?.message ?? t("部分目录未能导入。"));
      }
      const snapshot = await api.bootstrapWorkspace();
      updateSnapshot(snapshot);
      const first = result.projects[0];
      if (first && !snapshot.activeProjectId) {
        await api.setActiveProject(first.id);
        updateSnapshot({ ...snapshot, activeProjectId: first.id });
      }
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [notify]);

  const handleOpenProject = useCallback(
    (project: Project) => {
      if (gitOperationBusyRef.current) {
        notify(t("Git 操作进行中，请稍候。"));
        return;
      }
      if (loadState.status !== "ready" || loadState.snapshot.activeProjectId === project.id) return;
      const next = { ...loadState.snapshot, activeProjectId: project.id };
      updateSnapshot(next);
      api.setActiveProject(project.id).catch((error: unknown) => notify(errorMessage(error)));
    },
    [loadState, notify],
  );

  useEffect(() => {
    if (loadState.status !== "ready" || sessionRestoredRef.current) return;
    const projects = new Set(loadState.snapshot.projects.map((project) => project.id));
    const restored = new Set<string>();
    for (const tab of initialSession.tabs) {
      if (!projects.has(tab.projectId)) continue;
      const key = openLocation(tab.projectId, tab.path, undefined, {
        trackHistory: false,
        pane: tab.pane ?? "primary",
      });
      if (key) restored.add(key);
    }
    for (const pane of ["primary", "secondary"] as const) {
      const active = initialSession.paneActive[pane];
      const tab =
        active &&
        tabsRef.current.find(
          (tab) => tab.key === tabKey(active.projectId, active.path) && paneOf(tab) === pane,
        );
      if (tab) setPaneActiveKey(pane, tab.key);
    }
    const active = initialSession.active;
    if (active && restored.has(tabKey(active.projectId, active.path))) {
      openLocation(active.projectId, active.path, undefined, {
        trackHistory: false,
        pane: active.pane ?? "primary",
      });
    }
    const desiredPane =
      initialSession.splitOpen || initialSession.tabs.some((tab) => tab.pane === "secondary")
        ? initialSession.activePane
        : "primary";
    activePaneRef.current = desiredPane;
    setActivePane(desiredPane);
    activeKeyRef.current = paneActiveRef.current[desiredPane];
    setActiveKey(activeKeyRef.current);
    sessionRestoredRef.current = true;
  }, [loadState.status, initialSession, openLocation, setPaneActiveKey]);

  const persistSession = useCallback(() => {
    if (!sessionRestoredRef.current) return;
    const previous = readSession();
    const tabs = tabsRef.current.filter((tab) => !temporaryProjectsRef.current.has(tab.projectId));
    const active = tabs.find((tab) => tab.key === activeKeyRef.current);
    const current = loadStateRef.current;
    if (current.status !== "ready") return;
    const projectIds = new Set(current.snapshot.projects.map(({ id }) => id));
    let recent = updateRecentPositions().filter((file) => projectIds.has(file.projectId));
    if (active && projectIds.has(active.projectId)) {
      const previous = recent.find((file) => tabKey(file.projectId, file.path) === active.key);
      recent = [
        {
          projectId: active.projectId,
          path: active.path,
          position:
            previous?.position ?? editorsRef.current.get(active.key)?.getCursor() ?? undefined,
        },
        ...recent.filter((file) => tabKey(file.projectId, file.path) !== active.key),
      ].slice(0, RECENT_FILE_LIMIT);
    }
    recentFilesRef.current = recent;
    const paneActive: WorkspaceSession["paneActive"] = { primary: null, secondary: null };
    for (const pane of ["primary", "secondary"] as const) {
      const tab = tabs.find((tab) => tab.key === paneActiveRef.current[pane]);
      if (tab) paneActive[pane] = { projectId: tab.projectId, path: tab.path, pane };
    }
    const views = Object.fromEntries(
      tabs.flatMap((tab) => {
        const view = editorsRef.current.get(tab.key)?.getViewState() ?? previous.views[tab.key];
        return view ? [[tab.key, view]] : [];
      }),
    );
    saveSession({
      tabs: tabs.map((tab) => ({
        projectId: tab.projectId,
        path: tab.path,
        pane: tab.pane ?? "primary",
      })),
      active: active
        ? { projectId: active.projectId, path: active.path, pane: active.pane ?? "primary" }
        : null,
      paneActive,
      activePane: activePaneRef.current,
      splitOpen: splitOpenRef.current,
      views,
      recentFiles: recent,
    });
  }, [updateRecentPositions]);

  useEffect(() => {
    persistSession();
  }, [tabs, activeKey, paneActive, activePane, splitOpen, loadState, persistSession]);

  const handleTreeExpansion = useCallback(
    (openProjects: ReadonlySet<string>, expandedDirectories: ReadonlySet<string>) => {
      saveSession({
        tree: {
          openProjects: [...openProjects],
          expandedDirectories: [...expandedDirectories],
        },
      });
    },
    [],
  );

  const handleExternalFiles = useCallback(
    async (paths: string[], request?: Omit<RevealRequest, "nonce">) => {
      if (!paths.length) return null;
      await externalReleasesRef.current;
      const result = await api.openExternalFiles(paths);
      let openedKey: string | null = null;
      for (const file of result.files) {
        if (file.temporary) temporaryProjectsRef.current.set(file.project.id, file.project);
        openedKey = openLocation(file.project.id, file.path, request) ?? openedKey;
      }
      if (result.failures.length) {
        notify(
          result.failures
            .map((failure) => `${basename(failure.path)}：${failure.message}`)
            .join("\n"),
        );
      }
      return openedKey;
    },
    [openLocation, notify],
  );

  const handleOpenFile = useCallback(
    (project: Project, entry: DirEntry) => {
      sidebarLayoutRef.current?.hidePreview();
      openLocation(project.id, entry.path);
    },
    [openLocation],
  );

  const handleOpenMarkdownFile = useCallback(
    (projectId: string, path: string, fragment: string | null) => {
      if (gitOperationBusyRef.current) {
        notify(t("Git 操作进行中，请稍候。"));
        return;
      }
      const temporary = temporaryProjectsRef.current.get(projectId);
      if (temporary) {
        void handleExternalFiles([`${temporary.root}/${path}`])
          .then((key) => {
            if (key && isMarkdownFile(path)) {
              setMarkdownNavigation({
                key,
                request: { fragment, nonce: Date.now() },
              });
            }
          })
          .catch((error) => notify(errorMessage(error)));
        return;
      }
      openLocation(projectId, path);
      if (isMarkdownFile(path)) {
        setMarkdownNavigation({
          key: tabKey(projectId, path),
          request: { fragment, nonce: Date.now() },
        });
      }
    },
    [openLocation, handleExternalFiles, notify],
  );

  const handleFileOperation = async (
    operation: FileOperation,
    value: string,
  ): Promise<FileOperationResult> => {
    if (gitBlocksPath(operation.project.root)) throw new Error(t("Git 操作进行中，请稍候。"));
    if (fileOperationBusyRef.current || closingTabsRef.current)
      throw new Error(t("文件操作进行中，请稍候。"));
    fileOperationBusyRef.current = true;
    setOperationBusy(true);
    const { project } = operation;
    const root = normalizePath;
    const snapshot = loadStateRef.current.status === "ready" ? loadStateRef.current.snapshot : null;
    const tabRoot = (tab: EditorTab) =>
      root(snapshot?.projects.find((item) => item.id === tab.projectId)?.root ?? tab.root ?? "");
    const entries = operationEntries(operation);
    const sources = entries.map((entry) => `${root(project.root)}/${entry.path}`);
    const absolute = (tab: EditorTab) => `${tabRoot(tab)}/${tab.path}`;
    const affected = tabsRef.current.filter((tab) =>
      sources.some((source) => absolute(tab) === source || absolute(tab).startsWith(source + "/")),
    );
    const handles = affected.map((tab) => editorsRef.current.get(tab.key));
    const batch = "entries" in operation && !!operation.entries;
    const results: BatchFileOperationResult["results"] = [];
    const cursor =
      activeKeyRef.current && affected.some((tab) => tab.key === activeKeyRef.current)
        ? editorsRef.current.get(activeKeyRef.current)?.getCursor()
        : null;
    try {
      if (operation.kind === "rename" || operation.kind === "move") {
        for (const sourceEntry of entries) {
          const parent = operation.kind === "rename" ? parentPath(sourceEntry.path) : value;
          const name = operation.kind === "rename" ? value : sourceEntry.name;
          const destination = `${root(project.root)}/${parent ? parent + "/" : ""}${name}`;
          if (
            tabsRef.current.some(
              (tab) =>
                !affected.includes(tab) &&
                isTabDirty(tab.key) &&
                (absolute(tab) === destination || absolute(tab).startsWith(destination + "/")),
            )
          ) {
            throw new Error(t("目标路径在编辑器中仍有未保存内容，请先保存或关闭该标签。"));
          }
        }
      }
      for (const handle of handles) {
        if (!handle) throw new Error(t("编辑器尚未准备好，请稍后再试。"));
        const result = await handle.prepareFileOperation();
        if (result.status !== "saved" && result.status !== "clean")
          throw new Error(result.message ?? t("无法保存修改，请先处理保存问题。"));
      }
      let entry: DirEntry | undefined;
      if ("parentPath" in operation) {
        entry = await api.createEntry(
          project.id,
          operation.parentPath,
          value,
          operation.kind === "createDirectory",
        );
        if (!entry.isDir) openLocation(project.id, entry.path);
      } else {
        for (const sourceEntry of entries) {
          const source = `${root(project.root)}/${sourceEntry.path}`;
          const affected = tabsRef.current.filter(
            (tab) => absolute(tab) === source || absolute(tab).startsWith(source + "/"),
          );
          try {
            entry = undefined;
            if (operation.kind === "trash") {
              await api.trashEntry(project.id, sourceEntry.path);
            } else {
              const parent = operation.kind === "rename" ? parentPath(sourceEntry.path) : value;
              const name = operation.kind === "rename" ? value : sourceEntry.name;
              entry = await api.moveEntry(
                project.id,
                sourceEntry.path,
                parent ? `${parent}/${name}` : name,
              );
            }
            if (!entry || entry.path !== sourceEntry.path) {
              recentFilesRef.current = recentFilesRef.current.filter((file) => {
                const owner = snapshot?.projects.find(({ id }) => id === file.projectId);
                if (!owner) return false;
                const path = `${root(owner.root)}/${file.path}`;
                return path !== source && !path.startsWith(source + "/");
              });
              saveSession({ recentFiles: recentFilesRef.current });
              const remapped = new Map<string, EditorTab>();
              for (const tab of affected) {
                if (!entry) continue;
                const destination = `${root(project.root)}/${entry.path}${absolute(tab).slice(source.length)}`;
                const keepProject = destination.startsWith(tabRoot(tab) + "/");
                const projectId = keepProject ? tab.projectId : project.id;
                const path = destination.slice(
                  (keepProject ? tabRoot(tab) : root(project.root)).length + 1,
                );
                remapped.set(tab.key, {
                  ...tab,
                  projectId,
                  projectName: keepProject ? tab.projectName : project.name,
                  root: keepProject ? tab.root : project.root,
                  key: tabKey(projectId, path),
                  path,
                  name: basename(path),
                });
              }
              const affectedKeys = new Set(affected.map((tab) => tab.key));
              const next = [
                ...new Map(
                  tabsRef.current.flatMap((tab) => {
                    const replacement = remapped.get(tab.key);
                    return affectedKeys.has(tab.key)
                      ? replacement
                        ? [[replacement.key, replacement] as const]
                        : []
                      : [[tab.key, tab] as const];
                  }),
                ).values(),
              ];
              const previousActive = activeKeyRef.current;
              const nextActive =
                (previousActive && remapped.get(previousActive)?.key) ||
                (next.some((tab) => tab.key === previousActive)
                  ? previousActive
                  : (next[next.length - 1]?.key ?? null));
              const nextPaneActive = { ...paneActiveRef.current };
              for (const [oldKey, tab] of remapped) {
                for (const pane of ["primary", "secondary"] as const) {
                  if (nextPaneActive[pane] === oldKey) nextPaneActive[pane] = tab.key;
                }
              }
              paneActiveRef.current = nextPaneActive;
              flushSync(() => {
                tabsRef.current = next;
                activeKeyRef.current = nextActive;
                setTabs(next);
                setPaneActive(nextPaneActive);
                setActiveKey(nextActive);
                for (const tab of affected) forgetTabState(tab.key);
                reloadFiles([...remapped.values()]);
                setReveal(
                  cursor && entry
                    ? {
                        line: cursor.line,
                        character: cursor.character,
                        endLine: cursor.line,
                        endCharacter: cursor.character,
                        nonce: Date.now(),
                      }
                    : null,
                );
              });
              const nextProjectId = next.find((tab) => tab.key === nextActive)?.projectId;
              if (
                snapshot &&
                nextProjectId &&
                snapshot.activeProjectId !== nextProjectId &&
                snapshot.projects.some((item) => item.id === nextProjectId)
              ) {
                updateSnapshot({ ...snapshot, activeProjectId: nextProjectId });
                void api
                  .setActiveProject(nextProjectId)
                  .catch((error: unknown) => notify(errorMessage(error)));
              }
            }
            results.push({ source: sourceEntry, entry });
          } catch (error) {
            if (!batch) throw error;
            results.push({ source: sourceEntry, error: errorMessage(error) });
          }
        }
      }
      refreshFiles();
      return batch ? { results } : entry;
    } finally {
      for (const handle of handles) handle?.finishFileOperation();
      fileOperationBusyRef.current = false;
      setOperationBusy(false);
      flushFsChanges();
    }
  };

  const getWorkspaceProjects = useCallback(() => {
    const current = loadStateRef.current;
    return current.status === "ready" ? current.snapshot.projects : null;
  }, []);
  const {
    handlePreviewReplace,
    handleApplyReplace,
    handleUndoReplace,
    cancelReplacement,
    shouldBlockKeyboard,
  } = useReplacement({
    editorsRef,
    tabsRef,
    getProjects: getWorkspaceProjects,
    isPathLocked: gitBlocksPath,
    fileOperationBusyRef,
    gitOperationBusyRef,
    closingTabsRef,
    setOperationBusy,
    flushFsChanges,
  });

  const handlePaste = async (project: Project, parent: string, paths?: string[]) => {
    if (gitBlocksPath(`${project.root}/${parent}`)) throw new Error(t("Git 操作进行中，请稍候。"));
    if (fileOperationBusyRef.current || gitOperationBusyRef.current || closingTabsRef.current) {
      throw new Error(t("文件或 Git 操作进行中，请稍候。"));
    }
    fileOperationBusyRef.current = true;
    setOperationBusy(true);
    try {
      const result = paths
        ? await api.copyDroppedFiles(project.id, parent, paths)
        : await api.pasteEntries(project.id, parent);
      if (paths) for (const entry of result.entries) openLocation(project.id, entry.path);
      return result;
    } finally {
      fileOperationBusyRef.current = false;
      setOperationBusy(false);
      refreshFiles();
      flushFsChanges();
    }
  };

  const fileIngressRef = useRef({ handleExternalFiles, blocked: false });
  fileIngressRef.current = {
    handleExternalFiles,
    blocked: Boolean(pendingAction || settingsOpen || quickOpen || navigationDialog),
  };
  const workspaceReady = loadState.status === "ready";
  useEffect(() => {
    if (!workspaceReady) return;
    let disposed = false;
    let target: HTMLElement | null = null;
    let retry: number | undefined;
    let queue = Promise.resolve();
    const stops: (() => void)[] = [];
    const busy = () =>
      fileIngressRef.current.blocked ||
      fileOperationBusyRef.current ||
      gitOperationBusyRef.current ||
      closingTabsRef.current;
    const clear = () => {
      target?.classList.remove("file-drop-target");
      target = null;
      setDropHint(null);
    };
    const enqueue = (action: () => Promise<void>) => {
      queue = queue
        .then(async () => {
          if (!disposed) await action();
        })
        .catch((error) => {
          if (!disposed) notify(errorMessage(error));
        });
    };
    const drain = () => {
      window.clearTimeout(retry);
      enqueue(async () => {
        if (busy()) {
          retry = window.setTimeout(drain, 400);
          return;
        }
        const paths = await api.takePendingFiles();
        if (!disposed) await fileIngressRef.current.handleExternalFiles(paths);
      });
    };
    const onDrop = (event: DragDropEvent) => {
      clear();
      if (event.type === "leave") return;
      if (busy()) {
        if (event.type === "drop") notify(t("文件或 Git 操作进行中，请稍候。"));
        return;
      }
      const current = loadStateRef.current;
      if (current.status !== "ready") return;
      const drop = fileDropTarget(event.position, current.snapshot.activeProjectId);
      if (!drop) return;
      if (event.type !== "drop") {
        target = drop.element;
        target.classList.add("file-drop-target");
        setDropHint(drop.kind === "copy" ? t("复制并打开") : t("打开文件"));
        return;
      }
      enqueue(async () => {
        if (busy()) {
          notify(t("文件或 Git 操作进行中，请稍候。"));
          return;
        }
        if (drop.kind === "open") {
          await fileIngressRef.current.handleExternalFiles(event.paths);
        } else {
          const project = current.snapshot.projects.find((item) => item.id === drop.projectId);
          if (!project) {
            notify(t("请先导入并选择一个项目。"));
            return;
          }
          await fileTreeRef.current?.drop(project, drop.parent, event.paths);
        }
      });
    };
    const keep = (stop: () => void) => {
      if (disposed) stop();
      else stops.push(stop);
    };
    void api
      .onFileDrop(onDrop)
      .then(keep)
      .catch((error) => notify(errorMessage(error)));
    void api
      .onOpenFiles(drain)
      .then((stop) => {
        keep(stop);
        if (!disposed) drain();
      })
      .catch((error) => notify(errorMessage(error)));
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      for (const stop of stops) stop();
      clear();
    };
  }, [workspaceReady, notify]);

  const readPreviewText = useCallback(async (projectId: string, path: string) => {
    const current = loadStateRef.current;
    if (current.status !== "ready" || !current.snapshot.projects.some(({ id }) => id === projectId))
      return null;
    const text = editorsRef.current.get(tabKey(projectId, path))?.getText();
    if (text != null) return text.length <= 2 * 1024 * 1024 ? text : null;
    const file = await api.readFile(projectId, path);
    return file.kind === "text" && file.mode === "normal" ? file.content : null;
  }, []);

  const focusGlobalSearch = useCallback(() => {
    sidebarLayoutRef.current?.open();
    setSidebarView("search");
    setSearchFocusSignal((value) => value + 1);
  }, []);

  const searchSelectedText = useCallback(
    (text: string) => {
      setEditorSearch({ text });
      focusGlobalSearch();
    },
    [focusGlobalSearch],
  );

  const syncActiveDocument = useCallback(async (key = activeKeyRef.current) => {
    if (!key) return;
    const handle = editorsRef.current.get(key);
    if (!handle?.isDirty()) return;
    const tab = tabsRef.current.find((item) => item.key === key);
    const text = handle.getText();
    if (!tab || text == null) return;
    try {
      await api.syncDocument(tab.projectId, tab.path, text);
    } catch {
      // Navigation falls back to the last saved content.
    }
  }, []);

  const selectSidebarView = useCallback(
    (view: SidebarView) => {
      sidebarLayoutRef.current?.open();
      setSidebarView(view);
      if (view === "symbols") {
        void syncActiveDocument().then(() => {
          setSymbolRefreshToken((value) => value + 1);
        });
      }
    },
    [syncActiveDocument],
  );

  const saveActiveTab = useCallback(async () => {
    const key = activeKeyRef.current;
    if (!key) return;
    const tab = tabsRef.current.find((item) => item.key === key);
    const handle = editorsRef.current.get(key);
    if (!tab || !handle) return;
    const result = await handle.save();
    if (result.status === "saved") notify(t("已保存 {0}", tab.name));
    else if (result.status === "readonly") notify(result.message ?? t("当前文件只支持阅读。"));
    else if (result.status === "conflict")
      notify(t("文件已在磁盘上修改，请在编辑器中选择覆盖或重新载入。"));
    else if (result.status === "error") notify(result.message ?? t("保存失败。"));
  }, [notify]);

  const openNavigationLocation = useCallback(
    (location: SymbolLocation) => {
      const request = {
        line: location.line,
        character: location.character,
        endLine: location.endLine,
        endCharacter: location.endCharacter,
        encoding: location.externalEncoding,
      };
      if (location.externalEncoding) {
        void handleExternalFiles([location.path], request).catch((error) =>
          notify(errorMessage(error)),
        );
      } else {
        openLocation(location.projectId, location.path, request);
      }
    },
    [handleExternalFiles, notify, openLocation],
  );

  const runNavigation = useCallback(
    async (
      kind: "definition" | "references" | "implementation",
      target?: { key: string; position: TextPosition; result?: NavigationResult },
    ) => {
      if (
        navigationBusy ||
        fileOperationBusyRef.current ||
        gitOperationBusyRef.current ||
        closingTabsRef.current
      )
        return;
      const tab = target ? tabsRef.current.find((tab) => tab.key === target.key) : activeTab;
      if (!tab) {
        notify(t("请先打开一个文件。"));
        return;
      }
      const position = target?.position ?? editorsRef.current.get(tab.key)?.getCursor();
      if (!position) {
        notify(t("代码视图尚未准备好。"));
        return;
      }
      const anchor = editorsRef.current.get(tab.key)?.getNavigationAnchor?.(position) ?? null;
      editorsRef.current.get(tab.key)?.dismissPopups();
      setNavigationBusy(true);
      try {
        if (!target?.result) await syncActiveDocument(tab.key);
        let result =
          target?.result ??
          (kind === "definition"
            ? await api.findDefinitions(tab.projectId, tab.path, position)
            : kind === "references"
              ? await api.findReferences(tab.projectId, tab.path, position)
              : await api.findImplementations(tab.projectId, tab.path, position));
        // ⌘B / ⌘Click on a declaration's own name shows its usages instead of
        // jumping to the declaration itself (IDEA behavior). The definition
        // points at the same file and line as the cursor when the symbol is
        // declared here.
        if (kind === "definition" && result.source === "lsp" && result.locations.length === 1) {
          const loc = result.locations[0]!;
          if (
            loc.path === tab.path &&
            loc.line === position.line &&
            Math.abs(loc.character - position.character) <= (loc.name?.length || 1)
          ) {
            // The cursor is on the declaration itself: show usages (excluding
            // the declaration, matching IDEA's Show Usages behavior).
            result = await api.findReferences(tab.projectId, tab.path, position, false);
            if (result.locations.length > 0) {
              setNavigationDialog({ title: t("引用"), result, anchor, references: true });
            } else {
              notify(t("没有找到引用。"));
            }
            return;
          }
        }
        const title =
          kind === "definition" ? t("定义") : kind === "references" ? t("引用") : t("实现");
        if (
          kind !== "references" &&
          result.source === "lsp" &&
          result.locations.length === 1 &&
          !result.locations[0]?.externalEncoding &&
          !result.message
        ) {
          openNavigationLocation(result.locations[0]!);
          return;
        }
        setNavigationDialog({ title, result, anchor, references: kind === "references" });
      } catch (error) {
        notify(errorMessage(error));
      } finally {
        setNavigationBusy(false);
      }
    },
    [activeTab, navigationBusy, notify, openNavigationLocation, syncActiveDocument],
  );

  const performRemoveProject = useCallback(
    async (project: Project) => {
      await discardTabRecovery(tabsRef.current.filter((tab) => tab.projectId === project.id));
      closeTabsForProject(project.id);
      try {
        const snapshot = await api.removeProject(project.id);
        updateSnapshot(snapshot);
      } catch (error) {
        notify(errorMessage(error));
      }
    },
    [closeTabsForProject, discardTabRecovery, notify],
  );

  const handleRemoveProject = useCallback(
    (project: Project) => {
      if (fileOperationBusyRef.current || closingTabsRef.current) {
        notify(t("文件操作进行中，请稍候。"));
        return;
      }
      if (gitOperationBusyRef.current || gitBlocksPath(project.root)) {
        notify(t("Git 操作进行中，请稍候。"));
        return;
      }
      const dirtyTabs = tabsRef.current.filter(
        (tab) => tab.projectId === project.id && isTabDirty(tab.key),
      );
      if (dirtyTabs.length === 0) {
        void performRemoveProject(project);
        return;
      }
      void (async () => {
        for (const tab of dirtyTabs) {
          const result = await editorsRef.current.get(tab.key)?.save();
          if (!result || (result.status !== "saved" && result.status !== "clean")) {
            setActiveKey(tab.key);
            setReveal(null);
            setDialogError(result?.message ?? t("无法保存 {0}。", tab.path));
            setPendingAction({ kind: "removeProject", project });
            return;
          }
        }
        await performRemoveProject(project);
      })();
    },
    [performRemoveProject, gitBlocksPath],
  );

  const openEditorComparison = (tab: EditorTab, snapshot: EditorDiffSnapshot) => {
    const pane = paneOf(tab);
    const id = ++comparisonId.current;
    setComparisons((current) => ({
      ...current,
      [pane]: { id, sourceKey: tab.key, snapshot, selected: true },
    }));
  };

  const closeEditorComparison = (pane: EditorPane) => {
    const key = comparisons[pane]?.sourceKey;
    const restoreFocus = key && isComparing(pane, paneActive[pane]);
    setComparisons((current) => ({ ...current, [pane]: undefined }));
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (activeKeyRef.current === key) editorsRef.current.get(key)?.focus();
      });
    }
  };

  const handleCloseTabs = useCallback(
    async (requested: EditorTab[]) => {
      if (closingTabsRef.current) return;
      if (gitOperationBusyRef.current || fileOperationBusyRef.current) {
        notify(t("文件或 Git 操作进行中，请稍候。"));
        return;
      }
      const keys = new Set(requested.map((tab) => tab.key));
      const closing = tabsRef.current.filter((tab) => keys.has(tab.key));
      if (!closing.length) return;
      if (closing.some((tab) => isGitProjectLocked(tab.projectId))) {
        notify(t("Git 操作进行中，请稍候。"));
        return;
      }
      closingTabsRef.current = true;
      setOperationBusy(true);
      let saving: EditorTab | undefined;
      const handles: CodeReaderHandle[] = [];
      try {
        for (const tab of closing) {
          saving = tab;
          const handle = editorsRef.current.get(tab.key);
          if (!handle && !isTabDirty(tab.key)) continue;
          if (handle) handles.push(handle);
          const result = await handle?.prepareFileOperation();
          if (result?.status !== "saved" && result?.status !== "clean") {
            throw new Error(result?.message ?? t("无法保存 {0}。", tab.path));
          }
        }
        await discardTabRecovery(closing);
        setPendingAction(null);
        setDialogError(null);
        closeTabs(closing);
      } catch (error) {
        if (saving) setActiveKey(saving.key);
        setReveal(null);
        setDialogError(errorMessage(error));
        setPendingAction({ kind: "closeTabs", tabs: closing });
      } finally {
        for (const handle of handles) handle.finishFileOperation();
        closingTabsRef.current = false;
        setOperationBusy(false);
      }
    },
    [closeTabs, discardTabRecovery, isTabDirty, isGitProjectLocked, notify],
  );

  const handleCloseTab = useCallback(
    (tab: EditorTab) => {
      void handleCloseTabs([tab]);
    },
    [handleCloseTabs],
  );

  const dirtyTabsForAction = useCallback(
    (action: PendingAction): EditorTab[] => {
      if (action.kind === "closeTabs") {
        const keys = new Set(action.tabs.map((tab) => tab.key));
        return tabsRef.current.filter((tab) => keys.has(tab.key) && isTabDirty(tab.key));
      }
      if (action.kind === "removeProject") {
        return tabsRef.current.filter(
          (tab) => tab.projectId === action.project.id && isTabDirty(tab.key),
        );
      }
      return tabsRef.current.filter((tab) => isTabDirty(tab.key));
    },
    [isTabDirty],
  );

  const closeWindow = useCallback(async () => {
    try {
      allowCloseRef.current = true;
      await getCurrentWindow().close();
    } catch {
      allowCloseRef.current = false;
      // The browser preview has no native window to close.
    }
  }, []);

  const completePendingAction = useCallback(
    async (action: PendingAction) => {
      setPendingAction(null);
      setDialogError(null);
      if (action.kind === "closeTabs") {
        await discardTabRecovery(action.tabs);
        closeTabs(action.tabs);
      } else if (action.kind === "removeProject") await performRemoveProject(action.project);
      else {
        await discardTabRecovery(tabsRef.current);
        await closeWindow();
      }
    },
    [closeTabs, closeWindow, discardTabRecovery, performRemoveProject],
  );

  const handleDialogSave = useCallback(async () => {
    const action = pendingAction;
    if (!action) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      if (action.kind === "closeTabs") {
        await handleCloseTabs(action.tabs);
        return;
      }
      for (const tab of dirtyTabsForAction(action)) {
        const handle = editorsRef.current.get(tab.key);
        if (!handle) {
          setDialogError(t("无法保存 {0}。", tab.path));
          return;
        }
        const result = await handle.save();
        if (result.status !== "saved" && result.status !== "clean") {
          setDialogError(result.message ?? t("无法保存 {0}。", tab.path));
          return;
        }
      }
      await completePendingAction(action);
    } catch (error) {
      setDialogError(errorMessage(error));
    } finally {
      setDialogBusy(false);
    }
  }, [completePendingAction, dirtyTabsForAction, handleCloseTabs, pendingAction]);

  const handleDialogDiscard = useCallback(() => {
    if (!pendingAction) return;
    void completePendingAction(pendingAction);
  }, [completePendingAction, pendingAction]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const release = await getCurrentWindow().onCloseRequested((event) => {
        persistSession();
        if (
          fileOperationBusyRef.current ||
          closingTabsRef.current ||
          gitLockedRootsRef.current.size > 0
        ) {
          event.preventDefault();
          return;
        }
        if (allowCloseRef.current) return;
        const dirtyKeys = tabsRef.current
          .filter((tab) => isTabDirty(tab.key))
          .map((tab) => tab.key);
        if (dirtyKeys.length === 0) return;
        event.preventDefault();
        void (async () => {
          for (const key of dirtyKeys) {
            const handle = editorsRef.current.get(key);
            const result = await handle?.save();
            if (!result || (result.status !== "saved" && result.status !== "clean")) {
              setActiveKey(key);
              setReveal(null);
              setDialogError(result?.message ?? t("有文件无法保存。"));
              setPendingAction({ kind: "quit" });
              return;
            }
          }
          await closeWindow();
        })();
      });
      if (disposed) release();
      else unlisten = release;
    })().catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [closeWindow, isTabDirty, persistSession]);

  useEffect(() => {
    const handleBlur = () => {
      persistSession();
      if (!preferences.autoSave || fileOperationBusyRef.current || closingTabsRef.current) return;
      for (const tab of tabsRef.current) {
        if (!isTabDirty(tab.key)) continue;
        void editorsRef.current.get(tab.key)?.save();
      }
    };
    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [isTabDirty, preferences.autoSave, persistSession]);

  const persistSettings = useCallback(async (next: AppSettings) => {
    if (settingsBusyRef.current) throw new Error(t("设置正在保存，请稍候。"));
    settingsBusyRef.current = true;
    setSettingsBusy(true);
    try {
      await api.saveSettings(next);
      setLanguage(next.language);
      setFonts(next.fonts);
      setColorSchemes(next.colorSchemes);
      setTheme(next.theme);
      setPreferences(next.preferences);
    } finally {
      settingsBusyRef.current = false;
      setSettingsBusy(false);
    }
  }, []);

  const changeTheme = useCallback(async (next: ThemePreference) => {
    if (settingsBusyRef.current) return;
    settingsBusyRef.current = true;
    setSettingsBusy(true);
    try {
      await api.setTheme(next);
      setTheme(next);
    } finally {
      settingsBusyRef.current = false;
      setSettingsBusy(false);
    }
  }, []);

  const cycleTheme = useCallback(async () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length] ?? "system";
    try {
      await changeTheme(next);
    } catch (error) {
      notify(errorMessage(error));
    }
  }, [changeTheme, notify, theme]);

  const openGit = useCallback(() => {
    if (settingsBusyRef.current) return;
    sidebarLayoutRef.current?.open();
    setGitMounted(true);
    setSidebarView("git");
  }, []);

  const prepareGitOperation: PrepareGitOperation = useCallback(
    async (root, request, pathHint) => {
      if (!locksEditors(request)) return async () => {};
      if (fileOperationBusyRef.current || closingTabsRef.current)
        throw new Error(t("另一个文件或 Git 操作正在执行。"));
      if (gitBlocksPath(root)) throw new Error(t("另一个文件或 Git 操作正在执行。"));
      gitLockedRootsRef.current.add(root);
      setGitLockedRoots([...gitLockedRootsRef.current]);
      const flush = () => {
        gitLockedRootsRef.current.delete(root);
        setGitLockedRoots([...gitLockedRootsRef.current]);
        if (changesWorktree(request))
          reloadFiles(
            tabsRef.current.filter((tab) => {
              const current = loadStateRef.current;
              const projectRoot =
                current.status === "ready"
                  ? current.snapshot.projects.find((item) => item.id === tab.projectId)?.root
                  : undefined;
              const tabRoot = projectRoot ?? tab.root;
              return (
                tabRoot && insideWorktree(`${tabRoot}/${tab.path}`, root) && !isTabDirty(tab.key)
              );
            }),
          );
        flushFsChanges();
        refreshFiles();
        setSymbolRefreshToken((value) => value + 1);
      };
      try {
        const current = loadStateRef.current;
        if (current.status !== "ready") throw new Error(t("工作区尚未准备好。"));
        const paths =
          "paths" in request && request.paths.length
            ? request.paths
            : "path" in request && request.path
              ? [request.path]
              : ["stageHunk", "unstageHunk", "discardHunk"].includes(request.type) && pathHint
                ? [pathHint]
                : null;
        const affected = tabsRef.current.filter((tab) => {
          const project = current.snapshot.projects.find((item) => item.id === tab.projectId);
          if (!project) return false;
          const absolute = `${project.root}/${tab.path}`;
          return (
            insideWorktree(absolute, root) &&
            (!paths || paths.some((path) => insideWorktree(absolute, `${root}/${path}`)))
          );
        });
        const editors = affected.map((tab) => {
          const editor = editorsRef.current.get(tab.key);
          if (!editor) throw new Error(t("编辑器 {0} 尚未准备好。", tab.name));
          return editor;
        });
        const settle = await prepareEditors(editors, request);
        return async (outcome) => {
          try {
            settle(outcome);
          } finally {
            flush();
          }
        };
      } catch (error) {
        flush();
        throw error;
      }
    },
    [flushFsChanges, refreshFiles, reloadFiles, gitBlocksPath, isTabDirty],
  );

  const openGitFile = useCallback(
    (root: string, path: string) => {
      void (async () => {
        try {
          let current = loadStateRef.current;
          if (current.status !== "ready") return;
          const absolute = `${root}/${path}`;
          let project = current.snapshot.projects.find((item) =>
            insideWorktree(absolute, item.root),
          );
          if (!project) {
            const imported = await api.importProjects([root]);
            const snapshot = await api.bootstrapWorkspace();
            current = { status: "ready", snapshot };
            loadStateRef.current = current;
            setLoadState(current);
            project =
              imported.projects[0] ??
              snapshot.projects.find((item) => insideWorktree(absolute, item.root));
          }
          if (!project) throw new Error(t("无法打开仓库根目录。"));
          const relative = absolute
            .replaceAll("\\", "/")
            .slice(normalizePath(project.root).length + 1);
          openLocation(project.id, relative);
        } catch (error) {
          notify(errorMessage(error));
        }
      })();
    },
    [openLocation, notify],
  );

  const snapshot = loadState.status === "ready" ? loadState.snapshot : null;
  const defaultGitProject = snapshot?.projects.find(({ id }) => id === snapshot.activeProjectId);
  useEffect(() => {
    if (
      !defaultGitProject ||
      gitOpen ||
      gitProjectRoots[defaultGitProject.id] === defaultGitProject.root
    )
      return;
    const { id, root } = defaultGitProject;
    const preload = () => {
      setGitPreload({ id, root });
      setGitProjectRoots((current) => ({ ...current, [id]: root }));
      setGitMounted(true);
    };
    if (typeof window.requestIdleCallback === "function") {
      const task = window.requestIdleCallback(preload, { timeout: 1500 });
      return () => window.cancelIdleCallback(task);
    }
    const task = window.setTimeout(preload, 300);
    return () => window.clearTimeout(task);
  }, [defaultGitProject?.id, defaultGitProject?.root, gitOpen, gitProjectRoots]);

  const currentProject =
    snapshot?.projects.find(
      (project) =>
        project.id ===
        (gitOpen ? snapshot.activeProjectId : (activeTab?.projectId ?? snapshot.activeProjectId)),
    ) ?? null;
  const currentBranch = useProjectBranch(currentProject);

  useEffect(() => {
    if (!gitOpen || !currentProject) return;
    setGitProjectRoots((current) =>
      current[currentProject.id] === currentProject.root
        ? current
        : { ...current, [currentProject.id]: currentProject.root },
    );
  }, [gitOpen, currentProject?.id, currentProject?.root]);

  const gitProjects: (Project | null)[] =
    snapshot?.projects.filter(
      (project) =>
        gitProjectRoots[project.id] === project.root ||
        (gitOpen && project.id === currentProject?.id),
    ) ?? [];
  if (!currentProject) gitProjects.push(null);

  useEffect(() => {
    if (tabs.length === 0) setEditorStatus(null);
  }, [tabs.length]);

  const commandsBlocked =
    operationBusy ||
    settingsBusy ||
    menuBusy ||
    settingsOpen ||
    !!pendingAction ||
    !!navigationDialog;
  const menuHasFile = activeTab !== null && !gitOpen;
  const menuCanSave =
    menuHasFile &&
    !comparisonActive &&
    dirtyKeys.has(activeTab!.key) &&
    editorStatus !== null &&
    !editorStatus.readOnly &&
    !editorStatus.saving;
  const menuCanNavigate =
    menuHasFile && !comparisonActive && editorStatus !== null && !navigationBusy;
  const menuCanUseEditorActions =
    menuHasFile && !comparisonActive && !!editorStatus?.canUseEditorActions;
  const menuCanShowQuickDocumentation =
    menuHasFile && !comparisonActive && !!editorStatus?.canShowQuickDocumentation;
  const menuState = useMemo<NativeMenuState>(
    () => ({
      language,
      ready: loadState.status === "ready",
      blocked: commandsBlocked || quickOpen,
      hasFile: menuHasFile,
      canSave: menuCanSave,
      canNavigate: menuCanNavigate,
      canUseEditorActions: menuCanUseEditorActions,
      canShowQuickDocumentation: menuCanShowQuickDocumentation,
      canGoBack: navigationHistory.back > 0,
      canGoForward: navigationHistory.forward > 0,
      splitOpen,
      terminalOpen,
      sidebarView,
      theme,
      autoSave: preferences.autoSave,
      wordWrap: preferences.wordWrap,
      lineNumbers: preferences.lineNumbers,
      showStatusBar: preferences.showStatusBar,
    }),
    [
      language,
      loadState.status,
      commandsBlocked,
      quickOpen,
      menuHasFile,
      menuCanSave,
      menuCanNavigate,
      menuCanUseEditorActions,
      menuCanShowQuickDocumentation,
      navigationHistory.back,
      navigationHistory.forward,
      splitOpen,
      terminalOpen,
      sidebarView,
      theme,
      preferences.autoSave,
      preferences.wordWrap,
      preferences.lineNumbers,
      preferences.showStatusBar,
    ],
  );

  const canRunWorkspaceCommand = (canCloseQuickOpen = false) =>
    menuState.ready &&
    !commandsBlocked &&
    (!quickOpen || canCloseQuickOpen) &&
    !menuBusyRef.current &&
    !settingsBusyRef.current &&
    !fileOperationBusyRef.current &&
    !gitOperationBusyRef.current &&
    !closingTabsRef.current;

  const runWorkspaceCommand = async (action: WorkspaceCommand, origin?: "shortcut" | "palette") => {
    const fromShortcut = origin === "shortcut";
    if (!canRunWorkspaceCommand(origin === "palette" || (fromShortcut && action === "quick-open")))
      return;
    if (origin === "palette") flushSync(() => setQuickOpen(false));
    const lock =
      !fromShortcut || action === "open-file" || action === "import-project" || action === "quit";
    if (lock) {
      menuBusyRef.current = true;
      setMenuBusy(true);
    }
    try {
      switch (action) {
        case "settings":
          setSettingsOpen(true);
          break;
        case "quit": {
          await getCurrentWindow().close();
          break;
        }
        case "open-file": {
          const selected = await open({ multiple: true, directory: false, title: t("打开文件") });
          if (selected) await handleExternalFiles(Array.isArray(selected) ? selected : [selected]);
          break;
        }
        case "import-project":
          await handleImport();
          break;
        case "save":
          if (!comparisonActive && (fromShortcut || menuState.canSave)) await saveActiveTab();
          break;
        case "close-tab":
          if (comparisonActive) closeEditorComparison(activePane);
          else if (menuState.hasFile && activeTab) await handleCloseTabs([activeTab]);
          break;
        case "find":
          if (!comparisonActive && menuState.hasFile && activeTab)
            editorsRef.current.get(activeTab.key)?.openFileSearch();
          break;
        case "search-workspace":
          focusGlobalSearch();
          break;
        case "search":
          focusGlobalSearch();
          break;
        case "sidebar-search":
          selectSidebarView("search");
          break;
        case "files":
        case "sidebar-files":
          selectSidebarView("files");
          break;
        case "symbols":
        case "sidebar-symbols":
          selectSidebarView("symbols");
          break;
        case "git":
          openGit();
          break;
        case "terminal":
          toggleTerminal();
          break;
        case "quick-open":
          setQuickOpen((value) => !fromShortcut || !value);
          break;
        case "back":
        case "forward":
          if (action === "back" ? menuState.canGoBack : menuState.canGoForward)
            navigateHistory(action);
          break;
        case "toggle-split":
          toggleSplit();
          break;
        case "definition":
        case "references":
        case "implementation":
          if (!comparisonActive && (fromShortcut || menuState.canNavigate))
            await runNavigation(action);
          break;
        case "quick-fix":
        case "organize-imports":
        case "parameter-info":
        case "quick-documentation":
        case "format-code":
          if (
            activeTab &&
            (action === "quick-documentation"
              ? menuCanShowQuickDocumentation
              : menuCanUseEditorActions)
          )
            await editorsRef.current.get(activeTab.key)?.runEditorAction(action);
          break;
        case "copy-file":
        case "paste-file":
        case "delete-file":
        case "new-file":
        case "new-folder":
        case "rename": {
          if (
            comparisonActive &&
            (action === "rename" || action === "delete-file" || action === "copy-file")
          )
            break;
          const project = snapshot?.projects.find(
            (item) => item.id === (activeTab?.projectId ?? snapshot.activeProjectId),
          );
          if (action === "paste-file") {
            fileTreeRef.current?.pasteSelected(
              project && activeTab ? { project, parent: parentPath(activeTab.path) } : null,
            );
            break;
          }
          if (!project) break;
          if (action === "new-file" || action === "new-folder") {
            fileTreeRef.current?.create(
              project,
              activeTab ? parentPath(activeTab.path) : "",
              action === "new-folder",
            );
            break;
          }
          if (!activeTab) break;
          if (action === "copy-file") {
            await api.copyEntry(project.id, activeTab.path);
            notify(t("已复制文件"));
          } else if (action === "delete-file") {
            fileTreeRef.current?.trash(project, activeTab.path);
          } else {
            fileTreeRef.current?.rename(project, activeTab.path);
          }
          break;
        }
        case "theme-system":
        case "theme-light":
        case "theme-dark":
          await changeTheme(
            action === "theme-system" ? "system" : action === "theme-light" ? "light" : "dark",
          );
          break;
        case "auto-save":
        case "word-wrap":
        case "line-numbers":
        case "status-bar": {
          const key = {
            "auto-save": "autoSave",
            "word-wrap": "wordWrap",
            "line-numbers": "lineNumbers",
            "status-bar": "showStatusBar",
          } as const;
          await persistSettings({
            language,
            fonts,
            colorSchemes,
            theme,
            preferences: { ...preferences, [key[action]]: !preferences[key[action]] },
          });
          break;
        }
      }
    } finally {
      if (lock) {
        menuBusyRef.current = false;
        setMenuBusy(false);
      }
    }
  };

  useNativeMenu(menuState, runWorkspaceCommand, (error) => notify(errorMessage(error)));

  const paletteEntries: [WorkspaceCommand, boolean?][] = [
    ["settings"],
    ["open-file"],
    ["import-project"],
    ["search-workspace"],
    ["sidebar-files"],
    ["sidebar-search"],
    ["sidebar-symbols"],
    ["git"],
    ["terminal"],
    ["toggle-split"],
    ["save", menuCanSave],
    ["close-tab", menuHasFile],
    ["find", menuHasFile],
    ["back", menuState.canGoBack],
    ["forward", menuState.canGoForward],
    ["definition", menuCanNavigate],
    ["references", menuCanNavigate],
    ["implementation", menuCanNavigate],
    ["quick-fix", menuCanUseEditorActions],
    ["format-code", menuCanUseEditorActions],
    ["organize-imports", menuCanUseEditorActions],
    ["parameter-info", menuCanUseEditorActions],
    ["quick-documentation", menuCanShowQuickDocumentation],
  ];
  const paletteActions: PaletteAction[] = quickOpen
    ? paletteEntries.flatMap(([action, enabled = true]) =>
        enabled
          ? [
              {
                label: shortcutCommandLabel(action),
                shortcut: shortcutBindings[action],
                run: () => {
                  void runWorkspaceCommand(action, "palette").catch((error) =>
                    notify(errorMessage(error)),
                  );
                },
              },
            ]
          : [],
      )
    : [];

  const recentLocations: RecentFile[] = [];
  if (quickOpen) {
    const seen = new Set<string>();
    for (const entry of [currentNavigationEntry(), ...getNavigationEntries()]) {
      if (!entry?.request || !snapshot?.projects.some(({ id }) => id === entry.projectId)) continue;
      const {
        projectId,
        path,
        request: { line, character },
      } = entry;
      const key = JSON.stringify([projectId, path, line, character]);
      if (seen.has(key)) continue;
      seen.add(key);
      recentLocations.push({ projectId, path, position: { line, character } });
    }
  }

  const handleShortcut = useEffectEvent((event: KeyboardEvent, capture: boolean) => {
    if (fileOperationBusyRef.current) {
      if (!capture && shouldBlockKeyboard()) event.preventDefault();
      return;
    }
    if (event.defaultPrevented || event.isComposing) return;
    const command = capture
      ? shortcutBindings.terminal && shortcutFromEvent(event) === shortcutBindings.terminal
        ? "terminal"
        : null
      : matchShortcut(event, shortcutBindings, "workspace");
    if (!command || (command === "terminal") !== capture) return;
    if (!canRunWorkspaceCommand(command === "quick-open")) return;

    const inTextInput =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable);
    switch (command) {
      case "save":
      case "close-tab":
        if (!activeTab) return;
        break;
      case "find":
      case "definition":
      case "references":
      case "implementation":
        if (!activeTab || inTextInput) return;
        break;
      case "rename":
        if (!activeTab || (inTextInput && !event.target.closest(".cm-content"))) return;
        break;
      case "copy-file":
      case "delete-file":
      case "paste-file":
      case "new-file":
      case "new-folder":
        if (
          inTextInput ||
          (event.target instanceof Element && event.target.closest(".cm-editor")) ||
          !(window.getSelection()?.isCollapsed ?? true)
        )
          return;
        if (!activeTab && (command === "copy-file" || command === "delete-file")) return;
        break;
    }
    event.preventDefault();
    if (capture) event.stopPropagation();
    void runWorkspaceCommand(command, "shortcut").catch((error) => notify(errorMessage(error)));
  });

  useEffect(() => {
    const capture = (event: KeyboardEvent) => handleShortcut(event, true);
    const bubble = (event: KeyboardEvent) => handleShortcut(event, false);
    // The terminal can consume its toggle key before it reaches the window.
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", bubble);
    };
  }, []);

  if (loadState.status === "loading") {
    return (
      <div className="app-loading">
        <div className="brand-mark" aria-hidden>
          <BookOpen size={20} />
        </div>
        <LoaderCircle size={20} className="spin" />
        <span>{t("正在恢复工作区…")}</span>
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="app-loading app-error">
        <AlertCircle size={28} />
        <h1>{t("无法启动 Gaze")}</h1>
        <p>{loadState.message}</p>
        <button className="button" onClick={() => void loadWorkspace()}>
          <RotateCcw size={14} />
          {t("重试")}
        </button>
      </div>
    );
  }

  const themeLabel =
    theme === "system"
      ? t("主题：跟随系统")
      : theme === "light"
        ? t("主题：浅色")
        : t("主题：深色");
  const primaryTabs = tabs.filter((tab) => paneOf(tab) === "primary");
  const secondaryTabs = tabs.filter((tab) => paneOf(tab) === "secondary");

  const renderEditorPane = (pane: EditorPane, paneTabs: EditorTab[]) => {
    const comparison = comparisons[pane];
    const source = paneTabs.find((tab) => tab.key === comparison?.sourceKey);
    return (
      <EditorPaneView
        key={pane}
        pane={pane}
        tabs={paneTabs}
        activeKey={paneActive[pane]}
        dirtyKeys={dirtyKeys}
        splitOpen={splitOpen}
        gitOpen={gitOpen}
        hasPrimaryTabs={primaryTabs.length > 0}
        comparison={
          comparison && source
            ? {
                id: comparison.id,
                source,
                snapshot: comparison.snapshot,
                selected: isComparing(pane, paneActive[pane]),
              }
            : undefined
        }
        editorFontFamily={fontStack(fonts.editor, "editor")}
        tabSize={preferences.tabSize}
        onActivatePane={() => activatePane(pane)}
        onActivateTab={(tab) => handleActivateTab(tab, pane)}
        onCloseTab={handleCloseTab}
        onCloseTabs={handleCloseTabs}
        onNotice={notify}
        onToggleSplit={pane === "primary" || primaryTabs.length === 0 ? toggleSplit : undefined}
        onMoveToOtherPane={moveTabToOtherPane}
        onReorder={reorderTabs}
        onActivateComparison={() => {
          if (!comparison || !source || gitOperationBusyRef.current || fileOperationBusyRef.current)
            return;
          handleActivateTab(source, pane);
          setComparisons((current) => ({
            ...current,
            [pane]: { ...comparison, selected: true },
          }));
        }}
        onCloseComparison={() => closeEditorComparison(pane)}
        onImport={handleImport}
        onOpenSecondary={() => {
          activatePane("secondary");
          setQuickOpen(true);
        }}
      />
    );
  };

  const workspace = (
    <div className="app-shell">
      <Tooltip />
      {dropHint && (
        <div className="file-drop-hint" role="status">
          {dropHint}
        </div>
      )}
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark" aria-hidden>
            <BookOpen size={16} />
          </span>
          <span className="brand-name">Gaze</span>
        </div>
        <div className="breadcrumb" aria-live="polite" data-tauri-drag-region>
          <span className="breadcrumb-project">
            {currentProject?.name ?? activeTab?.projectName}
          </span>
          {currentBranch && (
            <span
              className="project-branch"
              role="status"
              aria-label={t("当前 Git 分支")}
              data-tooltip={currentBranch}
              data-tauri-drag-region
            >
              <GitBranch size={12} aria-hidden />
              <span>{currentBranch}</span>
            </span>
          )}
        </div>
        <button
          className="quick-open-trigger"
          onClick={() => setQuickOpen(true)}
          aria-label={
            shortcutBindings["quick-open"]
              ? t("快速打开文件（{0}）", shortcutLabel(shortcutBindings["quick-open"]))
              : t("快速打开")
          }
          data-tooltip={
            shortcutBindings["quick-open"]
              ? t("快速打开文件（{0}）", shortcutLabel(shortcutBindings["quick-open"]))
              : t("快速打开")
          }
        >
          <FileSearch size={14} />
          <span>{t("快速打开")}</span>
          {shortcutBindings["quick-open"] && (
            <kbd>{shortcutLabel(shortcutBindings["quick-open"])}</kbd>
          )}
        </button>
        <div className="topbar-actions">
          {capabilities && !capabilities.ctagsAvailable && (
            <span className="tool-warning" data-tooltip={capabilities.ctagsMessage ?? undefined}>
              {t("ctags 不可用")}
            </span>
          )}
        </div>
      </header>

      <SidebarLayout
        ref={sidebarLayoutRef}
        onPreview={() => setSidebarView("files")}
        rail={(sidebarExpanded) => (
          <>
            <button
              className={`rail-button ${sidebarView === "files" ? "is-active" : ""}`}
              onClick={() => {
                if (sidebarView === "files") sidebarLayoutRef.current?.toggle();
                else void selectSidebarView("files");
              }}
              data-tooltip={t("项目文件")}
              aria-label={t("项目文件")}
              aria-pressed={sidebarView === "files"}
              aria-expanded={sidebarExpanded}
              aria-controls="workspace-sidebar"
              data-sidebar-trigger=""
            >
              <Files size={17} />
            </button>
            <button
              className={`rail-button ${sidebarView === "search" ? "is-active" : ""}`}
              onClick={() => {
                if (sidebarView === "search") focusGlobalSearch();
                else void selectSidebarView("search");
              }}
              data-tooltip={
                shortcutBindings["search-workspace"]
                  ? t("全局搜索（{0}）", shortcutLabel(shortcutBindings["search-workspace"]))
                  : t("全局搜索")
              }
              aria-label={t("全局搜索")}
              aria-pressed={sidebarView === "search"}
            >
              <Search size={17} />
            </button>
            <button
              className={`rail-button ${sidebarView === "symbols" ? "is-active" : ""}`}
              onClick={() => void selectSidebarView("symbols")}
              data-tooltip={t("符号与大纲")}
              aria-label={t("符号与大纲")}
              aria-pressed={sidebarView === "symbols"}
            >
              <Boxes size={17} />
            </button>
            <button
              className={`rail-button ${gitOpen ? "is-active" : ""}`}
              onClick={openGit}
              aria-label={t("Git 管理")}
              aria-pressed={gitOpen}
              data-tooltip={
                shortcutBindings.git
                  ? t("Git 管理（{0}）", shortcutLabel(shortcutBindings["git"]))
                  : t("Git 管理")
              }
            >
              <GitBranch size={17} />
            </button>
            <div className="sidebar-rail-actions">
              <button
                className="rail-button"
                onClick={() => void cycleTheme()}
                disabled={settingsBusy}
                data-tooltip={themeLabel}
                aria-label={themeLabel}
              >
                {theme === "system" ? (
                  <Monitor size={16} />
                ) : theme === "dark" ? (
                  <Moon size={16} />
                ) : (
                  <Sun size={16} />
                )}
              </button>
              <button
                className="rail-button"
                onClick={() => setSettingsOpen(true)}
                disabled={settingsBusy}
                data-tooltip={
                  shortcutBindings.settings
                    ? t("设置（{0}）", shortcutLabel(shortcutBindings["settings"]))
                    : t("设置")
                }
                aria-label={t("设置")}
              >
                <Settings size={16} />
              </button>
            </div>
          </>
        )}
        panel={
          <div className="sidebar-panels">
            <section className="sidebar-view" hidden={sidebarView !== "files"}>
              <FileTree
                ref={fileTreeRef}
                projects={snapshot?.projects ?? []}
                activeProjectId={snapshot?.activeProjectId ?? null}
                activeFilePath={activeTab?.path ?? null}
                active={sidebarView === "files"}
                shortcutBindings={shortcutBindings}
                refresh={treeRefresh}
                initialOpenProjects={initialSession.tree.openProjects}
                initialExpandedDirectories={initialSession.tree.expandedDirectories}
                onExpansionChange={handleTreeExpansion}
                onOpenProject={handleOpenProject}
                onOpenFile={handleOpenFile}
                onRemoveProject={(project) => void handleRemoveProject(project)}
                onImport={() => void handleImport()}
                onNotice={notify}
                onFileOperation={handleFileOperation}
                onPaste={handlePaste}
              />
            </section>
            <section className="sidebar-view" hidden={sidebarView !== "search"}>
              <SearchPanel
                preferences={preferences}
                active={sidebarView === "search"}
                focusSignal={searchFocusSignal}
                editorSearch={editorSearch}
                capabilities={capabilities}
                projects={snapshot?.projects ?? []}
                activeProjectId={currentProject?.id ?? null}
                onOpenLocation={openLocation}
                onPreviewReplace={handlePreviewReplace}
                onApplyReplace={handleApplyReplace}
                onUndoReplace={handleUndoReplace}
                onCancelReplace={cancelReplacement}
              />
            </section>
            <section className="sidebar-view" hidden={sidebarView !== "git"}>
              <div className="git-sidebar-target" ref={setGitSidebar} />
            </section>
            <section className="sidebar-view symbols-view" hidden={sidebarView !== "symbols"}>
              {referenceResults && (
                <div className="navigation-modes" role="group" aria-label={t("符号侧栏视图")}>
                  <button aria-pressed={!showReferences} onClick={() => setShowReferences(false)}>
                    {t("符号")}
                  </button>
                  <button aria-pressed={showReferences} onClick={() => setShowReferences(true)}>
                    {t("引用")}
                  </button>
                </div>
              )}
              <div className="symbols-view-content" hidden={showReferences}>
                <SymbolPanel
                  active={sidebarView === "symbols" && !showReferences}
                  project={currentProject}
                  activeTab={activeTab}
                  refreshToken={refreshToken + symbolRefreshToken}
                  navigationBusy={navigationBusy}
                  onOpenLocation={openLocation}
                  onFindImplementations={() => void runNavigation("implementation")}
                  onNotice={notify}
                />
              </div>
              {referenceResults && (
                <div className="symbols-view-content" hidden={!showReferences}>
                  <ReferencePanel
                    active={sidebarView === "symbols" && showReferences}
                    result={referenceResults}
                    projects={snapshot?.projects ?? []}
                    readText={readPreviewText}
                    onOpen={openNavigationLocation}
                    onClose={() => {
                      setShowReferences(false);
                      setReferenceResults(null);
                    }}
                  />
                </div>
              )}
            </section>
          </div>
        }
      >
        <main className="main-pane">
          <div className="editor-panes" data-split={splitOpen} hidden={gitOpen}>
            {renderEditorPane("primary", primaryTabs)}
            {splitOpen && renderEditorPane("secondary", secondaryTabs)}
            {splitOpen && <EditorSplitResizer />}
            {tabs.map((tab) => {
              const pane = paneOf(tab);
              const tabRoot =
                snapshot?.projects.find((item) => item.id === tab.projectId)?.root ?? tab.root;
              const visible = tab.key === paneActive[pane] && !isComparing(pane, tab.key);
              const isActive = visible && pane === activePane && !gitOpen;
              return (
                <div
                  className="document-area document-panel editor-document"
                  data-pane={pane}
                  onPointerDown={() => activatePane(pane)}
                  hidden={!visible || gitOpen}
                  key={tab.key}
                >
                  <CodeReader
                    ref={(handle) => registerEditor(tab.key, handle)}
                    tab={tab}
                    gitLocked={gitLockedRoots.some(
                      (root) => tabRoot && insideWorktree(`${tabRoot}/${tab.path}`, root),
                    )}
                    active={isActive}
                    editorPopupsBlocked={
                      navigationBusy ||
                      navigationDialog !== null ||
                      settingsOpen ||
                      !!pendingAction ||
                      quickOpen
                    }
                    theme={resolvedTheme}
                    fontFamily={fontStack(fonts.editor, "editor")}
                    preferences={preferences}
                    initialView={initialSession.views[tab.key]}
                    reveal={isActive ? reveal : null}
                    reloadToken={fileRevisions[tab.key] ?? 0}
                    externalChangeToken={externalChanges[tab.key] ?? 0}
                    pythonRevision={
                      isPythonFile(tab.name) ? pythonRevisions[tab.projectId] : undefined
                    }
                    previewRequest={
                      markdownNavigation?.key === tab.key ? markdownNavigation.request : null
                    }
                    onGoToDefinition={(position, result) =>
                      void runNavigation("definition", { key: tab.key, position, result })
                    }
                    onNavigate={(target: NavigationTarget) => {
                      if (!canRunWorkspaceCommand() || navigationBusy) return false;
                      void runWorkspaceCommand(target, "shortcut").catch((error) =>
                        notify(errorMessage(error)),
                      );
                      return true;
                    }}
                    onActivate={() => activatePane(pane)}
                    onSearchSelection={searchSelectedText}
                    onOpenMarkdownFile={handleOpenMarkdownFile}
                    onNotice={notify}
                    onOpenComparison={(snapshot) => openEditorComparison(tab, snapshot)}
                    onStatus={isActive ? setEditorStatus : noopStatus}
                    onDirtyChange={(value) => handleDirtyChange(tab.key, value)}
                    onSaved={() => handleSaved(tab.key)}
                  />
                </div>
              );
            })}
          </div>
          {gitMounted && (
            <div className="document-panel git-main-panel" hidden={!gitOpen}>
              <Suspense
                fallback={
                  <div className="reader-state" role="status">
                    {t("正在加载 Git 工作区…")}
                  </div>
                }
              >
                {gitProjects.map((project) => (
                  <GitWorkspace
                    key={project ? JSON.stringify([project.id, project.root]) : "empty"}
                    project={project}
                    projects={snapshot?.projects ?? []}
                    sidebarContainer={gitSidebar}
                    onSelectProject={handleOpenProject}
                    active={gitOpen && project?.id === currentProject?.id}
                    preload={project?.id === gitPreload?.id && project?.root === gitPreload?.root}
                    prepareOperation={prepareGitOperation}
                    onOpenFile={openGitFile}
                    onOpenTerminal={() => setTerminalOpen(true)}
                    onNotice={notify}
                  />
                ))}
              </Suspense>
            </div>
          )}
          <TerminalPanel
            open={terminalOpen}
            project={currentProject}
            theme={resolvedTheme}
            fontFamily={fontStack(fonts.terminal, "terminal")}
            colorScheme={colorSchemes[resolvedTheme]}
            preferences={preferences}
            onHide={() => setTerminalOpen(false)}
            onNotice={notify}
          />
          <WorkspaceStatusBar
            status={editorStatus}
            activeTab={activeTab}
            navigationBusy={navigationBusy}
            preferences={preferences}
            hasProjects={!!snapshot?.projects.length}
            terminalOpen={terminalOpen}
            terminalShortcut={shortcutBindings.terminal}
            onToggleTerminal={toggleTerminal}
            onPythonChange={refreshPython}
            onNotice={notify}
          />
        </main>
      </SidebarLayout>

      {settingsOpen && (
        <SettingsDialog
          settings={{ language, fonts, colorSchemes, theme, preferences }}
          isMac={isMac}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next, layout) => {
            await persistSettings(next);
            saveLayout(layout);
          }}
        />
      )}

      {quickOpen && (
        <QuickOpen
          projects={snapshot?.projects ?? []}
          project={
            snapshot?.projects.find(
              ({ id }) => id === (currentProject?.id ?? snapshot.activeProjectId),
            ) ??
            snapshot?.projects[0] ??
            null
          }
          recentFiles={updateRecentPositions().filter((file) =>
            snapshot?.projects.some(({ id }) => id === file.projectId),
          )}
          locations={recentLocations}
          actions={paletteActions}
          readText={readPreviewText}
          onClose={() => setQuickOpen(false)}
          onOpen={openRecentLocation}
          onOpenSymbol={openNavigationLocation}
          onImport={() => void handleImport()}
        />
      )}

      {navigationDialog && (
        <LocationPicker
          title={navigationDialog.title}
          result={navigationDialog.result}
          anchor={navigationDialog.anchor}
          projects={snapshot?.projects ?? []}
          onClose={() => setNavigationDialog(null)}
          onSelect={openNavigationLocation}
          onShowInSidebar={
            navigationDialog.references && navigationDialog.result.locations.length > 0
              ? () => {
                  setReferenceResults(navigationDialog.result);
                  setShowReferences(true);
                  setNavigationDialog(null);
                  selectSidebarView("symbols");
                }
              : undefined
          }
        />
      )}

      {pendingAction &&
        (() => {
          const copy = dialogCopy(pendingAction);
          const files = dirtyTabsForAction(pendingAction).map(
            (tab) => `${tab.projectName}/${tab.path}`,
          );
          return (
            <UnsavedDialog
              title={copy.title}
              message={copy.message}
              files={files}
              saveLabel={copy.saveLabel}
              discardLabel={copy.discardLabel}
              busy={dialogBusy}
              error={dialogError}
              onSave={() => void handleDialogSave()}
              onDiscard={handleDialogDiscard}
              onCancel={() => {
                if (dialogBusy) return;
                setPendingAction(null);
                setDialogError(null);
              }}
            />
          );
        })()}

      {toast && (
        <div className="toast" role="status" key={toast.id}>
          <AlertCircle size={15} />
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)} aria-label={t("关闭提示")}>
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
  return <PluginProvider preferences={preferences}>{workspace}</PluginProvider>;
}
