import { t, useLanguage } from "../../lib/i18n";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ChevronRight,
  Folder,
  FolderOpen,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Plus,
} from "lucide-react";

import { api } from "../../lib/platform/api";
import { matchShortcut, type ShortcutBindings } from "../../lib/shortcuts";
import type { DirEntry, PasteResult, Project, TreeRefresh } from "../../lib/types";
import { basename, errorMessage } from "../../lib/utils";
import { parentPath } from "../../lib/utils";
import { FileIcon } from "../common/FileIcon";
import {
  FileOperationDialog,
  type FileOperation,
  type FileOperationResult,
} from "./FileOperationDialog";
import { FileTreeMenu, type TreeMenuTarget } from "./FileTreeMenu";
import { useFileTreeGit } from "../../git/hooks/useFileTreeGit";
import "./FileTree.css";

type DirectoryState =
  | { status: "loading"; entries: DirEntry[] }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; entries: DirEntry[]; message: string };

interface FlatNode {
  kind: "project" | "directory" | "file" | "error";
  key: string;
  depth: number;
  parentKey: string | null;
  setSize?: number;
  posInSet?: number;
  project: Project;
  entry?: DirEntry;
  message?: string;
}

interface FileTreeProps {
  projects: Project[];
  activeProjectId: string | null;
  activeFilePath: string | null;
  active: boolean;
  shortcutBindings: ShortcutBindings;
  refresh: TreeRefresh;
  initialOpenProjects?: string[];
  initialExpandedDirectories?: string[];
  onExpansionChange?: (
    openProjects: ReadonlySet<string>,
    expandedDirectories: ReadonlySet<string>,
  ) => void;
  onOpenProject: (project: Project) => void;
  onOpenFile: (project: Project, entry: DirEntry) => void;
  onRemoveProject: (project: Project) => void;
  onImport: () => void;
  onNotice: (message: string) => void;
  onFileOperation: (operation: FileOperation, value: string) => Promise<FileOperationResult>;
  onPaste: (project: Project, parentPath: string, paths?: string[]) => Promise<PasteResult>;
}

const directoryKey = (projectId: string, path: string) => `${projectId}\u0000${path}`;
const isSelectable = (node: FlatNode) =>
  node.kind === "project" || node.kind === "directory" || node.kind === "file";

