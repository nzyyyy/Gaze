import { expect, it } from "vitest";
import { matchesNavigationQuery, parseFileQuery } from "./navigationSearch";

it("parses one-based line and column offsets and leaves ordinary queries intact", () => {
  expect(parseFileQuery(" src/a.ts:42:5 ")).toEqual({
    path: "src/a.ts",
    position: { line: 41, character: 4 },
  });
  expect(parseFileQuery("src/a.ts:42")).toEqual({
    path: "src/a.ts",
    position: { line: 41, character: 0 },
  });
  for (const query of ["src/a.ts", "src/a.ts:0", "src/a.ts:42:0", "src/a.ts:9007199254740992"]) {
    expect(parseFileQuery(query)).toEqual({ path: query });
  }
  expect(matchesNavigationQuery("Demo /src/Foo.ts", "demo foo")).toBe(true);
  expect(matchesNavigationQuery("Demo /src/Foo.ts", "demo bar")).toBe(false);
});
