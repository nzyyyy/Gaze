import { t, useLanguage } from "../lib/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileSearch, LoaderCircle, SearchX } from "lucide-react";

import { api } from "../lib/platform/api";
import { matchesNavigationQuery, parseFileQuery } from "../lib/search/navigationSearch";
import type { RecentFile } from "../lib/workspace/session";
import { shortcutLabel } from "../lib/shortcuts";
import type { Project, SymbolLocation } from "../lib/types";
import { useModalFocus } from "../lib/ui/useModalFocus";
import { basename, errorMessage } from "../lib/utils";
import { CodeLocationPreview, type ReadPreviewText } from "./CodeLocationPreview";
import { FileIcon } from "./FileIcon";
import "./QuickOpen.css";

const MODES = ["files", "symbols", "actions", "locations"] as const;
type Mode = (typeof MODES)[number];

export interface PaletteAction {
  label: string;
  shortcut?: string | null;
  run: () => void;
}

type Result =
  | { type: "file"; location: RecentFile; projectName: string }
  | { type: "symbol"; location: SymbolLocation; projectName: string }
  | { type: "action"; action: PaletteAction };

interface SearchResult {
  key: string;
  rows: Result[];
  message?: string | null;
  indexing?: boolean;
  error?: string;
}

interface QuickOpenProps {
  projects: readonly Project[];
  project: Project | null;
  recentFiles: readonly RecentFile[];
  locations: readonly RecentFile[];
  actions: readonly PaletteAction[];
  readText: ReadPreviewText;
  onClose: () => void;
  onOpen: (location: RecentFile) => void;
  onOpenSymbol: (location: SymbolLocation) => void;
  onImport: () => void;
}

