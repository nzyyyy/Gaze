import { describe, expect, it } from "vitest";

import { fileIconId } from "./FileIcon";

describe("fileIconId", () => {
  it("按扩展名和特殊文件名选择图标", () => {
    expect(fileIconId("main.ts")).toBe("typescript");
    expect(fileIconId("main.rs")).toBe("rust");
    expect(fileIconId("package.json")).toBe("nodejs");
    expect(fileIconId("Makefile")).toBe("makefile");
    expect(fileIconId("unknown.zzz")).toBe("file");
  });
});
