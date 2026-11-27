import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Text } from "@codemirror/state";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpRight, X } from "lucide-react";
import type { HunkData, HunkTokens } from "react-diff-view";

import { t, useLanguage } from "../../lib/i18n";
import type { ChangeBlock } from "./lineDiff";
import { languageForPath, useDiffTokens } from "./useDiffTokens";

export interface EditorDiffSnapshot {
  doc: Text;
  blocks: ChangeBlock[];
  selected: number;
  wrap: boolean;
}

export type EditorDiffAnchor = HTMLElement | { top: number; right: number };

type Side = "old" | "new";
type Line = { number: number; text: string; side: Side; sign?: "+" | "−" };
type Row = {
  lines: (Line | undefined)[];
  kind?: ChangeBlock["kind"];
  block?: number;
  label?: string;
};

function changeHunk(block: ChangeBlock): HunkData {
  return {
    content: "",
    oldStart: block.oldStart,
    oldLines: block.oldLines.length,
    newStart: block.from,
    newLines: block.newLines.length,
    changes: [
      ...block.oldLines.map((content, index) => ({
        type: "delete" as const,
        isDelete: true as const,
        lineNumber: block.oldStart + index,
        content,
      })),
      ...block.newLines.map((content, index) => ({
        type: "insert" as const,
        isInsert: true as const,
        lineNumber: block.from + index,
        content,
      })),
    ],
  };
}

function changeRows(block: ChangeBlock, split: boolean, index?: number): Row[] {
  const before = block.oldLines.map((text, offset): Line => ({
    number: block.oldStart + offset,
    text,
    side: "old",
    sign: "−",
  }));
  const after = block.newLines.map((text, offset): Line => ({
    number: block.from + offset,
    text,
    side: "new",
    sign: "+",
  }));
  const kindAt = (offset: number): ChangeBlock["kind"] =>
    offset >= before.length ? "added" : offset >= after.length ? "deleted" : "modified";
  return split
    ? Array.from({ length: Math.max(before.length, after.length) }, (_, offset) => ({
        lines: [before[offset], after[offset]],
        kind: kindAt(offset),
        block: index,
      }))
    : [
        ...before.map((line, offset) => ({ lines: [line], kind: kindAt(offset), block: index })),
        ...after.map((line, offset) => ({ lines: [line], kind: kindAt(offset), block: index })),
      ];
}

function fileRows(doc: Text, blocks: ChangeBlock[], split: boolean) {
  const rows: Row[] = [];
  const starts: number[] = [];
  let before = 1;
  let after = 1;
  const context = (until: number) => {
    for (; after < until; after += 1, before += 1) {
      const { text } = doc.line(after);
      const current: Line = { number: after, text, side: "new" };
      rows.push({
        lines: split ? [{ number: before, text, side: "old" }, current] : [current],
      });
    }
  };
  blocks.forEach((block, index) => {
    context(block.from);
    starts.push(rows.length);
    for (const row of changeRows(block, split, index)) rows.push(row);
    before = block.oldStart + block.oldLines.length;
    after = block.from + block.newLines.length;
  });
  if (doc.length) context(doc.lines + 1);
  return { rows, starts };
}

export function changeLabel(block: ChangeBlock): string {
  const added = block.newLines.length;
  const removed = block.oldLines.length;
  if (block.kind === "added") return t("新增 {0} 行", added);
  if (block.kind === "deleted") return t("删除 {0} 行", removed);
  return t("修改 {0} 行（原 {1} 行）", added, removed);
}

function renderTokens(tokens: HunkTokens["old"][number]): ReactNode {
  return tokens.map((token, index) => {
    if (token.type === "text") return token.value;
    const value = token.children ? renderTokens(token.children) : token.value;
    return token.type === "edit" ? (
      <mark key={index}>{value}</mark>
    ) : (
      <span key={index} className={token.className}>
        {value}
      </span>
    );
  });
}

const SIDE_LABEL_HEIGHT = 26;

