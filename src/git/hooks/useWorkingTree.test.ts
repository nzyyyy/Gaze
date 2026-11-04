import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api, type DiffFile, type FileChange } from "../api";
import { useWorkingTree } from "./useWorkingTree";

vi.mock("../api", () => ({ api: { getDiff: vi.fn(), getStatus: vi.fn() } }));
const file = (path: string): FileChange => ({
  path,
  originalPath: null,
  kind: "modified",
  staged: false,
  unstaged: true,
  indexStatus: null,
  worktreeStatus: "M",
  conflict: false,
  ignored: false,
  additions: 1,
  deletions: 0,
});
const diff = (path: string): DiffFile => ({
  path,
  staged: false,
  binary: false,
  tooLarge: false,
  patch: "mode change",
  hunks: [],
});

it("ignores an older file diff after another file is selected and refreshes metadata-only diffs", async () => {
  let finishOld!: (value: DiffFile) => void;
  vi.mocked(api.getDiff)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValue(diff("new.ts"));
  const reportError = vi.fn(),
    selectedIdRef = { current: 1 },
    setRepositoriesRef = { current: vi.fn() };
  const { result } = renderHook(() =>
    useWorkingTree({ reportError, selectedId: 1, selectedIdRef, setRepositoriesRef }),
  );
  act(() =>
    result.current.setSnapshot({
      id: 1,
      repositoryId: 1,
      headOid: "head",
      files: [file("old.ts"), file("new.ts")],
    }),
  );
  act(() => {
    void result.current.openDiff(file("old.ts"));
  });
  await act(async () => {
    await result.current.openDiff(file("new.ts"));
  });
  await act(async () => {
    finishOld(diff("old.ts"));
  });
  expect(result.current.diff?.path).toBe("new.ts");
  await act(async () => {
    await result.current.reloadOpenDiff({
      id: 2,
      repositoryId: 1,
      headOid: "head",
      files: [file("new.ts")],
    });
  });
  expect(api.getDiff).toHaveBeenLastCalledWith(1, 2, "new.ts", false, false);
  expect(result.current.diffSnapshotId).toBe(2);
  expect(reportError).not.toHaveBeenCalled();
});

it("refetches the open diff with the whitespace flag after toggling", async () => {
  vi.mocked(api.getDiff).mockResolvedValue(diff("new.ts"));
  vi.mocked(api.getStatus).mockResolvedValue({
    id: 2,
    repositoryId: 1,
    headOid: "head",
    files: [file("new.ts")],
  });
  const reportError = vi.fn(),
    selectedIdRef = { current: 1 },
    setRepositoriesRef = { current: vi.fn() };
  const { result } = renderHook(() =>
    useWorkingTree({ reportError, selectedId: 1, selectedIdRef, setRepositoriesRef }),
  );
  act(() =>
    result.current.setSnapshot({
      id: 1,
      repositoryId: 1,
      headOid: "head",
      files: [file("new.ts")],
    }),
  );
  await act(async () => {
    await result.current.openDiff(file("new.ts"));
  });
  expect(result.current.ignoreWhitespace).toBe(false);
  await act(async () => {
    result.current.toggleWhitespace();
  });
  await waitFor(() => expect(api.getDiff).toHaveBeenLastCalledWith(1, 2, "new.ts", false, true));
  expect(result.current.ignoreWhitespace).toBe(true);
});
