import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, LoaderCircle, RotateCcw, Search, SearchX } from "lucide-react";

import type { RevealRequest } from "./CodeReader";
import type {
  Project,
  ReplaceApplyRequest,
  ReplaceApplyResult,
  ReplacePreview,
  SearchHit,
  SearchOptions,
  ToolCapabilities,
} from "../lib/types";
import { tabKey } from "../lib/utils";
import { useSearch } from "../lib/useSearch";
import { errorMessage } from "../lib/utils";
import { DEFAULT_PREFERENCES, type Preferences } from "../lib/preferences";

interface SearchPanelProps {
  preferences?: Preferences;
  active: boolean;
  focusSignal: number;
  capabilities: ToolCapabilities | null;
  projects?: Project[];
  activeProjectId?: string | null;
  onOpenLocation: (projectId: string, path: string, request: Omit<RevealRequest, "nonce">) => void;
  onPreviewReplace?: (
    query: string,
    replacement: string,
    options: SearchOptions,
  ) => Promise<ReplacePreview>;
  onApplyReplace?: (request: ReplaceApplyRequest) => Promise<ReplaceApplyResult>;
  onUndoReplace?: () => Promise<ReplaceApplyResult>;
  onCancelReplace?: () => void;
}

const parseGlobs = (value: string) =>
  value
    .split(/[\n,]+/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);

