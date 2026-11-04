import { expect, it } from "vitest";
import { fileTreeStatus } from "./fileTreeStatus";
import type { FileChange } from "./models";

const file = (path: string, overrides: Partial<FileChange> = {}): FileChange => ({
  path,
  originalPath: null,
  kind: "modified",
  staged: false,
  unstaged: true,
  conflict: false,
  ignored: false,
  indexStatus: null,
  worktreeStatus: "M",
  additions: 1,
  deletions: 0,
  ...overrides,
});

it("maps repository paths to a project subdirectory and propagates deletions and rename sources", () => {
  const statuses = fileTreeStatus(
    [
      file("src/old/deleted.ts", { kind: "deleted" }),
      file("src/new/moved.ts", { kind: "renamed", originalPath: "src/before/moved.ts" }),
      file("src2/outside.ts"),
      file("README.md"),
      file("src/ignored/secret.ts", { ignored: true }),
    ],
    "src",
  );
  expect(statuses.get("old")?.kind).toBe("modified");
  expect(statuses.get("new/moved.ts")?.kind).toBe("renamed");
  expect(statuses.get("before")?.label).toBe("包含 Git 变更");
  expect(statuses.has("before/moved.ts")).toBe(false);
  expect(statuses.has("outside.ts")).toBe(false);
  expect(statuses.has("README.md")).toBe(false);
  expect(statuses.has("ignored")).toBe(false);
});

it("keeps conflict priority regardless of file order and separates untracked from staged additions", () => {
  for (const files of [
    [file("src/a.ts", { conflict: true }), file("src/b.ts")],
    [file("src/b.ts"), file("src/a.ts", { conflict: true })],
  ]) {
    const statuses = fileTreeStatus(files, "");
    expect(statuses.get("src")?.kind).toBe("conflict");
    expect(statuses.get("")?.kind).toBe("conflict");
  }
  const statuses = fileTreeStatus(
    [
      file("new.ts", { kind: "untracked" }),
      file("added.ts", { kind: "added", staged: true, unstaged: false }),
    ],
    "",
  );
  expect(statuses.get("new.ts")?.kind).toBe("added");
  expect(statuses.get("added.ts")?.label).toBe("已新增（已暂存）");
});
