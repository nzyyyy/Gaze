import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Boxes, LoaderCircle, Search, Workflow } from "lucide-react";

import type { EditorTab, RevealRequest } from "./CodeReader";
import { api } from "../lib/api";
import type {
  DocumentSymbol,
  OutlineResult,
  Project,
  SymbolLocation,
  SymbolSearchResult,
} from "../lib/types";
import { errorMessage } from "../lib/utils";

interface SymbolPanelProps {
  active: boolean;
  project: Project | null;
  activeTab: EditorTab | null;
  refreshToken: number;
  navigationBusy: boolean;
  onOpenLocation: (projectId: string, path: string, request: Omit<RevealRequest, "nonce">) => void;
  onFindImplementations: () => void;
  onNotice: (message: string) => void;
}

interface FlatSymbol {
  key: string;
  symbol: DocumentSymbol;
  depth: number;
}

export function SymbolPanel({
  active,
  project,
  activeTab,
  refreshToken,
  navigationBusy,
  onOpenLocation,
  onFindImplementations,
  onNotice,
}: SymbolPanelProps) {
  const [outline, setOutline] = useState<OutlineResult | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<SymbolSearchResult | null>(null);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [symbolsError, setSymbolsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!activeTab || !active) return;
    let cancelled = false;
    setOutlineLoading(true);
    setOutlineError(null);
    api
      .getOutline(activeTab.projectId, activeTab.path)
      .then((result) => {
        if (cancelled) return;
        setOutline(result);
        setOutlineLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOutlineError(errorMessage(error));
        setOutlineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeTab, refreshToken]);

  useEffect(() => {
    if (!project || !query.trim()) {
      setSymbols(null);
      setSymbolsError(null);
      setSymbolsLoading(false);
      return;
    }
    let cancelled = false;
    setSymbolsLoading(true);
    setSymbolsError(null);
    const timer = window.setTimeout(() => {
      api
        .searchSymbols(project.id, query)
        .then((result) => {
          if (cancelled) return;
          setSymbols(result);
          setSymbolsLoading(false);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setSymbolsError(errorMessage(error));
          setSymbolsLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project, query]);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const flatOutline = useMemo(() => flattenOutline(outline?.symbols ?? []), [outline]);
  const showSearch = query.trim().length > 0;

  const openSymbol = (symbol: SymbolLocation | DocumentSymbol) => {
    if (!project && "projectId" in symbol) {
      onNotice("该项目已不在工作区中。");
      return;
    }
    const projectId = "projectId" in symbol ? symbol.projectId : project?.id;
    if (!projectId) return;
    const path = "path" in symbol ? symbol.path : activeTab?.path;
    if (!path) return;
    onOpenLocation(projectId, path, {
      line: symbol.line,
      character: symbol.character,
      endLine: symbol.endLine,
      endCharacter: symbol.endCharacter,
    });
  };

  return (
    <div className="symbol-panel">
      <div className="pane-heading">
        <span>符号</span>
        <button
          className="icon-button"
          onClick={onFindImplementations}
          disabled={!activeTab || navigationBusy}
          data-tooltip="查找光标位置的实现"
          aria-label="查找实现"
        >
          {navigationBusy ? <LoaderCircle size={14} className="spin" /> : <Workflow size={15} />}
        </button>
      </div>
      <div className="search-input-wrap symbol-search-wrap">
        <Search size={14} className="search-input-icon" />
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
            }
          }}
          placeholder="搜索项目符号"
          aria-label="搜索项目符号"
          spellCheck={false}
          disabled={!project}
        />
        {symbolsLoading && <LoaderCircle size={13} className="spin search-spinner" />}
      </div>

      {showSearch ? (
        <ProjectSymbolResults
          result={symbols}
          loading={symbolsLoading}
          error={symbolsError}
          onOpen={openSymbol}
        />
      ) : (
        <>
          <div className="symbol-section-heading">
            <span>当前文件大纲</span>
            {outline && (
              <span className={`source-badge ${outline.source}`}>
                {outline.source === "lsp" ? "LSP 精确" : "ctags 文本"}
              </span>
            )}
          </div>
          {outline?.message && activeTab && <div className="symbol-message">{outline.message}</div>}
          {outlineLoading ? (
            <div className="pane-message">
              <LoaderCircle size={20} className="spin" />
              <p>正在读取符号…</p>
            </div>
          ) : outlineError ? (
            <div className="pane-message pane-message-error">
              <AlertCircle size={20} />
              <p>无法读取大纲</p>
              <span>{outlineError}</span>
            </div>
          ) : !activeTab ? (
            <div className="pane-message">
              <Boxes size={23} strokeWidth={1.4} />
              <p>没有打开的文件</p>
              <span>打开文件后查看当前文件大纲。</span>
            </div>
          ) : flatOutline.length === 0 ? (
            <div className="pane-message">
              <Boxes size={23} strokeWidth={1.4} />
              <p>没有可显示的符号</p>
              <span>该文件可能没有受支持的符号，或符号工具不可用。</span>
            </div>
          ) : (
            <OutlineList
              symbols={flatOutline}
              project={project}
              onOpen={(symbol) => openSymbol(symbol)}
            />
          )}
        </>
      )}
    </div>
  );
}

function OutlineList({
  symbols,
  onOpen,
}: {
  symbols: FlatSymbol[];
  project: Project | null;
  onOpen: (symbol: DocumentSymbol) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: symbols.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });
  return (
    <div className="symbol-results" ref={scrollRef} role="tree" aria-label="文件大纲">
      <div className="symbol-virtual" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const entry = symbols[row.index];
          if (!entry) return null;
          return (
            <button
              className="symbol-row"
              key={entry.key}
              style={{
                transform: `translateY(${row.start}px)`,
                paddingLeft: 10 + entry.depth * 13,
              }}
              onClick={() => onOpen(entry.symbol)}
              data-tooltip={entry.symbol.detail ?? entry.symbol.name}
            >
              <span className={`kind-glyph kind-${entry.symbol.kind.toLowerCase()}`}>
                {entry.symbol.kind.slice(0, 1).toUpperCase()}
              </span>
              <span className="symbol-name">{entry.symbol.name}</span>
              <span className="symbol-detail">{entry.symbol.detail ?? entry.symbol.kind}</span>
              <span className="symbol-line">{entry.symbol.line + 1}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProjectSymbolResults({
  result,
  loading,
  error,
  onOpen,
}: {
  result: SymbolSearchResult | null;
  loading: boolean;
  error: string | null;
  onOpen: (symbol: SymbolLocation) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const symbols = useMemo(() => result?.symbols ?? [], [result]);
  const virtualizer = useVirtualizer({
    count: symbols.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 43,
    overscan: 12,
  });

  if (loading) {
    return (
      <div className="pane-message">
        <LoaderCircle size={20} className="spin" />
        <p>正在索引并搜索符号…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="pane-message pane-message-error">
        <AlertCircle size={20} />
        <p>符号搜索失败</p>
        <span>{error}</span>
      </div>
    );
  }
  if (symbols.length === 0) {
    return (
      <div className="pane-message">
        <Boxes size={23} strokeWidth={1.4} />
        <p>没有匹配的符号</p>
        <span>{result?.message ?? "尝试更短或更准确的符号名。"}</span>
      </div>
    );
  }
  return (
    <>
      {result?.message && <div className="symbol-message">{result.message}</div>}
      <div className="symbol-results" ref={scrollRef} role="list" aria-label="项目符号搜索结果">
        <div className="symbol-virtual" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const symbol = symbols[row.index];
            if (!symbol) return null;
            return (
              <button
                className="project-symbol-row"
                key={`${symbol.projectId}:${symbol.path}:${symbol.line}:${symbol.name}`}
                style={{ transform: `translateY(${row.start}px)` }}
                onClick={() => onOpen(symbol)}
                data-tooltip={`${symbol.path}:${symbol.line + 1}`}
                role="listitem"
              >
                <span className="project-symbol-name">{symbol.name}</span>
                <span className="project-symbol-location">
                  {symbol.path}
                  <span className="symbol-line">:{symbol.line + 1}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {result?.indexing && <div className="symbol-indexing">符号索引仍在后台更新</div>}
    </>
  );
}

export function flattenOutline(symbols: DocumentSymbol[]): FlatSymbol[] {
  const result: FlatSymbol[] = [];
  const visit = (items: DocumentSymbol[], depth: number, parent: string) => {
    for (const [index, symbol] of items.entries()) {
      const key = `${parent}/${index}:${symbol.name}:${symbol.line}`;
      result.push({ key, symbol, depth });
      if (symbol.children.length > 0) {
        visit(symbol.children, depth + 1, key);
      }
    }
  };
  visit(symbols, 0, "root");
  return result;
}
