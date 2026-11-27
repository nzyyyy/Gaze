import { describe, expect, it } from "vitest";

import { basename, errorCode, errorMessage, normalizePath, parentPath, tabKey } from "./utils";

describe("path helpers", () => {
  it("handles root-level, nested and unicode paths", () => {
    expect(basename("src/components/App.tsx")).toBe("App.tsx");
    expect(basename("README.md")).toBe("README.md");
    expect(parentPath("src/components/App.tsx")).toBe("src/components");
    expect(parentPath("README.md")).toBe("");
    expect(basename("源码/你好.ts")).toBe("你好.ts");
  });

  it("normalizes project paths without changing their roots", () => {
    expect(normalizePath("C:\\repo\\")).toBe("C:/repo");
    expect(normalizePath("/repo/")).toBe("/repo");
    expect(normalizePath("/")).toBe("");
  });

  it("builds unambiguous tab keys", () => {
    expect(tabKey("project-a", "src/main.ts")).not.toBe(tabKey("project-b", "src/main.ts"));
  });

  it("reads command error codes and messages", () => {
    expect(errorCode({ code: "conflict", message: "保存冲突" })).toBe("conflict");
    expect(errorCode("plain message")).toBeNull();
    expect(errorMessage({ code: "conflict", message: "保存冲突" })).toBe("保存冲突");
  });
});