export interface FileTreeHandle {
  /** Paste clipboard files into `parent` with the same refresh the row menu uses. */
  paste: (project: Project, parent: string) => void;
  /** Paste into the selected tree folder, else `fallback`, like the row menu does. */
  pasteSelected: (fallback: { project: Project; parent: string } | null) => void;
  drop: (project: Project, parent: string, paths: string[]) => Promise<void>;
  /** Ask for confirmation to move `path` to the trash, like the row menu does. */
  trash: (project: Project, path: string) => void;
  /** Ask for the new name of `path`. */
  rename: (project: Project, path: string) => void;
  /** Ask for a name for a new file or folder inside `parent`. */
  create: (project: Project, parent: string, isDir: boolean) => void;
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  {
    projects,
    activeProjectId,
    activeFilePath,
    active,
    shortcutBindings,
    refresh,
    initialOpenProjects,
    initialExpandedDirectories,
    onExpansionChange,
    onOpenProject,
    onOpenFile,
    onRemoveProject,
    onImport,
    onNotice,
    onFileOperation,
    onPaste,
  }: FileTreeProps,
  ref,
) {
  useLanguage();
  const scrollRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const requestVersions = useRef(new Map<string, number>());
  const [openProjects, setOpenProjects] = useState<Set<string>>(() => new Set(initialOpenProjects));
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => new Set(initialExpandedDirectories),
  );
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [menu, setMenu] = useState<TreeMenuTarget | null>(null);
  const [operation, setOperation] = useState<FileOperation | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const selectionAnchor = useRef<string | null>(null);
  const gitStatuses = useFileTreeGit(projects, refresh.token, active);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [pasteBusy, setPasteBusy] = useState(false);
  const pastingRef = useRef(false);

  useEffect(() => {
    if (!selectedKey && selectedKeys.size === 0) return;
    const clearSelection = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (scrollRef.current?.contains(target) && target.closest('[role="treeitem"]')) return;
      // The tree's menu and operation dialog are rendered through portals.
      if (menu && target.closest(".file-tree-menu")) return;
      if (operation && target.closest(".file-operation-dialog")) return;
      setSelectedKeys(new Set());
      setSelectedKey(null);
      selectionAnchor.current = null;
    };
    document.addEventListener("pointerdown", clearSelection, true);
    return () => document.removeEventListener("pointerdown", clearSelection, true);
  }, [menu, operation, selectedKey, selectedKeys.size]);

  useEffect(() => {
    onExpansionChange?.(openProjects, expandedDirectories);
  }, [openProjects, expandedDirectories, onExpansionChange]);

  const loadDirectory = useCallback(async (project: Project, path: string) => {
    const key = directoryKey(project.id, path);
    const version = (requestVersions.current.get(key) ?? 0) + 1;
    requestVersions.current.set(key, version);
    setDirectories((current) =>
      current[key]?.status === "loaded"
        ? current
        : { ...current, [key]: { status: "loading", entries: current[key]?.entries ?? [] } },
    );
    try {
      const listing = await api.listDirectory(project.id, path);
      if (requestVersions.current.get(key) !== version) return;
      setDirectories((current) => ({
        ...current,
        [key]: { status: "loaded", entries: listing.entries },
      }));
    } catch (error) {
      if (requestVersions.current.get(key) !== version) return;
      setDirectories((current) => ({
        ...current,
        [key]: {
          status: "error",
          entries: current[key]?.entries ?? [],
          message: errorMessage(error),
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    setOpenProjects((current) => {
      if (current.has(activeProjectId)) return current;
      const next = new Set(current);
      next.add(activeProjectId);
      return next;
    });
    // Only a newly active project expands; project list edits must not reopen a collapsed one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  useEffect(() => {
    for (const project of projects) {
      if (!openProjects.has(project.id)) continue;
      const key = directoryKey(project.id, "");
      if (!directories[key]) void loadDirectory(project, "");
    }
    for (const key of expandedDirectories) {
      const [projectId, path] = key.split("\u0000");
      const project = projects.find((item) => item.id === projectId);
      if (project && path && !directories[key]) void loadDirectory(project, path);
    }
  }, [directories, expandedDirectories, loadDirectory, openProjects, projects]);

  useEffect(() => {
    if (refresh.token === 0) return;
    for (const [projectId, changedDirs] of refresh.directories) {
      const project = projects.find((item) => item.id === projectId);
      if (!project) continue;
      const prefix = `${projectId}\u0000`;
      const reload =
        changedDirs ??
        Object.keys(directories)
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length));
      // Reload cached listings; uncached directories remain lazy.
      for (const directory of new Set(["", ...reload])) {
        if (directories[directoryKey(project.id, directory)])
          void loadDirectory(project, directory);
      }
    }
    // Only a filesystem revision should trigger a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh.token]);

  useEffect(() => {
    const ids = new Set(projects.map((project) => project.id));
    setOpenProjects((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
    setExpandedDirectories((current) => {
      const next = new Set([...current].filter((key) => ids.has(key.split("\u0000", 1)[0] ?? "")));
      return next.size === current.size ? current : next;
    });
    setDirectories((current) => {
      const entries = Object.entries(current).filter(([key]) =>
        ids.has(key.split("\u0000", 1)[0] ?? ""),
      );
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [projects]);

  const nodes = useMemo(() => {
    const result: FlatNode[] = [];
    const appendDirectory = (project: Project, path: string, depth: number, parentKey: string) => {
      const key = directoryKey(project.id, path);
      const state = directories[key];
      if (!state || (state.status === "loading" && state.entries.length === 0)) return;
      if (state.status === "error" && state.entries.length === 0) {
        result.push({
          kind: "error",
          key: `${key}\u0000error`,
          depth,
          parentKey,
          project,
          message: state.message,
        });
        return;
      }
      for (const [index, entry] of state.entries.entries()) {
        const entryKey = directoryKey(project.id, entry.path);
        result.push({
          kind: entry.isDir ? "directory" : "file",
          key: entryKey,
          depth,
          parentKey,
          setSize: state.entries.length,
          posInSet: index + 1,
          project,
          entry,
        });
        if (entry.isDir && !entry.isSymlink && expandedDirectories.has(entryKey)) {
          appendDirectory(project, entry.path, depth + 1, entryKey);
        }
      }
      if (state.status === "error") {
        result.push({
          kind: "error",
          key: `${key}\u0000error`,
          depth,
          parentKey,
          project,
          message: state.message,
        });
      }
    };

    for (const [index, project] of projects.entries()) {
      const key = `project\u0000${project.id}`;
      result.push({
        kind: "project",
        key,
        depth: 0,
        parentKey: null,
        setSize: projects.length,
        posInSet: index + 1,
        project,
      });
      if (openProjects.has(project.id)) {
        appendDirectory(project, "", 1, key);
      }
    }
    return result;
  }, [directories, expandedDirectories, openProjects, projects]);

  useEffect(() => {
    const visible = new Set(nodes.filter((node) => node.entry).map((node) => node.key));
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => visible.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [nodes]);

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 27,
    overscan: 12,
  });
  const selectedIndexRef = useRef(0);
  useLayoutEffect(() => {
    if (!selectedKey) return;
    const selectable = nodes.filter(isSelectable);
    const index = selectable.findIndex((node) => node.key === selectedKey);
    if (index >= 0) {
      selectedIndexRef.current = index;
      return;
    }
    // Keep the roving focus on a nearby row when the focused row disappears
    // (trashed file, external deletion, or a collapsed parent directory).
    const neighbour = selectable[Math.min(selectedIndexRef.current, selectable.length - 1)];
    setSelectedKey(neighbour?.key ?? null);
    if (neighbour && document.activeElement === scrollRef.current)
      virtualizer.scrollToIndex(nodes.indexOf(neighbour));
  }, [nodes, selectedKey, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const selectedIndex = nodes.findIndex((node) => node.key === selectedKey);
  const activeDescendant =
    selectedIndex >= 0 && virtualItems.some((item) => item.index === selectedIndex)
      ? `${treeId}-node-${selectedIndex}`
      : undefined;
  const activeRowVisible =
    activeDescendant &&
    virtualizer.range &&
    selectedIndex >= virtualizer.range.startIndex &&
    selectedIndex <= virtualizer.range.endIndex;

  const toggleProject = (project: Project) => {
    const nextOpen = !openProjects.has(project.id);
    setOpenProjects((current) => {
      const next = new Set(current);
      if (nextOpen) next.add(project.id);
      else next.delete(project.id);
      return next;
    });
    if (nextOpen) void loadDirectory(project, "");
  };

  const activateProject = (project: Project) => {
    onOpenProject(project);
    if (!openProjects.has(project.id)) {
      setOpenProjects((current) => new Set(current).add(project.id));
      void loadDirectory(project, "");
    }
  };

  const toggleDirectory = (project: Project, entry: DirEntry) => {
    if (entry.isSymlink) {
      onNotice(t("为安全起见，文件树不会递归展开符号链接目录。"));
      return;
    }
    const key = directoryKey(project.id, entry.path);
    const opening = !expandedDirectories.has(key);
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (opening) next.add(key);
      else next.delete(key);
      return next;
    });
    if (opening && !directories[key]) void loadDirectory(project, entry.path);
  };

  const selectNode = (
    node: FlatNode,
    modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
    focus = true,
  ) => {
    setSelectedKey(node.key);
    if (modifiers.shiftKey && node.entry) {
      const anchor = nodes.findIndex(
        (item) => item.key === selectionAnchor.current && item.project.id === node.project.id,
      );
      const end = nodes.indexOf(node);
      if (anchor < 0) selectionAnchor.current = node.key;
      setSelectedKeys(
        new Set(
          nodes
            .slice(anchor < 0 ? end : Math.min(anchor, end), Math.max(anchor, end) + 1)
            .filter((item) => item.entry && item.project.id === node.project.id)
            .map((item) => item.key),
        ),
      );
    } else {
      selectionAnchor.current = node.key;
      setSelectedKeys((current) => {
        if (!(modifiers.metaKey || modifiers.ctrlKey) || !node.entry)
          return new Set(node.entry ? [node.key] : []);
        const next = new Set(
          nodes
            .filter((item) => item.project.id === node.project.id && current.has(item.key))
            .map((item) => item.key),
        );
        if (next.has(node.key)) next.delete(node.key);
        else next.add(node.key);
        return next;
      });
    }
    if (focus) {
      virtualizer.scrollToIndex?.(nodes.indexOf(node));
      scrollRef.current?.focus();
    }
  };
  const moveSelection = (delta: number, shiftKey = false) => {
    const items = nodes.filter(isSelectable);
    if (items.length === 0) return;
    const index = items.findIndex((node) => node.key === selectedKey);
    const next =
      index < 0
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, index + delta));
    selectNode(items[next]!, { shiftKey });
  };
  const selectedNodes = nodes.filter((node) => node.entry && selectedKeys.has(node.key));
  const selectClick = (node: FlatNode, event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".tree-action")) return;
    selectNode(node, event, false);
  };
  const selectModifiedClick = (node: FlatNode, event: React.MouseEvent<HTMLElement>) => {
    if (
      !(event.metaKey || event.ctrlKey || event.shiftKey) ||
      (event.target as HTMLElement).closest(".tree-action, .tree-disclosure")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(node, event);
  };
  const moveHorizontal = (direction: -1 | 1) => {
    const node = nodes.find((item) => item.key === selectedKey);
    if (!node || !isSelectable(node)) return;
    scrollRef.current?.focus();
    const canExpand =
      node.kind === "project" || (node.kind === "directory" && !node.entry?.isSymlink);
    const expanded =
      node.kind === "project"
        ? openProjects.has(node.project.id)
        : node.kind === "directory" && !node.entry?.isSymlink && expandedDirectories.has(node.key);
    if (direction > 0) {
      if (!canExpand) return;
      if (!expanded) {
        if (node.kind === "project") toggleProject(node.project);
        else if (node.entry) toggleDirectory(node.project, node.entry);
        return;
      }
      const firstChild = nodes.find((item) => item.parentKey === node.key && isSelectable(item));
      if (firstChild) selectNode(firstChild);
      return;
    }
    if (expanded) {
      if (node.kind === "project") toggleProject(node.project);
      else if (node.entry) toggleDirectory(node.project, node.entry);
    } else if (node.parentKey) {
      const parent = nodes.find((item) => item.key === node.parentKey);
      if (parent) selectNode(parent);
    }
  };
  const openSelected = () => {
    const node = nodes.find((item) => item.key === selectedKey);
    if (node?.kind === "project") activateProject(node.project);
    else if (node?.kind === "directory" && node.entry) toggleDirectory(node.project, node.entry);
    else if (node?.kind === "file" && node.entry) onOpenFile(node.project, node.entry);
  };

  const openMenu = (node: FlatNode, trigger: HTMLElement, x: number, y: number) => {
    const entries =
      node.entry && selectedKeys.has(node.key)
        ? selectedNodes
            .filter((item) => item.project.id === node.project.id)
            .map((item) => item.entry!)
        : node.entry
          ? [node.entry]
          : [];
    if (!selectedKeys.has(node.key)) selectNode(node, {}, false);
    setMenu({ project: node.project, entry: node.entry, entries, trigger, x, y });
  };
  const contextMenu = (node: FlatNode) => (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const trigger =
      event.currentTarget.querySelector<HTMLElement>(".tree-action") ?? event.currentTarget;
    openMenu(node, trigger, event.clientX, event.clientY);
  };
  const moreButton = (node: FlatNode) => (
    <button
      className="tree-action"
      aria-label={t("{0} 的更多操作", node.entry?.name ?? node.project.name)}
      aria-haspopup="menu"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu(node, event.currentTarget, rect.left, rect.bottom);
      }}
    >
      <MoreHorizontal size={14} />
    </button>
  );

  const submitOperation = async (value: string) => {
    if (!operation) return;
    const result = await onFileOperation(operation, value);
    const results =
      result && "results" in result
        ? result.results
        : [
            {
              source: "entry" in operation ? operation.entry : undefined,
              entry: result || undefined,
            },
          ];
    const failures = results.filter((item) => "error" in item && item.error);
    const completed = results.filter((item) => !("error" in item && item.error));
    const { project } = operation;
    const { id } = project;
    const changedParents = new Set<string>();
    const removed = new Set<string>();
    if ("parentPath" in operation) changedParents.add(operation.parentPath);
    for (const { source, entry } of completed) {
      if (source) {
        changedParents.add(parentPath(source.path));
        if (source.path !== entry?.path) removed.add(directoryKey(id, source.path));
      }
      if (entry) changedParents.add(parentPath(entry.path));
    }

    if (removed.size) {
      const prefix = directoryKey(id, "");
      const removedPaths = [...removed];
      const removedDirectory = (key: string) =>
        removedPaths.some((path) => key === path || key.startsWith(path + "/"));
      // A request started before the move or deletion must not restore the old subtree.
      for (const [key, version] of requestVersions.current) {
        if (removedDirectory(key)) requestVersions.current.set(key, version + 1);
      }
      setDirectories((current) => {
        const next = { ...current };
        for (const [key, listing] of Object.entries(current)) {
          if (!key.startsWith(prefix)) continue;
          if (removedDirectory(key)) delete next[key];
          else if (changedParents.has(key.slice(prefix.length))) {
            const entries = listing.entries.filter(
              (item) => !removed.has(directoryKey(id, item.path)),
            );
            if (entries.length !== listing.entries.length) next[key] = { ...listing, entries };
          }
        }
        return next;
      });
    }
    setExpandedDirectories((current) => {
      const next = new Set<string>();
      for (const key of current) {
        const [projectId, path = ""] = key.split("\u0000");
        const changed =
          projectId === id
            ? completed.find(
                (item) =>
                  item.source &&
                  (path === item.source.path || path.startsWith(item.source.path + "/")),
              )
            : undefined;
        if (changed) {
          if (changed.entry)
            next.add(
              directoryKey(id, changed.entry.path + path.slice(changed.source!.path.length)),
            );
        } else next.add(key);
      }
      for (const { entry } of completed) {
        if (!entry) continue;
        let parent = parentPath(entry.path);
        while (parent) {
          next.add(directoryKey(id, parent));
          parent = parentPath(parent);
        }
      }
      return next;
    });
    setOpenProjects((current) => new Set(current).add(id));
    for (const parent of changedParents) void loadDirectory(project, parent);
    setSelectedKeys(new Set());
    if (failures.length && (operation.kind === "move" || operation.kind === "trash")) {
      const pending = failures.map((item) => item.source!);
      setOperation({ ...operation, entry: pending[0]!, entries: pending });
      throw new Error(
        t("已完成 {0} 项，失败 {1} 项。重试仅处理失败项。\n", completed.length, failures.length) +
          failures
            .map((item) => `${item.source?.path}：${"error" in item ? item.error : ""}`)
            .join("\n"),
      );
    }
  };

  const paste = async (project: Project, parent: string, paths?: string[]) => {
    if (pastingRef.current) return;
    pastingRef.current = true;
    setPasteBusy(true);
    try {
      const result = await (paths ? onPaste(project, parent, paths) : onPaste(project, parent));
      setOpenProjects((current) => new Set(current).add(project.id));
      setExpandedDirectories((current) => {
        const next = new Set(current);
        for (let path = parent; path; path = parentPath(path))
          next.add(directoryKey(project.id, path));
        return next;
      });
      void loadDirectory(project, parent);
      onNotice(
        [
          t("已{0} {1} 项", paths ? t("复制") : t("粘贴"), result.entries.length),
          ...result.failures.map((failure) => `${failure.name}：${failure.message}`),
        ].join("\n"),
      );
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      pastingRef.current = false;
      setPasteBusy(false);
    }
  };

  // Shortcut-driven operations only know the open file's path; the dialogs read little else.
  const entryAt = (path: string): DirEntry => ({
    path,
    name: basename(path),
    isDir: false,
    isSymlink: false,
    ignored: false,
    size: 0,
    modifiedMs: null,
  });
  useImperativeHandle(ref, () => ({
    paste: (project, parent) => void paste(project, parent),
    pasteSelected: (fallback) => {
      const node = nodes.find((item) => item.key === selectedKey);
      const project = node?.project ?? fallback?.project;
      if (!project) return;
      const parent =
        node === undefined
          ? (fallback?.parent ?? "")
          : node.entry && (!node.entry.isDir || node.entry.isSymlink)
            ? parentPath(node.entry.path)
            : (node.entry?.path ?? "");
      void paste(project, parent);
    },
    drop: (project, parent, paths) => paste(project, parent, paths),
    trash: (project, path) =>
      setOperation((current) => current ?? { kind: "trash", project, entry: entryAt(path) }),
    rename: (project, path) =>
      setOperation((current) => current ?? { kind: "rename", project, entry: entryAt(path) }),
    create: (project, parent, isDir) =>
      setOperation(
        (current) =>
          current ?? {
            kind: isDir ? "createDirectory" : "createFile",
            project,
            parentPath: parent,
          },
      ),
  }));

  return (
    <div className="file-tree-pane">
      <div className="pane-heading">
        <span
          data-tooltip={
            t("项目") + (selectedNodes.length > 1 ? t(" · 已选 {0} 项", selectedNodes.length) : "")
          }
        >
          {t("项目")}
          {selectedNodes.length > 1 ? t(" · 已选 {0} 项", selectedNodes.length) : ""}
        </span>
        <button
          className="icon-button"
          onClick={onImport}
          data-tooltip={t("导入项目")}
          aria-label={t("导入项目")}
        >
          <Plus size={15} />
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="pane-empty">
          <Folder size={24} strokeWidth={1.4} />
          <p>{t("还没有导入项目")}</p>
          <button className="button button-small" onClick={onImport}>
            <Plus size={14} />
            {t("导入项目")}
          </button>
        </div>
      ) : (
        <div
          className={`tree-scroll${activeRowVisible ? " has-active-row" : ""}`}
          ref={scrollRef}
          role="tree"
          tabIndex={0}
          aria-label={t("项目文件树")}
          aria-multiselectable="true"
          aria-activedescendant={activeDescendant}
          onKeyDown={(event) => {
            if (event.defaultPrevented) return;
            const shortcut = matchShortcut(event, shortcutBindings);
            if (shortcut === "delete-file" && selectedNodes.length) {
              event.preventDefault();
              setOperation({
                kind: "trash",
                project: selectedNodes[0]!.project,
                entry: selectedNodes[0]!.entry!,
                entries: selectedNodes.map((node) => node.entry!),
              });
              return;
            }
            if (shortcut || event.altKey) return;
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
              event.preventDefault();
              const projectId =
                nodes.find((node) => node.key === selectedKey)?.project.id ?? activeProjectId;
              setSelectedKeys(
                new Set(
                  nodes
                    .filter((node) => node.entry && node.project.id === projectId)
                    .map((node) => node.key),
                ),
              );
              return;
            }
            if (event.metaKey || event.ctrlKey) return;
            if (event.key === " " && selectedKey) {
              event.preventDefault();
              const node = nodes.find((node) => node.key === selectedKey);
              if (node) selectNode(node, { ctrlKey: true });
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveSelection(event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
            } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              moveHorizontal(event.key === "ArrowRight" ? 1 : -1);
            } else if (
              event.key === "Enter" &&
              selectedKey &&
              // A focused row button keeps its own Enter behaviour.
              !(event.target instanceof HTMLButtonElement)
            ) {
              event.preventDefault();
              openSelected();
            }
          }}
        >
          <div className="tree-virtual" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualRow) => {
              const node = nodes[virtualRow.index];
              if (!node) return null;
              const gitStatus = gitStatuses.get(node.project.id)?.get(node.entry?.path ?? "");
              const gitClass = gitStatus ? `git-${gitStatus.kind}` : "";
              const style = {
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: 8 + node.depth * 14,
              };
              if (node.kind === "project") {
                const open = openProjects.has(node.project.id);
                return (
                  <div
                    className={`tree-row project-row ${activeProjectId === node.project.id ? "is-active" : ""} ${(node.entry ? selectedKeys.has(node.key) : selectedKey === node.key && selectedNodes.length === 0) ? "is-selected" : ""} ${selectedKey === node.key ? "is-focused" : ""} ${gitClass}`}
                    key={node.key}
                    style={style}
                    role="treeitem"
                    id={`${treeId}-node-${virtualRow.index}`}
                    aria-level={node.depth + 1}
                    aria-setsize={node.setSize}
                    aria-posinset={node.posInSet}
                    data-drop-project={node.project.id}
                    data-drop-parent=""
                    aria-expanded={open}
                    aria-selected={
                      node.entry
                        ? selectedKeys.has(node.key)
                        : selectedKey === node.key && selectedNodes.length === 0
                    }
                    aria-description={gitStatus?.label}
                    onClick={(event) => selectClick(node, event)}
                    onClickCapture={(event) => selectModifiedClick(node, event)}
                    onContextMenu={contextMenu(node)}
                  >
                    <button
                      className="tree-disclosure"
                      onClick={() => toggleProject(node.project)}
                      aria-label={
                        open ? t("折叠 {0}", node.project.name) : t("展开 {0}", node.project.name)
                      }
                    >
                      {directories[directoryKey(node.project.id, "")]?.status === "loading" ? (
                        <LoaderCircle size={14} className="spin" aria-label={t("读取目录…")} />
                      ) : (
                        <ChevronRight size={14} className={open ? "rotated" : ""} />
                      )}
                    </button>
                    <button
                      className="tree-label"
                      onClick={() => activateProject(node.project)}
                      data-tooltip={`${node.project.root}${gitStatus ? ` · ${gitStatus.label}` : ""}`}
                    >
                      <span className="project-glyph" aria-hidden>
                        {node.project.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="tree-text">{node.project.name}</span>
                    </button>
                    {moreButton(node)}
                  </div>
                );
              }
              if (node.kind === "error") {
                return (
                  <div className="tree-row tree-message tree-error" key={node.key} style={style}>
                    <AlertCircle size={13} />
                    <span data-tooltip={node.message}>{node.message}</span>
                  </div>
                );
              }
              const entry = node.entry!;
              const isActiveFile =
                activeProjectId === node.project.id && activeFilePath === entry.path;
              if (entry.isDir) {
                const open = expandedDirectories.has(node.key);
                return (
                  <div
                    className={`tree-row ${entry.ignored ? "is-ignored" : ""} ${(node.entry ? selectedKeys.has(node.key) : selectedKey === node.key && selectedNodes.length === 0) ? "is-selected" : ""} ${selectedKey === node.key ? "is-focused" : ""} ${gitClass}`}
                    key={node.key}
                    style={style}
                    role="treeitem"
                    id={`${treeId}-node-${virtualRow.index}`}
                    aria-level={node.depth + 1}
                    aria-setsize={node.setSize}
                    aria-posinset={node.posInSet}
                    data-drop-project={node.project.id}
                    data-drop-parent={entry.path}
                    aria-expanded={entry.isSymlink ? undefined : open}
                    aria-selected={
                      node.entry
                        ? selectedKeys.has(node.key)
                        : selectedKey === node.key && selectedNodes.length === 0
                    }
                    aria-description={gitStatus?.label}
                    onClick={(event) => selectClick(node, event)}
                    onClickCapture={(event) => selectModifiedClick(node, event)}
                    onContextMenu={contextMenu(node)}
                  >
                    <button
                      className="tree-disclosure"
                      onClick={() => toggleDirectory(node.project, entry)}
                      aria-label={`${open ? t("折叠") : t("展开")} ${entry.name}`}
                    >
                      {entry.isSymlink ? (
                        <Link2 size={13} />
                      ) : directories[node.key]?.status === "loading" ? (
                        <LoaderCircle size={14} className="spin" aria-label={t("读取目录…")} />
                      ) : (
                        <ChevronRight size={14} className={open ? "rotated" : ""} />
                      )}
                    </button>
                    <button
                      className="tree-label"
                      onClick={() => toggleDirectory(node.project, entry)}
                      data-tooltip={`${entry.isSymlink ? t("不展开符号链接目录") : entry.path}${gitStatus ? ` · ${gitStatus.label}` : ""}`}
                    >
                      {entry.isSymlink ? (
                        <Link2 size={15} />
                      ) : open ? (
                        <FolderOpen size={15} className="icon-folder" />
                      ) : (
                        <Folder size={15} className="icon-folder" />
                      )}
                      <span className="tree-text">{entry.name}</span>
                    </button>
                    {moreButton(node)}
                  </div>
                );
              }
              return (
                <div
                  className={`tree-row file-row ${entry.ignored ? "is-ignored" : ""} ${isActiveFile ? "is-active" : ""} ${(node.entry ? selectedKeys.has(node.key) : selectedKey === node.key && selectedNodes.length === 0) ? "is-selected" : ""} ${selectedKey === node.key ? "is-focused" : ""} ${gitClass}`}
                  key={node.key}
                  style={style}
                  role="treeitem"
                  id={`${treeId}-node-${virtualRow.index}`}
                  aria-level={node.depth + 1}
                  aria-setsize={node.setSize}
                  aria-posinset={node.posInSet}
                  data-drop-project={node.project.id}
                  data-drop-parent={parentPath(entry.path)}
                  aria-selected={
                    node.entry
                      ? selectedKeys.has(node.key)
                      : selectedKey === node.key && selectedNodes.length === 0
                  }
                  aria-description={gitStatus?.label}
                  onClick={(event) => selectClick(node, event)}
                  onClickCapture={(event) => selectModifiedClick(node, event)}
                  onContextMenu={contextMenu(node)}
                >
                  <span className="tree-indent" />
                  <button
                    className="tree-label"
                    onClick={() => onOpenFile(node.project, entry)}
                    data-tooltip={`${entry.path}${gitStatus ? ` · ${gitStatus.label}` : ""}`}
                  >
                    {entry.isSymlink ? <Link2 size={15} /> : <FileIcon name={entry.name} />}
                    <span className="tree-text">{entry.name}</span>
                  </button>
                  {moreButton(node)}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {menu && (
        <FileTreeMenu
          target={menu}
          onClose={closeMenu}
          onOperation={setOperation}
          onRemoveProject={onRemoveProject}
          onPaste={(project, parent) => void paste(project, parent)}
          onNotice={onNotice}
          pasteBusy={pasteBusy}
        />
      )}
      {operation && (
        <FileOperationDialog
          operation={operation}
          onSubmit={submitOperation}
          onClose={() => {
            setOperation(null);
            scrollRef.current?.focus();
          }}
        />
      )}
    </div>
  );
});