export function SearchPanel({
  preferences = DEFAULT_PREFERENCES,
  active,
  focusSignal,
  capabilities,
  projects = [],
  activeProjectId = null,
  onOpenLocation,
  onPreviewReplace,
  onApplyReplace,
  onUndoReplace,
  onCancelReplace,
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [scope, setScope] = useState<"all" | "current">("all");
  const [includeGlobs, setIncludeGlobs] = useState("");
  const [excludeGlobs, setExcludeGlobs] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replacePreview, setReplacePreview] = useState<ReplacePreview | null>(null);
  const [replaceBusy, setReplaceBusy] = useState<"preview" | "apply" | "undo" | null>(null);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [replaceError, setReplaceError] = useState("");
  const [replaceMessage, setReplaceMessage] = useState("");
  const replaceRequest = useRef(0);
  const applyingRef = useRef(false);
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const controlsLocked = replaceBusy !== null || replacePreview !== null;
  useEffect(() => {
    setCaseSensitive(preferences.searchCaseSensitive);
    setRegex(preferences.searchRegex);
    setIncludeIgnored(preferences.searchIgnored);
    setIncludeHidden(preferences.searchHidden);
  }, [
    preferences.searchCaseSensitive,
    preferences.searchRegex,
    preferences.searchIgnored,
    preferences.searchHidden,
  ]);
  const options = useMemo<SearchOptions>(
    () => ({
      caseSensitive,
      regex,
      includeIgnored,
      includeHidden,
      projectIds: scope === "current" && activeProjectId ? [activeProjectId] : [],
      includeGlobs: parseGlobs(includeGlobs),
      excludeGlobs: parseGlobs(excludeGlobs),
    }),
    [
      activeProjectId,
      caseSensitive,
      excludeGlobs,
      includeGlobs,
      includeHidden,
      includeIgnored,
      regex,
      scope,
    ],
  );
  const enabled =
    capabilities?.rgAvailable !== false && (scope === "all" || activeProjectId !== null);
  const { state, loadMore, cancel, retry } = useSearch({ query, options, enabled });

  useEffect(() => {
    if (active && focusSignal > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [active, focusSignal]);

  const cancelPreview = useCallback(() => {
    if (applyingRef.current) return;
    replaceRequest.current += 1;
    onCancelReplace?.();
    setReplacePreview(null);
    setSelectedFiles(new Set());
    setReplaceBusy(null);
    setReplaceError("");
    setReplaceMessage("");
  }, [onCancelReplace]);

  useEffect(() => {
    cancelPreview();
  }, [query, replacement, options, cancelPreview]);

  useEffect(() => {
    if (!active && !applyingRef.current) cancelPreview();
  }, [active, cancelPreview]);

  useEffect(
    () => () => {
      replaceRequest.current += 1;
      onCancelReplace?.();
    },
    [onCancelReplace],
  );

  const previewReplacement = async () => {
    if (!onPreviewReplace || !query.trim()) return;
    const request = ++replaceRequest.current;
    setReplaceBusy("preview");
    setReplaceError("");
    setReplaceMessage("");
    try {
      const preview = await onPreviewReplace(query, replacement, options);
      if (request === replaceRequest.current) {
        setReplacePreview(preview);
        setSelectedFiles(new Set(preview.files.map((file) => tabKey(file.projectId, file.path))));
      }
    } catch (error) {
      if (request === replaceRequest.current) setReplaceError(errorMessage(error));
    } finally {
      if (request === replaceRequest.current) setReplaceBusy(null);
    }
  };

  const applyReplacement = async () => {
    if (!onApplyReplace || !replacePreview || replacePreview.truncated || applyingRef.current)
      return;
    applyingRef.current = true;
    setReplaceBusy("apply");
    setReplaceError("");
    setReplaceMessage("");
    try {
      const result = await onApplyReplace({
        query,
        replacement,
        options,
        targets: replacePreview.files
          .filter((file) => selectedFiles.has(tabKey(file.projectId, file.path)))
          .map(({ projectId, path, fingerprint }) => ({ projectId, path, fingerprint })),
      });
      const outcomes = result.outcomes;
      const applied = outcomes.reduce(
        (count, item) => count + (item.status === "applied" ? item.matchCount : 0),
        0,
      );
      if (applied > 0) setUndoAvailable(true);
      setReplaceMessage(`已替换 ${applied} 处；${outcomes.length} 个文件已处理。`);
      const failures = outcomes.filter((item) => item.status !== "applied");
      if (failures.length > 0)
        setReplaceError(
          failures.map((item) => `${item.path}：${item.message ?? item.status}`).join("\n"),
        );
    } catch (error) {
      setReplaceError(errorMessage(error));
    } finally {
      onCancelReplace?.();
      applyingRef.current = false;
      setReplacePreview(null);
      setSelectedFiles(new Set());
      setReplaceBusy(null);
    }
  };

  const undoReplacement = async () => {
    if (!onUndoReplace || !undoAvailable || applyingRef.current) return;
    applyingRef.current = true;
    setReplaceBusy("undo");
    setReplaceError("");
    setReplaceMessage("");
    try {
      const result = await onUndoReplace();
      const restored = result.outcomes.filter((item) => item.status === "applied").length;
      const failures = result.outcomes.filter((item) => item.status !== "applied");
      setUndoAvailable(failures.length > 0);
      setReplaceMessage(`已恢复 ${restored} 个文件。`);
      if (failures.length > 0)
        setReplaceError(
          failures.map((item) => `${item.path}：${item.message ?? item.status}`).join("\n"),
        );
    } catch (error) {
      setReplaceError(errorMessage(error));
    } finally {
      applyingRef.current = false;
      setReplaceBusy(null);
    }
  };

  const openHit = (hit: SearchHit) => {
    const range = hit.ranges[0];
    onOpenLocation(hit.projectId, hit.path, {
      line: hit.line,
      character: range?.start ?? 0,
      endLine: hit.line,
      endCharacter: range?.end ?? 0,
    });
  };
  const activeProject = projects.find((project) => project.id === activeProjectId);

  return (
    <div className="search-panel">
      <div className="pane-heading">
        <span>全局搜索</span>
        {state.received > 0 && <span className="pane-count">{state.results.length}</span>}
      </div>
      <div className="search-input-wrap">
        <Search size={14} className="search-input-icon" />
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
              setQuery("");
            }
          }}
          placeholder="在工作区中搜索"
          aria-label="在工作区中搜索"
          disabled={!enabled || controlsLocked}
          spellCheck={false}
        />
        {state.status === "running" && <LoaderCircle size={13} className="spin search-spinner" />}
      </div>
      <div className="search-options" aria-label="搜索选项">
        <button
          className={`option-toggle ${caseSensitive ? "is-on" : ""}`}
          onClick={() => setCaseSensitive((value) => !value)}
          aria-pressed={caseSensitive}
          data-tooltip="区分大小写"
          aria-label="区分大小写"
          disabled={!enabled || controlsLocked}
        >
          Aa
        </button>
        <button
          className={`option-toggle ${regex ? "is-on" : ""}`}
          onClick={() => setRegex((value) => !value)}
          aria-pressed={regex}
          data-tooltip="使用正则表达式"
          aria-label="使用正则表达式"
          disabled={!enabled || controlsLocked}
        >
          .*
        </button>
        <span className="option-divider" />
        <button
          className={`option-toggle option-text ${includeHidden ? "is-on" : ""}`}
          onClick={() => setIncludeHidden((value) => !value)}
          aria-pressed={includeHidden}
          data-tooltip="包含隐藏文件"
          aria-label="包含隐藏文件"
          disabled={!enabled || controlsLocked}
        >
          隐藏
        </button>
        <button
          className={`option-toggle option-text ${includeIgnored ? "is-on" : ""}`}
          onClick={() => setIncludeIgnored((value) => !value)}
          aria-pressed={includeIgnored}
          data-tooltip="包含被 .gitignore 忽略的文件"
          aria-label="包含被 .gitignore 忽略的文件"
          disabled={!enabled || controlsLocked}
        >
          忽略
        </button>
      </div>
      <div className="search-scope">
        <select
          aria-label="搜索范围"
          value={scope}
          disabled={controlsLocked}
          onChange={(event) => setScope(event.target.value as "all" | "current")}
        >
          <option value="all">全部项目</option>
          <option value="current" disabled={!activeProject}>
            当前项目{activeProject ? `：${activeProject.name}` : ""}
          </option>
        </select>
        <input
          className="search-input"
          aria-label="包含文件"
          placeholder="包含 glob，如 src/**, *.ts"
          value={includeGlobs}
          disabled={controlsLocked}
          onChange={(event) => setIncludeGlobs(event.target.value)}
          spellCheck={false}
        />
        <input
          className="search-input"
          aria-label="排除文件"
          placeholder="排除 glob，如 dist/**, *.log"
          value={excludeGlobs}
          disabled={controlsLocked}
          onChange={(event) => setExcludeGlobs(event.target.value)}
          spellCheck={false}
        />
      </div>

      {onPreviewReplace && onApplyReplace && (
        <div className="replace-box">
          <input
            className="search-input"
            aria-label="替换为"
            placeholder="替换为"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            disabled={!enabled || controlsLocked}
            spellCheck={false}
          />
          <div className="replace-actions">
            <button
              className="button button-small"
              onClick={() => void previewReplacement()}
              disabled={!enabled || !query.trim() || replaceBusy !== null}
            >
              {replaceBusy === "preview" ? <LoaderCircle size={13} className="spin" /> : "预览替换"}
            </button>
            <button
              className="button button-small button-primary"
              onClick={() => void applyReplacement()}
              disabled={
                !enabled ||
                replaceBusy !== null ||
                !replacePreview ||
                replacePreview.truncated ||
                selectedFiles.size === 0
              }
            >
              {replaceBusy === "apply" ? <LoaderCircle size={13} className="spin" /> : "应用替换"}
            </button>
            {undoAvailable && onUndoReplace && (
              <button
                className="button button-small"
                onClick={() => void undoReplacement()}
                disabled={replaceBusy !== null}
              >
                {replaceBusy === "undo" ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  "撤销上次替换"
                )}
              </button>
            )}
            {(replacePreview || replaceBusy === "preview") && (
              <button
                className="button button-small"
                onClick={cancelPreview}
                disabled={replaceBusy === "apply"}
              >
                取消替换
              </button>
            )}
          </div>
          {replacePreview && (
            <div className="replace-preview">
              <p>
                {replacePreview.files.length} 个文件，
                {replacePreview.files.reduce((count, file) => count + file.matchCount, 0)} 处匹配
              </p>
              {replacePreview.truncated && (
                <p className="search-truncated">结果过多，已禁止应用；请缩小范围。</p>
              )}
              <p>已选择 {selectedFiles.size} 个文件</p>
              {replacePreview.files.map((file) => (
                <div className="replace-file" key={`${file.projectId}:${file.path}`}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`替换 ${file.projectId}/${file.path}`}
                      checked={selectedFiles.has(tabKey(file.projectId, file.path))}
                      disabled={replaceBusy !== null || replacePreview.truncated}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelectedFiles((current) => {
                          const next = new Set(current);
                          const key = tabKey(file.projectId, file.path);
                          if (checked) next.add(key);
                          else next.delete(key);
                          return next;
                        });
                      }}
                    />
                    <strong>
                      {file.path} · {file.matchCount}
                    </strong>
                  </label>
                  {file.lines.map((line, index) => (
                    <div className="replace-lines" key={index}>
                      <span>- {line.before}</span>
                      <span>+ {line.after}</span>
                    </div>
                  ))}
                </div>
              ))}
              {replacePreview.skipped.map((item, index) => (
                <p className="replace-warning" key={index}>
                  {item.path}：{item.reason}
                </p>
              ))}
            </div>
          )}
          {replaceMessage && <p className="replace-ok">{replaceMessage}</p>}
          {replaceError && (
            <p className="replace-warning" role="alert">
              {replaceError}
            </p>
          )}
        </div>
      )}

      {!enabled ? (
        <div className="pane-message">
          <AlertCircle size={20} />
          <p>未找到 ripgrep（rg）</p>
          <span>请安装 ripgrep，或在应用配置文件的 tools.rg 中填写路径。</span>
        </div>
      ) : state.status === "error" ? (
        <div className="pane-message pane-message-error" role="alert">
          <AlertCircle size={20} />
          <p>搜索失败</p>
          <span>{state.error}</span>
          <button className="button button-small" onClick={retry}>
            <RotateCcw size={13} />
            重试
          </button>
        </div>
      ) : query.trim().length === 0 ? (
        <div className="pane-message">
          <SearchX size={22} strokeWidth={1.4} />
          <p>搜索项目内容</p>
          <span>使用普通文本或正则表达式，结果会随输入流式出现。</span>
        </div>
      ) : (
        <>
          <SearchResultList
            hits={state.results}
            waiting={
              state.status === "waiting" ||
              (state.status === "running" && state.results.length === 0)
            }
            onOpen={openHit}
          />
          <div className="search-footer">
            <span>
              {state.status === "paused"
                ? `已加载 ${state.received.toLocaleString()} 条`
                : state.status === "done"
                  ? `${state.received.toLocaleString()} 条结果`
                  : state.status === "running"
                    ? "搜索中…"
                    : "等待输入"}
            </span>
            {state.truncated && <span className="search-truncated">已达到结果上限</span>}
            {state.status === "paused" && (
              <button className="button button-small" onClick={loadMore}>
                加载更多
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface SearchResultListProps {
  hits: SearchHit[];
  waiting: boolean;
  onOpen: (hit: SearchHit) => void;
}

function SearchResultList({ hits, waiting, onOpen }: SearchResultListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 62,
    overscan: 12,
  });

  if (waiting && hits.length === 0) {
    return (
      <div className="pane-message">
        <LoaderCircle size={20} className="spin" />
        <p>正在搜索…</p>
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="pane-message">
        <SearchX size={22} strokeWidth={1.4} />
        <p>没有找到匹配内容</p>
        <span>尝试更短的文本，或打开“隐藏/忽略”。</span>
      </div>
    );
  }

  return (
    <div className="search-results" ref={scrollRef} role="list" aria-label="搜索结果">
      <div className="search-results-virtual" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const hit = hits[row.index];
          if (!hit) return null;
          return (
            <button
              className="search-result"
              key={`${hit.projectId}:${hit.path}:${hit.line}:${row.index}`}
              style={{ transform: `translateY(${row.start}px)` }}
              onClick={() => onOpen(hit)}
              role="listitem"
              data-tooltip={`${hit.projectName}/${hit.path}:${hit.line + 1}`}
            >
              <span className="search-result-location">
                <span className="search-project">{hit.projectName}</span>
                <span className="search-file">{hit.path}</span>
                <span className="search-line">:{hit.line + 1}</span>
              </span>
              <span className="search-preview">{renderHighlighted(hit)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function renderHighlighted(hit: SearchHit) {
  if (hit.ranges.length === 0) return hit.preview;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const serverRanges = [...hit.ranges].sort((left, right) => left.start - right.start);
  for (const [index, range] of serverRanges.entries()) {
    const start = Math.max(cursor, Math.min(range.start, hit.preview.length));
    const end = Math.max(start, Math.min(range.end, hit.preview.length));
    if (start > cursor) parts.push(hit.preview.slice(cursor, start));
    if (end > start) {
      parts.push(<mark key={index}>{hit.preview.slice(start, end)}</mark>);
    }
    cursor = end;
  }
  if (cursor < hit.preview.length) parts.push(hit.preview.slice(cursor));
  return parts.length > 0 ? parts : hit.preview;
}
