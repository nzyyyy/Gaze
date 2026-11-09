import { t, useLanguage } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CornerDownLeft, MapPin, X } from "lucide-react";

import type { NavigationResult, Project, SymbolLocation } from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";

interface LocationPickerProps {
  title: string;
  result: NavigationResult;
  projects: Project[];
  onClose: () => void;
  onSelect: (location: SymbolLocation) => void;
}

export function LocationPicker({
  title,
  result,
  projects,
  onClose,
  onSelect,
}: LocationPickerProps) {
  useLanguage();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const locations = result.locations;
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const virtualizer = useVirtualizer({
    count: locations.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 47,
    overscan: 12,
  });

  useModalFocus(dialogRef);

  useEffect(() => {
    dialogRef.current?.focus();
    setSelected(0);
  }, [result]);

  useEffect(() => {
    if (locations.length > 0) {
      virtualizer.scrollToIndex(selected, { align: "auto" });
    }
  }, [locations.length, selected, virtualizer]);

  const choose = (index = selected) => {
    const location = locations[index];
    if (!location) return;
    onClose();
    onSelect(location);
  };

  return (
    <div
      className="palette-backdrop location-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="location-picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((value) => Math.min(value + 1, Math.max(0, locations.length - 1)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((value) => Math.max(0, value - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose();
          }
        }}
      >
        <div className="location-header">
          <MapPin size={16} className="quick-open-icon" />
          <span className="location-title">{title}</span>
          <span className={`source-badge ${result.source}`}>
            {result.source === "lsp" ? t("LSP 精确") : t("ctags 文本候选")}
          </span>
          <span className="location-count">
            {locations.length} {t("个位置")}
          </span>
          <button className="icon-button" onClick={onClose} aria-label={t("关闭")}>
            <X size={15} />
          </button>
        </div>

        {result.message && <div className="location-message">{result.message}</div>}

        {locations.length === 0 ? (
          <div className="palette-empty">
            <MapPin size={23} strokeWidth={1.4} />
            <p>{t("没有可跳转的位置")}</p>
            <span>{result.message ?? t("当前符号没有返回结果。")}</span>
          </div>
        ) : (
          <div className="location-results" ref={scrollRef} role="listbox" aria-label={title}>
            <div
              className="location-results-virtual"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((row) => {
                const location = locations[row.index];
                if (!location) return null;
                const active = row.index === selected;
                return (
                  <button
                    className={`location-row ${active ? "is-selected" : ""}`}
                    key={`${location.projectId}:${location.path}:${location.line}:${location.character}:${row.index}`}
                    style={{ transform: `translateY(${row.start}px)` }}
                    onMouseEnter={() => setSelected(row.index)}
                    onClick={() => choose(row.index)}
                    role="option"
                    aria-selected={active}
                  >
                    <span className="location-kind">{location.kind}</span>
                    <span className="location-main">
                      <span className="location-symbol">
                        {location.name || location.path.split("/").pop()}
                      </span>
                      <span className="location-file">
                        {projectNames.get(location.projectId) ?? t("未知项目")} / {location.path}
                        <span className="symbol-line">:{location.line + 1}</span>
                      </span>
                    </span>
                    {active && <CornerDownLeft size={13} className="location-enter" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="quick-open-footer">
          <span>{result.message ?? t("选择位置后跳到对应代码")}</span>
          <span className="palette-hints">
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("导航")}
            <kbd>↵</kbd> {t("打开")}
            <kbd>Esc</kbd> {t("关闭")}
          </span>
        </div>
      </div>
    </div>
  );
}