function DiffRows({
  rows,
  tokens,
  wrap,
  split = false,
  selected,
  targetRow,
  tabSize,
  comparison = false,
}: {
  rows: Row[];
  tokens: HunkTokens | null;
  wrap: boolean;
  split?: boolean;
  selected?: number;
  targetRow?: number;
  tabSize: number;
  comparison?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > 300;
  const scrollMargin = comparison ? SIDE_LABEL_HEIGHT : 0;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 23,
    overscan: 12,
    scrollMargin,
  });
  const width = useMemo(() => {
    if (wrap) return undefined;
    let columns = 0;
    for (const row of rows) {
      for (const line of row.lines) {
        if (!line) continue;
        const length = line.text.replace(/[^\x20-\x7e]/g, (character) =>
          character === "\t" ? " ".repeat(tabSize) : "  ",
        ).length;
        columns = Math.max(columns, length);
      }
    }
    return `calc(${(columns + 10) * (split ? 2 : 1)}ch + ${split ? 32 : 16}px)`;
  }, [rows, split, tabSize, wrap]);

  useLayoutEffect(() => {
    if (virtual) virtualizer.measure();
    if (targetRow === undefined) return;
    if (virtual) virtualizer.scrollToIndex(targetRow, { align: "center" });
    else {
      const element = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${targetRow}"]`);
      if (element && scrollRef.current) {
        const area = scrollRef.current;
        area.scrollTop = Math.max(0, element.offsetTop + scrollMargin - area.clientHeight / 3);
      }
    }
  }, [rows, scrollMargin, targetRow, virtual, virtualizer, wrap]);

  function renderRow(row: Row, index: number, start?: number) {
    return (
      <div
        className={`editor-diff-row${row.kind ? ` is-${row.kind}` : ""}${row.block !== undefined && row.block === selected ? " is-selected" : ""}`}
        key={index}
        ref={virtual ? virtualizer.measureElement : undefined}
        data-index={index}
        style={
          start === undefined
            ? undefined
            : { position: "absolute", inset: "0 0 auto", transform: `translateY(${start}px)` }
        }
      >
        {row.label ? (
          <div className="editor-diff-side-label">{row.label}</div>
        ) : (
          row.lines.map((line, side) => {
            if (!line) return <div className="editor-diff-gap" key={side} aria-hidden="true" />;
            const lineTokens = line.sign ? tokens?.[line.side][line.number - 1] : undefined;
            return (
              <div className={`editor-diff-cell is-${line.side}`} key={side}>
                <span className="editor-diff-number">{line.number}</span>
                <span className="editor-diff-sign">{line.sign}</span>
                <code>{lineTokens?.length ? renderTokens(lineTokens) : line.text || " "}</code>
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={`git-change-lines${wrap ? "" : " no-wrap"}${split ? " is-split" : ""}`}
      tabIndex={0}
      role="region"
      aria-label={t("改动内容")}
      style={{ tabSize }}
    >
      <div style={{ minWidth: width }}>
        {comparison && (
          <div
            className={`editor-comparison-sides${split ? " is-split" : ""}`}
            style={{ height: SIDE_LABEL_HEIGHT }}
          >
            <span>HEAD</span>
            <span>{t("当前编辑器")}</span>
          </div>
        )}
        <div
          className="editor-diff-grid"
          style={{ height: virtual ? virtualizer.getTotalSize() : undefined }}
        >
          {virtual
            ? virtualizer
                .getVirtualItems()
                .map((item) => renderRow(rows[item.index]!, item.index, item.start - scrollMargin))
            : rows.map((row, index) => renderRow(row, index))}
        </div>
      </div>
    </div>
  );
}

function WrapButton({ wrap, toggle }: { wrap: boolean; toggle: () => void }) {
  return (
    <button className="button button-small" aria-pressed={wrap} onClick={toggle}>
      {t("自动换行")}
    </button>
  );
}

export function EditorChangePopover({
  block,
  anchor,
  pane,
  scroll,
  path,
  fontFamily,
  tabSize,
  canRevert,
  onClose,
  onRevert,
  onOpen,
}: {
  block: ChangeBlock;
  anchor: EditorDiffAnchor;
  pane: HTMLElement;
  scroll: HTMLElement;
  path: string;
  fontFamily?: string;
  tabSize: number;
  canRevert: boolean;
  onClose: (restoreFocus?: boolean) => void;
  onRevert: () => void;
  onOpen?: (wrap: boolean) => void;
}) {
  const language = useLanguage();
  const [wrap, setWrap] = useState(true);
  const popup = useRef<HTMLDivElement>(null);
  const hunks = useMemo(() => [changeHunk(block)], [block]);
  const rows = useMemo(() => {
    const changes = changeRows(block, false);
    const count = block.oldLines.length;
    return [
      ...(count ? [{ label: t("修改前 · HEAD"), lines: [] }, ...changes.slice(0, count)] : []),
      ...(block.newLines.length
        ? [{ label: t("修改后 · 当前编辑器"), lines: [] }, ...changes.slice(count)]
        : []),
    ];
  }, [block, language]);
  const tokens = useDiffTokens(hunks, languageForPath(path), true);

  useLayoutEffect(() => {
    const element = popup.current!;
    function position() {
      const bounds = pane.getBoundingClientRect();
      const marker = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
      const width = Math.max(0, Math.min(680, bounds.width - 16));
      const maxHeight = Math.max(0, Math.min(430, bounds.height - 16));
      element.style.width = `${width}px`;
      element.style.maxHeight = `${maxHeight}px`;
      element.style.left = `${Math.max(bounds.left + 8, Math.min(marker.right + 8, bounds.right - width - 8))}px`;
      element.style.top = `${Math.max(bounds.top + 8, Math.min(marker.top, bounds.bottom - element.offsetHeight - 8))}px`;
    }
    position();
    element.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const resize = new ResizeObserver(position);
    resize.observe(pane);
    resize.observe(element);
    const closeOnScroll = () => onClose();
    const closeOnPointer = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !element.contains(target) &&
        !(target instanceof Element && pane.contains(target) && target.closest(".cm-git-changes"))
      )
        onClose();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onClose(true);
      }
    };
    scroll.addEventListener("scroll", closeOnScroll, { passive: true });
    document.addEventListener("mousedown", closeOnPointer);
    document.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      scroll.removeEventListener("scroll", closeOnScroll);
      document.removeEventListener("mousedown", closeOnPointer);
      document.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", position);
    };
  }, [anchor, onClose, pane, scroll]);

  return (
    <div
      className="git-change-popover"
      ref={popup}
      role="dialog"
      aria-label={t("代码变更")}
      style={{ "--editor-diff-font": fontFamily } as CSSProperties}
    >
      <header className="editor-diff-toolbar">
        <strong className={`editor-diff-title is-${block.kind}`}>
          <span aria-hidden="true">
            {block.kind === "added" ? "+" : block.kind === "deleted" ? "−" : "~"}
          </span>
          {changeLabel(block)}
        </strong>
        <div className="editor-diff-actions">
          <WrapButton wrap={wrap} toggle={() => setWrap((value) => !value)} />
          <button className="icon-button" onClick={() => onClose(true)} aria-label={t("关闭")}>
            <X size={15} />
          </button>
        </div>
      </header>
      <DiffRows rows={rows} tokens={tokens} wrap={wrap} tabSize={tabSize} />
      <footer>
        <button
          className="button button-small"
          onClick={onRevert}
          disabled={!canRevert}
          data-tooltip={t(canRevert ? "用原始代码替换此处内容" : "只读文件无法撤销更改")}
        >
          {t("撤销此更改")}
        </button>
        {onOpen && (
          <button className="button button-small" onClick={() => onOpen(wrap)}>
            {t("打开完整对比")} <ArrowUpRight size={14} />
          </button>
        )}
      </footer>
    </div>
  );
}

export function EditorComparison({
  snapshot,
  path,
  fontFamily,
  tabSize,
  onClose,
}: {
  snapshot: EditorDiffSnapshot;
  path: string;
  fontFamily?: string;
  tabSize: number;
  onClose: () => void;
}) {
  useLanguage();
  const { doc, blocks } = snapshot;
  const [selected, setSelected] = useState(snapshot.selected);
  const [wrap, setWrap] = useState(snapshot.wrap);
  const [unified, setUnified] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const diff = useRef<HTMLElement>(null);
  const split = !unified && !narrow;
  useLayoutEffect(() => {
    const element = diff.current!;
    const measure = () => {
      if (element.clientWidth > 0) setNarrow(element.clientWidth < 600);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { rows, starts } = useMemo(() => fileRows(doc, blocks, split), [doc, blocks, split]);
  const hunks = useMemo(() => blocks.map(changeHunk), [blocks]);
  const tokens = useDiffTokens(hunks, languageForPath(path), true);
  return (
    <section
      className="editor-comparison"
      aria-label={t("文件对比")}
      ref={diff}
      style={{ "--editor-diff-font": fontFamily } as CSSProperties}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="editor-diff-toolbar">
        <div className="editor-diff-title">
          <strong data-tooltip={path}>{path}</strong>
          <span aria-live="polite">{t("{0} / {1} 处改动", selected + 1, blocks.length)}</span>
        </div>
        <div className="editor-diff-actions">
          <WrapButton wrap={wrap} toggle={() => setWrap((value) => !value)} />
          {!narrow && (
            <button
              className="button button-small"
              aria-pressed={unified}
              onClick={() => setUnified((value) => !value)}
            >
              {t("上下对比")}
            </button>
          )}
          <button
            className="icon-button"
            disabled={selected === 0}
            onClick={() => setSelected(selected - 1)}
            aria-label={t("上一处改动")}
          >
            <ArrowUp size={15} />
          </button>
          <button
            className="icon-button"
            disabled={selected === blocks.length - 1}
            onClick={() => setSelected(selected + 1)}
            aria-label={t("下一处改动")}
          >
            <ArrowDown size={15} />
          </button>
        </div>
      </header>
      <DiffRows
        comparison
        rows={rows}
        tokens={tokens}
        wrap={wrap}
        split={split}
        selected={selected}
        targetRow={starts[selected]}
        tabSize={tabSize}
      />
    </section>
  );
}
