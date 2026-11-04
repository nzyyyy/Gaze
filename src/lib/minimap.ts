import { foldedRanges, highlightingFor, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";

import { changeBlocksField } from "../git/editorChanges";

const PADDING = 4;
const PIXELS_PER_LINE = 4;
const SVG_NS = "http://www.w3.org/2000/svg";

function tokens(state: EditorState, from: number, to: number) {
  const ranges: { from: number; to: number; classes: string }[] = [];
  highlightTree(
    syntaxTree(state),
    { style: (tags) => highlightingFor(state, tags) },
    (start, end, classes) =>
      ranges.push({ from: Math.max(from, start), to: Math.min(to, end), classes }),
    from,
    to,
  );
  return ranges;
}

class Minimap {
  readonly dom = document.createElement("div");
  private readonly svg = document.createElementNS(SVG_NS, "svg");
  private readonly thumb = document.createElement("div");
  private readonly caret = document.createElement("div");
  private readonly selection = document.createElement("div");
  private readonly preview = document.createElement("div");
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewLine: number | null = null;
  private height = 0;
  private offset = 0;
  private scale = 1;
  private firstLine = 1;
  private lastLine = 1;
  private thumbTop = 0;
  private thumbHeight = 0;
  private drag: { y: number; top: number; scale: number } | null = null;
  private dirty = true;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.dom.className = "code-minimap";
    this.dom.tabIndex = 0;
    this.dom.setAttribute("role", "slider");
    this.dom.setAttribute("aria-label", "内容缩略图");
    this.dom.setAttribute("aria-orientation", "vertical");
    this.dom.setAttribute("aria-valuemin", "1");
    this.dom.setAttribute("aria-valuemax", String(view.state.doc.lines));
    this.dom.setAttribute("aria-valuenow", "1");
    this.svg.setAttribute("aria-hidden", "true");
    this.thumb.className = "code-minimap-viewport";
    this.caret.className = "code-minimap-caret";
    this.selection.className = "code-minimap-selection";
    this.preview.className = "code-minimap-preview";
    this.preview.setAttribute("role", "tooltip");
    this.preview.setAttribute("aria-label", "代码预览");
    this.preview.hidden = true;
    this.dom.append(this.svg, this.thumb, this.selection, this.caret);
    view.dom.append(this.dom, this.preview);
    this.dom.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.height) return;
      event.preventDefault();
      this.hidePreview();
      this.dom.focus();
      this.dom.setPointerCapture(event.pointerId);
      const y = event.clientY - this.dom.getBoundingClientRect().top - PADDING;
      if (y < this.thumbTop || y > this.thumbTop + this.thumbHeight)
        this.setScroll((this.offset + y - this.thumbHeight / 2) / this.scale);
      this.drag = {
        y: event.clientY,
        top: view.scrollDOM.scrollTop,
        scale: this.maxScroll() / Math.max(1, this.height - this.thumbHeight),
      };
    });
    this.dom.addEventListener("pointermove", (event) => {
      if (this.drag)
        this.setScroll(this.drag.top + (event.clientY - this.drag.y) * this.drag.scale);
      else this.schedulePreview(event.clientY);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      this.dom.addEventListener(type, () => (this.drag = null));
    this.dom.addEventListener("pointerleave", () => this.hidePreview());
    this.dom.addEventListener("blur", () => this.hidePreview());
    this.dom.addEventListener(
      "wheel",
      (event) => {
        const unit =
          event.deltaMode === 1
            ? view.defaultLineHeight
            : event.deltaMode === 2
              ? view.scrollDOM.clientHeight
              : 1;
        const top = view.scrollDOM.scrollTop;
        this.setScroll(top + event.deltaY * unit);
        if (view.scrollDOM.scrollTop !== top) event.preventDefault();
      },
      { passive: false },
    );
    this.dom.addEventListener("keydown", (event) => {
      this.hidePreview();
      const page = Math.max(1, this.lastLine - this.firstLine);
      const target = {
        ArrowUp: this.firstLine - 1,
        ArrowDown: this.firstLine + 1,
        PageUp: this.firstLine - page,
        PageDown: this.firstLine + page,
        Home: 1,
        End: view.state.doc.lines,
      }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, target)));
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 0 }) });
    });
    this.measure();
  }

  update(update: ViewUpdate) {
    this.dirty ||=
      update.docChanged ||
      update.geometryChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state) ||
      foldedRanges(update.startState) !== foldedRanges(update.state) ||
      update.transactions.some((transaction) => transaction.reconfigured);
    if (this.dirty || update.selectionSet || update.viewportChanged) this.hidePreview();
    this.measure();
  }

  measure() {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        if (this.destroyed) return null;
        const rect = view.scrollDOM.getBoundingClientRect();
        const available = Math.max(0, this.dom.clientHeight - PADDING * 2);
        if (!available) return null;
        const scale = PIXELS_PER_LINE / view.defaultLineHeight;
        const top = Math.max(0, rect.top - view.documentTop);
        const documentHeight =
          Math.max(
            view.defaultLineHeight,
            view.contentHeight - view.documentPadding.top - view.documentPadding.bottom,
          ) * scale;
        const height = Math.min(available, documentHeight);
        const thumbHeight = Math.min(height, rect.height * scale);
        const viewportTop = Math.min(Math.max(0, documentHeight - thumbHeight), top * scale);
        const offset =
          (viewportTop / Math.max(1, documentHeight - thumbHeight)) *
          Math.max(0, documentHeight - height);
        const width = Math.max(16, this.dom.clientWidth - PADDING * 2);
        const rows: { y: number; parts: { from: number; to: number }[] }[] = [];
        if (this.dirty || offset !== this.offset || height !== this.height) {
          const left = view.contentDOM.getBoundingClientRect().left;
          for (
            let y = Math.floor(offset / PIXELS_PER_LINE) * PIXELS_PER_LINE;
            y < offset + height;
            y += PIXELS_PER_LINE
          ) {
            const sourceY = y / scale;
            const block = view.lineBlockAtHeight(sourceY);
            let from = block.from;
            let to = block.to;
            if (view.lineWrapping && block.height > view.defaultLineHeight * 1.5) {
              from = view.posAtCoords(
                { x: left, y: view.documentTop + sourceY + view.defaultLineHeight / 2 },
                false,
              );
              const next = view.posAtCoords(
                { x: left, y: view.documentTop + sourceY + view.defaultLineHeight * 1.5 },
                false,
              );
              if (next > from && next < to) to = next;
            }
            const parts: { from: number; to: number }[] = [];
            foldedRanges(view.state).between(from, to, (start, end) => {
              if (start > from) parts.push({ from, to: Math.min(start, to) });
              from = Math.max(from, end);
            });
            if (from < to) parts.push({ from, to });
            rows.push({ y: y - offset, parts });
          }
        }
        const selected = view.state.selection.main;
        const caret = view.lineBlockAt(selected.head);
        const selectionFrom = view.lineBlockAt(selected.from).top * scale - offset;
        const selectionTo = view.lineBlockAt(selected.to).bottom * scale - offset;
        const markers = (view.state.field(changeBlocksField, false) ?? []).flatMap((block) => {
          const first = view.state.doc.line(
            Math.max(1, Math.min(view.state.doc.lines, block.from)),
          );
          const last = view.state.doc.line(
            Math.max(first.number, Math.min(view.state.doc.lines, block.to)),
          );
          const start = view.lineBlockAt(first.from).top * scale - offset;
          const end = view.lineBlockAt(last.from).bottom * scale - offset;
          return end > 0 && start < height
            ? [
                {
                  kind: block.kind,
                  top: Math.max(0, start),
                  height: Math.min(height, end) - Math.max(0, start),
                },
              ]
            : [];
        });
        return {
          scale,
          offset,
          height,
          width,
          rows,
          markers,
          thumbTop: viewportTop - offset,
          thumbHeight,
          first: view.state.doc.lineAt(view.lineBlockAtHeight(top).from).number,
          last: view.state.doc.lineAt(view.lineBlockAtHeight(top + rect.height).to).number,
          caretTop: caret.top * scale - offset,
          selectionTop: Math.max(0, selectionFrom),
          selectionHeight: selected.empty
            ? 0
            : Math.max(0, Math.min(height, selectionTo) - Math.max(0, selectionFrom)),
        };
      },
      write: (size, view) => {
        if (this.destroyed || !size) return;
        if (size.rows.length) {
          const paths = new Map<string, string[]>();
          for (const row of size.rows) {
            let column = 0;
            for (const part of row.parts) {
              if (column >= size.width) break;
              const end = Math.min(part.to, part.from + Math.ceil(size.width) * 2);
              const text = view.state.doc.sliceString(part.from, end);
              const ranges = tokens(view.state, part.from, end);
              let token = 0;
              let position = part.from;
              for (const character of text) {
                if (column >= size.width) break;
                while (token < ranges.length && ranges[token]!.to <= position) token++;
                const range = ranges[token];
                const classes = range && range.from <= position ? range.classes : "";
                const columns =
                  character === "\t"
                    ? view.state.tabSize - (column % view.state.tabSize)
                    : character.codePointAt(0)! > 255
                      ? 2
                      : 1;
                if (!/\s/.test(character)) {
                  const shapes = paths.get(classes) ?? [];
                  shapes.push(`M${column} ${row.y + 1}h${columns * 0.9}v2h-${columns * 0.9}z`);
                  paths.set(classes, shapes);
                }
                column += columns;
                position += character.length;
              }
            }
          }
          this.svg.replaceChildren(
            ...Array.from(paths, ([classes, shapes]) => {
              const path = document.createElementNS(SVG_NS, "path");
              path.setAttribute("d", shapes.join(""));
              path.setAttribute("class", classes);
              return path;
            }),
          );
          this.dirty = false;
        }
        this.svg.querySelectorAll(".code-minimap-git").forEach((marker) => marker.remove());
        for (const marker of size.markers) {
          const rect = document.createElementNS(SVG_NS, "rect");
          rect.setAttribute("class", `code-minimap-git code-minimap-git-${marker.kind}`);
          rect.setAttribute("x", "0");
          rect.setAttribute("y", String(marker.top));
          rect.setAttribute("width", "3");
          rect.setAttribute("height", String(Math.max(2, marker.height)));
          this.svg.append(rect);
        }
        this.svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
        this.svg.style.height = `${size.height}px`;
        this.height = size.height;
        this.offset = size.offset;
        this.scale = size.scale;
        this.firstLine = size.first;
        this.lastLine = size.last;
        this.thumbTop = size.thumbTop;
        this.thumbHeight = size.thumbHeight;
        this.thumb.style.top = `${PADDING + size.thumbTop}px`;
        this.thumb.style.height = `${size.thumbHeight}px`;
        this.caret.hidden = size.caretTop < 0 || size.caretTop >= size.height;
        this.caret.style.top = `${PADDING + size.caretTop}px`;
        this.selection.style.top = `${PADDING + size.selectionTop}px`;
        this.selection.style.height = `${size.selectionHeight}px`;
        this.dom.setAttribute("aria-valuemax", String(view.state.doc.lines));
        this.dom.setAttribute("aria-valuenow", String(size.first));
        this.dom.setAttribute(
          "aria-valuetext",
          `第 ${size.first}–${size.last} 行，共 ${view.state.doc.lines} 行`,
        );
      },
    });
  }

  private maxScroll() {
    return Math.max(0, this.view.scrollDOM.scrollHeight - this.view.scrollDOM.clientHeight);
  }

  private setScroll(top: number) {
    this.hidePreview();
    this.view.scrollDOM.scrollTop = Math.max(0, Math.min(this.maxScroll(), top));
    this.measure();
  }

  private schedulePreview(clientY: number) {
    if (!this.height) return;
    const y = Math.max(
      0,
      Math.min(this.height, clientY - this.dom.getBoundingClientRect().top - PADDING),
    );
    const position = this.view.lineBlockAtHeight((this.offset + y) / this.scale).from;
    const line = this.view.state.doc.lineAt(position).number;
    if (this.previewLine === line) return;
    this.hidePreview();
    this.previewLine = line;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (this.destroyed) return;
      const { state } = this.view;
      const header = document.createElement("div");
      header.className = "code-minimap-preview-header";
      header.textContent = `第 ${line} 行，共 ${state.doc.lines} 行`;
      const lines: HTMLElement[] = [header];
      const start = Math.max(1, Math.min(line - 4, state.doc.lines - 10));
      for (let number = start; number <= Math.min(state.doc.lines, start + 10); number++) {
        const source = state.doc.line(number);
        const end = Math.min(source.to, source.from + 300);
        const row = document.createElement("div");
        row.className = `code-minimap-preview-line${number === line ? " is-target" : ""}`;
        const label = document.createElement("span");
        label.className = "code-minimap-preview-number";
        label.textContent = String(number);
        const code = document.createElement("span");
        let position = source.from;
        for (const token of tokens(state, source.from, end)) {
          if (token.from > position) code.append(state.doc.sliceString(position, token.from));
          const span = document.createElement("span");
          span.className = token.classes;
          span.textContent = state.doc.sliceString(token.from, token.to);
          code.append(span);
          position = token.to;
        }
        if (position < end) code.append(state.doc.sliceString(position, end));
        row.append(label, code);
        lines.push(row);
      }
      this.preview.replaceChildren(...lines);
      this.preview.style.top = `${Math.max(4, Math.min(this.dom.clientHeight - 250, y - 100))}px`;
      this.preview.hidden = false;
    }, 300);
  }

  hidePreview() {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.previewLine = null;
    this.preview.hidden = true;
  }

  destroy() {
    this.destroyed = true;
    this.hidePreview();
    this.dom.remove();
    this.preview.remove();
  }
}

export const minimap = [
  ViewPlugin.fromClass(Minimap, {
    eventHandlers: {
      scroll() {
        this.hidePreview();
        this.measure();
      },
    },
  }),
  EditorView.theme({ "&": { paddingRight: "var(--minimap-width, 110px)" } }),
];
