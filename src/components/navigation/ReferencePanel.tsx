import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { t, useLanguage } from "../../lib/i18n";
import type { NavigationResult, Project, SymbolLocation } from "../../lib/types";
import { CodeLocationPreview, type ReadPreviewText } from "./CodeLocationPreview";
import { FileIcon } from "../common/FileIcon";
import "./ReferencePanel.css";

export function ReferencePanel({
  result,
  projects,
  active,
  readText,
  onOpen,
  onClose,
}: {
  result: NavigationResult;
  projects: readonly Project[];
  active: boolean;
  readText: ReadPreviewText;
  onOpen: (location: SymbolLocation) => void;
  onClose: () => void;
}) {
  useLanguage();
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ result: NavigationResult; index: number } | null>(
    null,
  );
  const selected = selection?.result === result ? selection.index : 0;
  const select = (index: number) => setSelection({ result, index });
  const { locations, rows, indices } = useMemo(() => {
    const names = new Map(projects.map(({ id, name }) => [id, name]));
    const groups = new Map<string, { label: string; hits: SymbolLocation[] }>();
    for (const hit of result.locations) {
      const projectName = names.get(hit.projectId);
      if (!hit.externalEncoding && !projectName) continue;
      const key = JSON.stringify([hit.projectId, hit.path]);
      let group = groups.get(key);
      if (!group) {
        group = { label: projectName ? `${projectName} / ${hit.path}` : hit.path, hits: [] };
        groups.set(key, group);
      }
      group.hits.push(hit);
    }
    const locations: SymbolLocation[] = [];
    const rows: ({ heading: string; path: string } | { index: number })[] = [];
    const indices: number[] = [];
    for (const { label, hits } of groups.values()) {
      rows.push({ heading: label, path: hits[0]!.path });
      hits.sort((a, b) => a.line - b.line || a.character - b.character);
      for (const hit of hits) {
        indices.push(rows.length);
        rows.push({ index: locations.length });
        locations.push(hit);
      }
    }
    return { locations, rows, indices };
  }, [projects, result]);

  const index = Math.min(selected, Math.max(0, locations.length - 1));
  const location = locations[index];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 30,
    overscan: 8,
  });
  const visibleRows = virtualizer.getVirtualItems();

  useEffect(() => {
    if (active && indices[index] !== undefined)
      virtualizer.scrollToIndex(indices[index], { align: "auto" });
  }, [active, index, indices, virtualizer]);

  useEffect(() => {
    if (active) listRef.current?.focus();
  }, [active, result]);

  return (
    <div className="reference-panel">
      <div className="pane-heading">
        <span>
          {t("引用")} · {t("{0} 个结果", locations.length)}
        </span>
        <button className="icon-button" onClick={onClose} aria-label={t("关闭引用结果")}>
          <X size={15} />
        </button>
      </div>
      {result.message && <div className="symbol-message">{result.message}</div>}
      {locations.length > 0 ? (
        <div
          className="reference-results"
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label={t("引用结果")}
          aria-activedescendant={
            visibleRows.some((row) => row.index === indices[index]) ? `${id}-${index}` : undefined
          }
          onKeyDown={(event) => {
            if (!location || event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              select(
                Math.min(
                  Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)),
                  locations.length - 1,
                ),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              onOpen(location);
            }
          }}
        >
          <div className="palette-results-virtual" style={{ height: virtualizer.getTotalSize() }}>
            {visibleRows.map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              const style = { transform: `translateY(${virtualRow.start}px)` };
              if ("heading" in row)
                return (
                  <div
                    className="reference-file"
                    key={virtualRow.key}
                    style={style}
                    title={row.heading}
                  >
                    <FileIcon name={row.path} size={14} />
                    <span>{row.heading}</span>
                  </div>
                );
              const hit = locations[row.index]!;
              return (
                <button
                  className="reference-row"
                  key={virtualRow.key}
                  style={style}
                  tabIndex={-1}
                  id={`${id}-${row.index}`}
                  role="option"
                  aria-selected={index === row.index}
                  title={`${hit.path}:${hit.line + 1}:${hit.character + 1}`}
                  aria-label={`${hit.name} — ${hit.path}:${hit.line + 1}:${hit.character + 1}`}
                  onClick={() => {
                    select(row.index);
                    onOpen(hit);
                  }}
                >
                  <code>
                    {hit.line + 1}:{hit.character + 1}
                  </code>
                  <span>{hit.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="symbol-message">{t("没有可跳转的位置")}</div>
      )}
      {active && location && !location.externalEncoding && (
        <CodeLocationPreview
          key={JSON.stringify([location.projectId, location.path])}
          location={{ projectId: location.projectId, path: location.path, position: location }}
          readText={readText}
        />
      )}
    </div>
  );
}
