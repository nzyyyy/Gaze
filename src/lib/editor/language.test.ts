import { describe, expect, it } from "vitest";

import { isMarkdownFile, matchLanguage } from "./language";

describe("matchLanguage", () => {
  it("recognizes supported Markdown extensions regardless of case", () => {
    for (const name of [
      "README.md",
      "guide.markdown",
      "notes.mkd",
      "README.MD",
      "Guide.MARKDOWN",
      "x.MkD",
    ]) {
      expect(isMarkdownFile(name)).toBe(true);
    }
    expect(isMarkdownFile("markdown.ts")).toBe(false);
    expect(isMarkdownFile("README.mdx")).toBe(false);
  });
  it("loads known languages from filenames and extensions", () => {
    expect(matchLanguage("main.ts").description).not.toBeNull();
    expect(matchLanguage("Component.tsx").description).not.toBeNull();
    expect(matchLanguage("Cargo.toml").label).toBe("TOML");
  });

  it("falls back to plain text for unknown files", () => {
    const match = matchLanguage("mystery.zzzz");
    expect(match.label).toBe("Plain Text");
    expect(match.description).toBeNull();
  });
});
