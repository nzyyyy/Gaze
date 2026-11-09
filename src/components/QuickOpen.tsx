import { t, useLanguage } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileSearch, LoaderCircle, SearchX } from "lucide-react";

import { api } from "../lib/api";
import type { PathSearchHit } from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";
import { basename, errorMessage, parentPath } from "../lib/utils";
import { FileIcon } from "./FileIcon";

interface QuickOpenProps {
  open: boolean;
  hasProjects: boolean;
  onClose: () => void;
  onOpen: (hit: PathSearchHit) => void;
  onImport: () => void;
}

export function QuickOpen({ open, hasProjects, onClose, onOpen, onImport }: QuickOpenProps) {
  useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PathSearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  useModalFocus(dialogRef, inputRef, open);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    api
      .onPathIndexStatus((status) => {
        if (disposed) return;
        setIndexing(status.indexing);
        if (!status.indexing) setReloadToken((value) => value + 1);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !hasProjects) {
      setHits([]);
      return;
    }
    let disposed = false;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(
      () => {
        api
          .searchPaths(query)
          .then((response) => {
            if (disposed) return;
            setHits(response.hits);
            setIndexing(response.indexing);
            setIndexMessage(response.message);
            setSelected(0);
            setLoading(false);
          })
          .catch((reason: unknown) => {
            if (disposed) return;
            setError(errorMessage(reason));
            setLoading(false);
          });
      },
      query.length === 0 ? 0 : 80,
    );
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [hasProjects, open, query, reloadToken]);

  useEffect(() => {
    if (hits.length > 0) {
      virtualizer.scrollToIndex(selected, { align: "auto" });
    }
  }, [selected, hits.length, virtualizer]);

  if (!open) return null;

  const openSelected = (index = selected) => {
    const hit = hits[index];
    if (!hit) return;
    onClose();
    onOpen(hit);
  };

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
        aria-label={t("快速打开文件")}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="quick-open-input-row">
          <FileSearch size={17} className="quick-open-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) => Math.min(value + 1, Math.max(0, hits.length - 1)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                openSelected();
              }
            }}
            placeholder={t("输入文件名或路径")}
            aria-label={t("输入文件名或路径")}
            spellCheck={false}
            disabled={!hasProjects}
          />
          {(loading || indexing) && <LoaderCircle size={14} className="spin" />}
          <kbd className="palette-key">Esc</kbd>
        </div>

        {!hasProjects ? (
          <div className="palette-empty">
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
          </div>
        ) : error ? (
          <div className="palette-empty palette-error">{error}</div>
        ) : hits.length === 0 ? (
          <div className="palette-empty">
            {indexing ? (
              <>
                <LoaderCircle size={22} className="spin" />
                <p>{t("正在建立文件索引…")}</p>
              </>
            ) : (
              <>
                <SearchX size={22} strokeWidth={1.4} />
                <p>{query ? t("没有匹配的文件") : t("尚未发现可打开的文件")}</p>
              </>
            )}
          </div>
        ) : (
          <div
            className="palette-results"
            ref={listRef}
            role="listbox"
            aria-label={t("文件匹配结果")}
          >
            <div className="palette-results-virtual" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((row) => {
                const hit = hits[row.index];
                if (!hit) return null;
                const directory = parentPath(hit.path);
                const isSelected = selected === row.index;
                return (
                  <button
                    className={`palette-result ${isSelected ? "is-selected" : ""}`}
                    key={`${hit.projectId}:${hit.path}`}
                    style={{ transform: `translateY(${row.start}px)` }}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setSelected(row.index)}
                    onClick={() => openSelected(row.index)}
                  >
                    <FileIcon name={basename(hit.path)} size={15} />
                    <span className="palette-project">{hit.projectName}</span>
                    <span className="palette-path">
                      {directory && <span className="palette-dir">{directory}/</span>}
                      <span className="palette-basename">{basename(hit.path)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="quick-open-footer">
          <span>
            {indexMessage ?? (indexing ? t("文件索引仍在后台更新") : t("{0} 个结果", hits.length))}
          </span>
          <span className="palette-hints">
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("导航")}
            <kbd>↵</kbd> {t("打开")}
          </span>
        </div>
      </div>
    </div>
  );
}
