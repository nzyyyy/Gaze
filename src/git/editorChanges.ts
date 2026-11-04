import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";

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

type Part = "only" | "first" | "middle" | "last";

function clampLine(line: number, lines: number) {
  return Math.min(Math.max(1, line), lines);
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

/**
 * A left gutter painting a bar beside every local change, IDEA style.
 * Clicking a bar hands the change block back to the caller.
 */
export function gitChangeGutter(
  onSelect: (block: ChangeBlock, element: HTMLElement) => void,
): Extension {
  return [
    changeBlocksField,
    gutter({
      class: "cm-git-changes",
      markers(view) {
        const doc = view.state.doc;
        const items: { position: number; marker: ChangeMarker }[] = [];
        for (const block of view.state.field(changeBlocksField)) {
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
        return builder.finish();
      },
      domEventHandlers: {
        mousedown(view, line, event) {
          const doc = view.state.doc;
          const number = doc.lineAt(line.from).number;
          const block = view.state
            .field(changeBlocksField)
            .find((candidate) =>
              candidate.kind === "deleted"
                ? number === clampLine(candidate.from, doc.lines)
                : number >= candidate.from && number <= candidate.to,
            );
          if (!block) return false;
          onSelect(block, event.target instanceof HTMLElement ? event.target : view.contentDOM);
          return true;
        },
      },
    }),
  ];
}
