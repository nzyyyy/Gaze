import { t, useLanguage } from "../lib/i18n";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CornerDownLeft, GitFork, X } from "lucide-react";

import type { NavigationResult, Project, SymbolLocation } from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";
import { basename, parentPath } from "../lib/utils";
import { FileIcon } from "./FileIcon";

interface LocationPickerProps {
  title: string;
  result: NavigationResult;
  projects: Project[];
  anchor?: { x: number; top: number; bottom: number } | null;
  onClose: () => void;
  onSelect: (location: SymbolLocation) => void;
}

export function LocationPicker({
  title,
  result,
  projects,
  anchor,
  onClose,
  onSelect,
}: LocationPickerProps) {
  useLanguage();
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const locations = result.locations;
  const first = locations[0];
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const virtualizer = useVirtualizer({
    count: locations.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 39,
    overscan: 8,
  });

  useModalFocus(dialogRef, scrollRef);

  useEffect(() => {
    if (locations.length > 0) virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [locations.length, selected, virtualizer]);

  const choose = (index = selected) => {
    const location = locations[index];
    if (!location) return;
    onClose();
    onSelect(location);
  };
  const above = anchor && window.innerHeight - anchor.bottom < Math.min(330, anchor.top);
  const position = anchor
    ? ({
        "--location-x": `${anchor.x}px`,
        "--location-y": `${(above ? window.innerHeight - anchor.top : anchor.bottom) + 5}px`,
      } as CSSProperties)
    : undefined;
  const rows = virtualizer.getVirtualItems();

  return (
    <div
      className="palette-backdrop location-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="location-picker"
        data-anchor={anchor ? (above ? "above" : "below") : undefined}
        style={position}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            scrollRef.current?.focus();
            setSelected((value) => Math.min(value + 1, Math.max(0, locations.length - 1)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            scrollRef.current?.focus();
            setSelected((value) => Math.max(0, value - 1));
          } else if (
            event.key === "Enter" &&
            (event.target === scrollRef.current || event.target === dialogRef.current)
          ) {
            event.preventDefault();
            choose();
          }
        }}
      >
        <div className="location-header">
          <GitFork size={15} className="location-heading-icon" aria-hidden="true" />
          <span className="location-title" id={`${id}-title`}>
            {title}
          </span>
          {first?.name && (
            <code className="location-symbol" title={first.name}>
              {first.name}
            </code>
          )}
          {result.source === "ctags" && first && (
            <span className="source-badge ctags">{t("ctags 文本候选")}</span>
          )}
          <span className="location-count">
            {locations.length} {t("个位置")}
          </span>
          <button className="icon-button" onClick={onClose} aria-label={t("关闭")}>
            <X size={15} />
          </button>
        </div>

        {locations.length === 0 ? (
          <div className="location-empty">
            <p>{t("没有可跳转的位置")}</p>
            <span>{result.message ?? t("当前符号没有返回结果。")}</span>
          </div>
        ) : (
          <>
            {result.message && <div className="location-message">{result.message}</div>}
            <div
              className="location-results"
              ref={scrollRef}
              role="listbox"
              tabIndex={0}
              aria-label={title}
              aria-activedescendant={
                rows.some((row) => row.index === selected) ? `${id}-${selected}` : undefined
              }
            >
              <div
                className="location-results-virtual"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {rows.map((row) => {
                  const location = locations[row.index]!;
                  const active = row.index === selected;
                  const path = location.path.replaceAll("\\", "/");
                  const name = basename(path);
                  const directory = parentPath(path);
                  const project = projectNames.get(location.projectId);
                  const context = project
                    ? [project, directory].filter(Boolean).join(" / ")
                    : directory;
                  return (
                    <button
                      className="location-row"
                      id={`${id}-${row.index}`}
                      key={row.key}
                      style={{ transform: `translateY(${row.start}px)` }}
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      title={location.path}
                      onMouseEnter={() => setSelected(row.index)}
                      onClick={() => choose(row.index)}
                    >
                      <FileIcon name={name} size={15} />
                      <span className="location-main">
                        <span className="location-file">{name}</span>
                        <span className="location-path">{context}</span>
                      </span>
                      {location.externalEncoding && (
                        <span className="location-external">{t("外部文件")}</span>
                      )}
                      <span className="location-line">
                        {location.line + 1}:{location.character + 1}
                      </span>
                      <CornerDownLeft size={13} className="location-enter" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="location-footer palette-hints">
              <kbd>↑</kbd>
              <kbd>↓</kbd> {t("导航")}
              <kbd>↵</kbd> {t("打开")}
              <kbd>Esc</kbd> {t("关闭")}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
