import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
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
  X,
} from "lucide-react";

import { api } from "../lib/api";
import type { DirEntry, PasteResult, Project } from "../lib/types";
import { basename, errorMessage } from "../lib/utils";
import { parentPath } from "../lib/utils";
import { FileIcon } from "./FileIcon";
import {
  FileOperationDialog,
  type FileOperation,
  type FileOperationResult,
} from "./FileOperationDialog";
import { FileTreeMenu, type TreeMenuTarget } from "./FileTreeMenu";
import { useFileTreeGit } from "../git/hooks/useFileTreeGit";

type DirectoryState =
  | { status: "loading"; entries: DirEntry[] }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; entries: DirEntry[]; message: string };

interface FlatNode {
  kind: "project" | "directory" | "file" | "loading" | "error";
  key: string;
  depth: number;
  parentKey: string | null;
  setSize?: number;
  posInSet?: number;
  project: Project;
  entry?: DirEntry;
  message?: string;
}

/** Directories the watcher reported as changed, per project. */
export interface TreeRefresh {
  /** Increments on every filesystem batch; 0 means nothing has changed yet. */
  token: number;
  /** null refreshes every cached listing in the project. */
  directories: Map<string, string[] | null>;
}

interface FileTreeProps {
  projects: Project[];
  activeProjectId: string | null;
  activeFilePath: string | null;
  active: boolean;
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

export interface FileTreeHandle {
  /** Paste clipboard files into `parent` with the same refresh the row menu uses. */
  paste: (project: Project, parent: string) => void;
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
    setDirectories((current) => ({
      ...current,
      [key]:
        current[key]?.status === "loaded"
          ? current[key]
          : { status: "loading", entries: current[key]?.entries ?? [] },
    }));
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
    const project = projects.find((item) => item.id === activeProjectId);
    if (!project) return;
    setOpenProjects((current) => {
      if (current.has(project.id)) return current;
      const next = new Set(current);
      next.add(project.id);
      return next;
    });
  }, [activeProjectId, projects]);

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
      if (!project || (changedDirs !== null && !openProjects.has(project.id))) continue;
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
      if (!state || (state.status === "loading" && state.entries.length === 0)) {
        result.push({
          kind: "loading",
          key: `${key}\u0000loading`,
          depth,
          parentKey,
          project,
        });
        return;
      }
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
  const virtualItems = virtualizer.getVirtualItems();
  const selectedIndex = nodes.findIndex((node) => node.key === selectedKey);
  const activeDescendant =
    selectedIndex >= 0 && virtualItems.some((item) => item.index === selectedIndex)
      ? `${treeId}-node-${selectedIndex}`
      : undefined;

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
      onNotice("为安全起见，文件树不会递归展开符号链接目录。");
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

  const isSelectable = (node: FlatNode) =>
    node.kind === "project" || node.kind === "directory" || node.kind === "file";
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
      aria-label={`${node.entry?.name ?? node.project.name} 的更多操作`}
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
    const id = operation.project.id;

    for (const [key, version] of requestVersions.current) {
      if (key.startsWith(id + "\u0000")) requestVersions.current.set(key, version + 1);
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
    setDirectories((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(id + "\u0000"))),
    );
    setSelectedKeys(new Set());
    if (failures.length && (operation.kind === "move" || operation.kind === "trash")) {
      const pending = failures.map((item) => item.source!);
      setOperation({ ...operation, entry: pending[0]!, entries: pending });
      throw new Error(
        `已完成 ${completed.length} 项，失败 ${failures.length} 项。重试仅处理失败项。\n` +
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
      for (const [key, version] of requestVersions.current) {
        if (key.startsWith(project.id + "\u0000")) requestVersions.current.set(key, version + 1);
      }
      setOpenProjects((current) => new Set(current).add(project.id));
      setExpandedDirectories((current) => {
        const next = new Set(current);
        for (let path = parent; path; path = parentPath(path))
          next.add(directoryKey(project.id, path));
        return next;
      });
      setDirectories((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.startsWith(project.id + "\u0000")),
        ),
      );
      onNotice(
        [
          `已${paths ? "复制" : "粘贴"} ${result.entries.length} 项`,
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
    size: 0,
    modifiedMs: null,
  });
  useImperativeHandle(ref, () => ({
    paste: (project, parent) => void paste(project, parent),
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
        <span>项目{selectedNodes.length > 1 ? ` · 已选 ${selectedNodes.length} 项` : ""}</span>
        <button
          className="icon-button"
          onClick={onImport}
          data-tooltip="导入项目"
          aria-label="导入项目"
        >
          <Plus size={15} />
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="pane-empty">
          <Folder size={24} strokeWidth={1.4} />
          <p>还没有导入项目</p>
          <button className="button button-small" onClick={onImport}>
            <Plus size={14} />
            导入项目
          </button>
        </div>
      ) : (
        <div
          className="tree-scroll"
          ref={scrollRef}
          role="tree"
          tabIndex={0}
          aria-label="项目文件树"
          aria-multiselectable="true"
          aria-activedescendant={activeDescendant}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.altKey) return;
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
            if ((event.key === "Delete" || event.key === "Backspace") && selectedNodes.length) {
              event.preventDefault();
              event.stopPropagation();
              setOperation({
                kind: "trash",
                project: selectedNodes[0]!.project,
                entry: selectedNodes[0]!.entry!,
                entries: selectedNodes.map((node) => node.entry!),
              });
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
                      aria-label={open ? `折叠 ${node.project.name}` : `展开 ${node.project.name}`}
                    >
                      <ChevronRight size={14} className={open ? "rotated" : ""} />
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
                    <button
                      className="tree-action"
                      onClick={() => onRemoveProject(node.project)}
                      data-tooltip={`从工作区移除 ${node.project.name}`}
                      aria-label={`从工作区移除 ${node.project.name}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              }
              if (node.kind === "loading") {
                return (
                  <div className="tree-row tree-message" key={node.key} style={style}>
                    <LoaderCircle size={13} className="spin" />
                    <span>读取目录…</span>
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
                    className={`tree-row ${(node.entry ? selectedKeys.has(node.key) : selectedKey === node.key && selectedNodes.length === 0) ? "is-selected" : ""} ${selectedKey === node.key ? "is-focused" : ""} ${gitClass}`}
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
                      aria-label={`${open ? "折叠" : "展开"} ${entry.name}`}
                    >
                      {entry.isSymlink ? (
                        <Link2 size={13} />
                      ) : (
                        <ChevronRight size={14} className={open ? "rotated" : ""} />
                      )}
                    </button>
                    <button
                      className="tree-label"
                      onClick={() => toggleDirectory(node.project, entry)}
                      data-tooltip={`${entry.isSymlink ? "不展开符号链接目录" : entry.path}${gitStatus ? ` · ${gitStatus.label}` : ""}`}
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
                  className={`tree-row file-row ${isActiveFile ? "is-active" : ""} ${(node.entry ? selectedKeys.has(node.key) : selectedKey === node.key && selectedNodes.length === 0) ? "is-selected" : ""} ${selectedKey === node.key ? "is-focused" : ""} ${gitClass}`}
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
