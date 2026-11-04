import { describe, expect, it } from "vitest";

import { computeChangeBlocks } from "./lineDiff";

describe("computeChangeBlocks", () => {
  it("reports nothing for identical text", () => {
    expect(computeChangeBlocks("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("treats CRLF base and LF document as equal", () => {
    expect(computeChangeBlocks("a\r\nb\r\n", "a\nb\n")).toEqual([]);
  });

  it("marks an inserted line", () => {
    const blocks = computeChangeBlocks("a\nb\n", "a\nX\nb\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "added",
      from: 2,
      to: 2,
      oldLines: [],
      newLines: ["X"],
    });
  });

  it("marks a deleted line at its insertion point", () => {
    const blocks = computeChangeBlocks("a\nb\nc\n", "a\nc\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "deleted",
      from: 2,
      to: 1,
      oldStart: 2,
      oldLines: ["b"],
      newLines: [],
    });
  });

  it("marks a replaced line as modified", () => {
    const blocks = computeChangeBlocks("a\nb\nc\n", "a\nB\nc\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "modified",
      from: 2,
      to: 2,
      oldStart: 2,
      oldLines: ["b"],
      newLines: ["B"],
    });
  });

  it("keeps distant edits as separate blocks", () => {
    const blocks = computeChangeBlocks("a\nb\nc\nd\ne", "a\nB\nc\nD\ne");
    expect(blocks.map((block) => [block.kind, block.from, block.to])).toEqual([
      ["modified", 2, 2],
      ["modified", 4, 4],
    ]);
  });

  it("treats an untracked file as entirely added", () => {
    const blocks = computeChangeBlocks("", "one\ntwo\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "added", from: 1, to: 2 });
    expect(blocks[0]?.newLines).toEqual(["one", "two"]);
  });

  it("keeps distant edits apart in a large file", () => {
    const base = Array.from({ length: 4000 }, (_, index) => `line ${index}`);
    const current = base.slice();
    current[10] = "changed 10";
    current[2000] = "changed 2000";
    current[3990] = "changed 3990";
    const blocks = computeChangeBlocks(base.join("\n"), current.join("\n"));
    expect(blocks.map((block) => block.from)).toEqual([11, 2001, 3991]);
  });

  it("falls back to one block when the edit graph exceeds the budget", () => {
    const base = Array.from({ length: 3000 }, (_, index) => `line ${index}`);
    const current = base.map((_, index) => `changed ${index}`);
    const blocks = computeChangeBlocks(base.join("\n"), current.join("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("modified");
  });
});
