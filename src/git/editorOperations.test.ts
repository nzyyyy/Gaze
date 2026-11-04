import { describe, expect, it, vi } from "vitest";
import { insideWorktree, prepareEditors } from "./editorOperations";
import type { SaveResult } from "../components/CodeReader";

const editor = (dirty = false) => ({
  isDirty: () => dirty,
  prepareFileOperation: vi.fn().mockResolvedValue({ status: "clean" } satisfies SaveResult),
  finishFileOperation: vi.fn(),
});

describe("Git editor coordination", () => {
  it("keeps unsaved work out of an index-only commit", async () => {
    const handle = editor(true);
    const finish = await prepareEditors([handle], {
      type: "commit",
      message: "index only",
      amend: false,
      signoff: false,
    });
    expect(handle.prepareFileOperation).toHaveBeenCalledWith({ save: false });
    finish("succeeded");
    expect(handle.finishFileOperation).toHaveBeenCalledWith({ reload: false });
  });

  it("saves every alias before checkout and releases all editors if one cannot save", async () => {
    const first = editor(),
      second = editor(true);
    second.prepareFileOperation.mockResolvedValue({ status: "conflict", message: "external edit" });
    await expect(
      prepareEditors([first, second], { type: "switchBranch", name: "other" }),
    ).rejects.toThrow("external edit");
    expect(first.prepareFileOperation).toHaveBeenCalledWith({ save: true });
    expect(first.finishFileOperation).toHaveBeenCalledOnce();
    expect(second.finishFileOperation).toHaveBeenCalledOnce();
  });

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "discard outcome %s only drops dirty buffers on success",
    async (outcome) => {
      const handle = editor(true);
      const finish = await prepareEditors([handle], { type: "discardTracked", paths: ["a.ts"] });
      expect(handle.prepareFileOperation).toHaveBeenCalledWith({ save: false });
      finish(outcome);
      expect(handle.finishFileOperation).toHaveBeenCalledWith({ reload: outcome === "succeeded" });
    },
  );

  it("uses path boundaries and Windows case folding without merging neighboring repositories", () => {
    expect(insideWorktree("/repo/src/a.ts", "/repo")).toBe(true);
    expect(insideWorktree("/repo-other/a.ts", "/repo")).toBe(false);
    expect(insideWorktree("c:\\Repo\\src\\a.ts", "C:/repo")).toBe(true);
  });
});