export function QuickOpen({
  projects,
  project,
  recentFiles,
  locations,
  actions,
  readText,
  onClose,
  onOpen,
  onOpenSymbol,
  onImport,
}: QuickOpenProps) {
  useLanguage();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("files");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [indexRevision, setIndexRevision] = useState(0);
  const fileQuery = parseFileQuery(query);
  const projectId = project?.id;
  const projectName = project?.name;
  const showRecent = mode === "files" && !query.trim() && recentFiles.length > 0;
  const pathQuery = mode === "files" && !showRecent && projects.length > 0 ? fileQuery.path : null;
  const symbolQuery = mode === "symbols" && projectId ? query.trim() : "";
  const searchKey =
    pathQuery !== null
      ? JSON.stringify(["files", pathQuery, indexRevision])
      : symbolQuery
        ? JSON.stringify(["symbols", projectId, symbolQuery])
        : null;
  const response = search?.key === searchKey ? search : null;
  const loading = searchKey !== null && !response;

  useModalFocus(dialogRef, inputRef);

  useEffect(() => {
    if (mode !== "files" || projects.length === 0) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void api
      .onPathIndexStatus((status) => {
        if (!disposed && !status.indexing) setIndexRevision((value) => value + 1);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [mode, projects.length]);

  useEffect(() => {
    if (searchKey === null) return;
    let disposed = false;
    const timer = window.setTimeout(
      async () => {
        try {
          if (pathQuery !== null) {
            const result = await api.searchPaths(pathQuery);
            if (!disposed)
              setSearch({
                key: searchKey,
                rows: result.hits.map((location) => ({
                  type: "file",
                  location,
                  projectName: location.projectName,
                })),
                message: result.message,
                indexing: result.indexing,
              });
          } else if (projectId) {
            const result = await api.searchSymbols(projectId, symbolQuery);
            if (!disposed)
              setSearch({
                key: searchKey,
                rows: result.symbols.map((location) => ({
                  type: "symbol",
                  location,
                  projectName: projectName ?? "",
                })),
                message: result.message,
                indexing: result.indexing,
              });
          }
        } catch (reason) {
          if (!disposed) setSearch({ key: searchKey, rows: [], error: errorMessage(reason) });
        }
      },
      pathQuery === "" ? 0 : 100,
    );
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [pathQuery, projectId, projectName, searchKey, symbolQuery]);

  const recentRows = (items: readonly RecentFile[]) =>
    items.flatMap((location): Result[] => {
      const project = projects.find(({ id }) => id === location.projectId);
      return project && matchesNavigationQuery(`${project.name} ${location.path}`, query.trim())
        ? [{ type: "file", location, projectName: project.name }]
        : [];
    });
  const results: Result[] =
    mode === "actions"
      ? actions
          .filter(({ label, shortcut }) =>
            matchesNavigationQuery(
              `${label} ${shortcut ? shortcutLabel(shortcut) : ""}`,
              query.trim(),
            ),
          )
          .map((action) => ({ type: "action", action }))
      : mode === "locations"
        ? recentRows(locations)
        : showRecent
          ? recentRows(recentFiles)
          : (response?.rows ?? []);
  const activeIndex = Math.min(selected, Math.max(0, results.length - 1));
  const active = results[activeIndex];
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });
  const rows = virtualizer.getVirtualItems();

  useEffect(() => {
    if (results.length > 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, results.length, virtualizer]);

  const selectMode = (next: Mode) => {
    setMode(next);
    setSelected(0);
    inputRef.current?.focus();
  };
  const choose = (row: Result | undefined) => {
    if (!row) return;
    if (row.type === "action") {
      row.action.run();
      return;
    }
    onClose();
    if (row.type === "symbol") onOpenSymbol(row.location);
    else
      onOpen({
        ...row.location,
        position: (mode === "files" && fileQuery.position) || row.location.position,
      });
  };
  const labels = {
    files: t("文件"),
    symbols: t("符号"),
    actions: t("操作"),
    locations: t("最近位置"),
  };
  const placeholder = {
    files: t("输入文件名、路径或路径:行:列"),
    symbols: t("搜索项目符号"),
    actions: t("搜索操作"),
    locations: t("筛选最近位置"),
  }[mode];

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="quick-open"
        role="dialog"
        aria-modal="true"
        aria-label={t("快速打开")}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="quick-open-input-row">
          <FileSearch size={17} className="quick-open-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected(
                  Math.min(
                    Math.max(0, activeIndex + (event.key === "ArrowDown" ? 1 : -1)),
                    Math.max(0, results.length - 1),
                  ),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(active);
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={results.length > 0 ? `${id}-results` : undefined}
            aria-activedescendant={
              rows.some((row) => row.index === activeIndex) ? `${id}-row-${activeIndex}` : undefined
            }
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {(loading || response?.indexing) && (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          )}
          <kbd className="palette-key">Esc</kbd>
        </div>

        <div className="navigation-modes" role="group" aria-label={t("搜索类别")}>
          {MODES.map((item) => (
            <button key={item} aria-pressed={item === mode} onClick={() => selectMode(item)}>
              {labels[item]}
            </button>
          ))}
        </div>

        {results.length > 0 ? (
          <div
            className="palette-results"
            ref={listRef}
            id={`${id}-results`}
            role="listbox"
            aria-label={labels[mode]}
          >
            <div className="palette-results-virtual" style={{ height: virtualizer.getTotalSize() }}>
              {rows.map((row) => {
                const item = results[row.index]!;
                const location = item.type === "action" ? null : item.location;
                const detail =
                  item.type === "symbol"
                    ? `${item.location.path}:${item.location.line + 1}`
                    : item.type === "file"
                      ? item.location.path +
                        (item.location.position ? `:${item.location.position.line + 1}` : "")
                      : null;
                return (
                  <button
                    className={`palette-result ${activeIndex === row.index ? "is-selected" : ""}`}
                    key={row.key}
                    id={`${id}-row-${row.index}`}
                    tabIndex={-1}
                    style={{ transform: `translateY(${row.start}px)` }}
                    role="option"
                    aria-selected={activeIndex === row.index}
                    title={detail ?? undefined}
                    onMouseEnter={() => setSelected(row.index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                  >
                    {location && <FileIcon name={basename(location.path)} size={15} />}
                    {item.type !== "action" && (
                      <span className="palette-project">{item.projectName}</span>
                    )}
                    {(item.type === "symbol" || item.type === "action") && (
                      <span className="palette-label">
                        {item.type === "symbol" ? item.location.name : item.action.label}
                      </span>
                    )}
                    {detail && <span className="palette-path">{detail}</span>}
                    {item.type === "action" && item.action.shortcut && (
                      <kbd className="palette-key">{shortcutLabel(item.action.shortcut)}</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className={`palette-empty${response?.error ? " palette-error" : ""}`} role="status">
            {loading || response?.indexing ? (
              <p>{mode === "symbols" ? t("正在读取符号…") : t("正在搜索文件…")}</p>
            ) : mode === "files" && projects.length === 0 ? (
              <>
                <SearchX size={24} strokeWidth={1.4} />
                <p>{t("工作区中还没有项目")}</p>
                <button
                  className="button button-small"
                  onClick={() => {
                    onClose();
                    onImport();
                  }}
                >
                  {t("导入项目")}
                </button>
              </>
            ) : (
              <p>
                {response?.error ??
                  response?.message ??
                  (mode === "symbols" && !project
                    ? t("工作区中还没有项目")
                    : mode === "symbols" && !query.trim()
                      ? t("输入符号名称")
                      : mode === "locations" && !query.trim()
                        ? t("尚无最近位置")
                        : t("没有匹配的结果"))}
              </p>
            )}
          </div>
        )}

        {mode === "locations" && active?.type === "file" && active.location.position && (
          <CodeLocationPreview
            key={JSON.stringify([active.location.projectId, active.location.path])}
            location={active.location}
            readText={readText}
          />
        )}
        <div className="quick-open-footer">
          <span>
            {(mode === "symbols" && projectName) ||
              (showRecent ? t("最近文件") : (response?.message ?? t("{0} 个结果", results.length)))}
          </span>
          <span className="palette-hints">
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("导航")} <kbd>↵</kbd> {mode === "actions" ? t("执行") : t("打开")}
          </span>
        </div>
      </div>
    </div>
  );
}
