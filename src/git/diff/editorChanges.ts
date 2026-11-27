import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type RangeSet,
  type Text,
} from "@codemirror/state";
import { GutterMarker, gutter, type EditorView } from "@codemirror/view";

import type { ChangeBlock } from "./lineDiff";

export const setChangeBlocks = StateEffect.define<ChangeBlock[]>();

/** Blocks are line-numbered against the document; they are replaced after every edit. */
export const changeBlocksField = StateField.define<ChangeBlock[]>({
  create: () => [],
  update(blocks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setChangeBlocks)) return effect.value;
    }
    return blocks;
  },
});

const setHoveredChange = StateEffect.define<ChangeBlock | null>();
const hoveredChange = StateField.define<ChangeBlock | null>({
  create: () => null,
  update(block, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHoveredChange)) return effect.value;
      if (effect.is(setChangeBlocks)) return null;
    }
    return transaction.docChanged ? null : block;
  },
});

type Part = "only" | "first" | "middle" | "last";

function clampLine(line: number, lines: number) {
  return Math.min(Math.max(1, line), lines);
}

export function changeBlockAtLine(view: EditorView, line: number) {
  return view.state
    .field(changeBlocksField)
    .find((block) =>
      block.kind === "deleted"
        ? line === clampLine(block.from, view.state.doc.lines)
        : line >= block.from && line <= block.to,
    );
}

/** The gutter cell carries the bar as a background, so consecutive lines join into one block. */
class ChangeMarker extends GutterMarker {
  constructor(
    readonly block: ChangeBlock,
    part: Part,
  ) {
    super();
    this.elementClass = `cm-git-line cm-git-line-${block.kind} cm-git-line-${part}`;
  }

  eq() {
    return false;
  }
}

const hoverMarker = new (class extends GutterMarker {
  elementClass = "cm-git-line-hovered";
})();

/**
 * A left gutter painting a bar beside every local change, IDEA style.
 * Clicking a bar hands the change block back to the caller.
 */
export function gitChangeGutter(
  onSelect: (block: ChangeBlock, element: HTMLElement) => void,
): Extension {
  let cached: { doc: Text; blocks: ChangeBlock[]; markers: RangeSet<GutterMarker> } | undefined;
  const hover = (view: EditorView, block: ChangeBlock | null) => {
    if (view.state.field(hoveredChange) !== block) {
      view.dispatch({ effects: setHoveredChange.of(block) });
    }
    return false;
  };
  return [
    changeBlocksField,
    hoveredChange,
    gutter({
      class: "cm-git-changes",
      markers(view) {
        const doc = view.state.doc;
        const blocks = view.state.field(changeBlocksField);
        if (cached?.doc === doc && cached.blocks === blocks) return cached.markers;
        const items: { position: number; marker: ChangeMarker }[] = [];
        for (const block of blocks) {
          if (block.kind === "deleted") {
            const line = clampLine(block.from, doc.lines);
            items.push({
              position: doc.line(line).from,
              marker: new ChangeMarker(block, "only"),
            });
            continue;
          }
          const start = clampLine(block.from, doc.lines);
          const end = clampLine(Math.max(block.to, start), doc.lines);
          for (let number = start; number <= end; number += 1) {
            const part: Part =
              start === end
                ? "only"
                : number === start
                  ? "first"
                  : number === end
                    ? "last"
                    : "middle";
            items.push({
              position: doc.line(number).from,
              marker: new ChangeMarker(block, part),
            });
          }
        }
        items.sort((left, right) => left.position - right.position);
        const builder = new RangeSetBuilder<GutterMarker>();
        for (const item of items) builder.add(item.position, item.position, item.marker);
        cached = { doc, blocks, markers: builder.finish() };
        return cached.markers;
      },
      lineMarker(view, _line, markers) {
        const block = view.state.field(hoveredChange);
        return block &&
          markers.some((marker) => marker instanceof ChangeMarker && marker.block === block)
          ? hoverMarker
          : null;
      },
      lineMarkerChange(update) {
        return update.startState.field(hoveredChange) !== update.state.field(hoveredChange);
      },
      domEventHandlers: {
        mousemove(view, line, event) {
          const overMarker =
            event.target instanceof Element && event.target.closest(".cm-git-line");
          return hover(
            view,
            overMarker
              ? (changeBlockAtLine(view, view.state.doc.lineAt(line.from).number) ?? null)
              : null,
          );
        },
        mouseleave(view) {
          return hover(view, null);
        },
        mousedown(view, line, event) {
          if (event instanceof MouseEvent && event.button !== 0) return false;
          const doc = view.state.doc;
          const block = changeBlockAtLine(view, doc.lineAt(line.from).number);
          if (!block) return false;
          onSelect(block, event.target instanceof HTMLElement ? event.target : view.contentDOM);
          return true;
        },
      },
    }),
  ];
}
