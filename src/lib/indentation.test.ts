import { describe, expect, it } from "vitest";
import { detectIndentation } from "./indentation";

describe("detectIndentation", () => {
  it.each([
    ["function run() {\n  first();\n  second();\n}", 4, "  "],
    ["function run() {\n    first();\n    second();\n}", 2, "    "],
    ["if ready:\n    if value:\n        run()", 2, "    "],
    ["function run() {\n\tfirst();\n}", 4, "\t"],
    ["const first = 1;\nconst second = 2;", 2, "  "],
    ["/*\n * A comment\n */\nfunction run() {\n  first();\n}", 4, "  "],
    ["function run() {\r\n  first();\r\n}", 4, "  "],
  ])("uses the existing indentation or the preference fallback", (text, fallback, expected) => {
    expect(detectIndentation(text, fallback)).toBe(expected);
  });
});
