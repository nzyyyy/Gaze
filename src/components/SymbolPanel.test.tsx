import { describe, expect, it } from "vitest";

import { flattenOutline } from "./SymbolPanel";
import type { DocumentSymbol } from "../lib/types";

const symbol = (name: string, line: number, children: DocumentSymbol[] = []): DocumentSymbol => ({
  name,
  detail: null,
  kind: "function",
  line,
  character: 0,
  endLine: line,
  endCharacter: 4,
  children,
});

describe("flattenOutline", () => {
  it("preserves hierarchy order and depth without rendering the tree eagerly", () => {
    const flat = flattenOutline([
      symbol("outer", 1, [symbol("inner", 2, [symbol("deep", 3)])]),
      symbol("sibling", 8),
    ]);
    expect(flat.map((entry) => [entry.symbol.name, entry.depth])).toEqual([
      ["outer", 0],
      ["inner", 1],
      ["deep", 2],
      ["sibling", 0],
    ]);
    expect(new Set(flat.map((entry) => entry.key)).size).toBe(4);
  });
});
