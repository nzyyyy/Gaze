import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { EditorTab } from "../components/CodeReader";
import type { FsChangeEvent } from "./types";
import { useFileChanges } from "./useFileChanges";

const apiMock = vi.hoisted(() => ({ onFsChange: vi.fn() }));
vi.mock("./api", () => ({ api: apiMock }));

function setup() {
  const tab = (path: string, projectId = "p1"): EditorTab => ({
    key: `${projectId}\u0000${path}`,
    projectId,
    projectName: projectId,
    path,
    name: path,
  });
  const clean = tab("src/clean.ts");
  const dirty = tab("src/dirty.ts");
  const other = tab("src/clean.ts", "p2");
  const options = {
    tabsRef: { current: [clean, dirty, other] },
    activeKeyRef: { current: dirty.key },
    fileOperationBusyRef: { current: false },
    isWorkspaceReady: vi.fn(() => true),
    isTabDirty: vi.fn((key: string) => key === dirty.key),
    notify: vi.fn(),
  };
  let listener: (event: FsChangeEvent) => void;
  const unlisten = vi.fn();
  apiMock.onFsChange.mockImplementation(async (callback) => {
    listener = callback;
    return unlisten;
  });
  const hook = renderHook(() => useFileChanges(options));
  const emit = (event: Partial<FsChangeEvent> = {}) =>
    listener({
      projectId: "p1",
      changedFiles: [],
      changedDirectories: [],
      removedPaths: [],
      ...event,
    });
  return { ...hook, options, emit, unlisten, clean, dirty, other };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T00:00:00Z"));
  apiMock.onFsChange.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("reloads clean files while preserving dirty buffers on directory removal and overflow", () => {
  const { result, options, emit, clean, dirty, other } = setup();
  act(() => emit({ removedPaths: ["src"] }));
  expect(result.current.fileRevisions).toEqual({ [clean.key]: 1 });
  expect(result.current.externalChanges).toEqual({ [dirty.key]: 1 });
  expect(options.notify).toHaveBeenCalledWith("当前文件已在磁盘上修改，未保存的编辑已保留。");

  act(() => emit({ rescan: true }));
  expect(result.current.fileRevisions).toEqual({ [clean.key]: 2 });
  expect(result.current.externalChanges).toEqual({ [dirty.key]: 2 });
  expect(result.current.fileRevisions[other.key]).toBeUndefined();
  options.activeKeyRef.current = clean.key;
  act(() => emit({ removedPaths: [clean.path] }));
  expect(options.notify).toHaveBeenLastCalledWith("当前文件已在磁盘上删除。");
});

it("filters recent self-saves and forgets all file state when a tab closes", () => {
  const { result, emit, clean } = setup();
  act(() => result.current.handleSaved(clean.key));
  act(() => emit({ changedFiles: [clean.path] }));
  expect(result.current.fileRevisions).toEqual({});
  expect(result.current.refreshToken).toBe(1);
  act(() => vi.advanceTimersByTime(2500));
  act(() => emit({ changedFiles: [clean.path] }));
  expect(result.current.fileRevisions[clean.key]).toBe(1);

  act(() => result.current.handleSaved(clean.key));
  act(() => result.current.forgetFileState(clean.key));
  expect(result.current.fileRevisions).toEqual({});
  act(() => emit({ changedFiles: [clean.path] }));
  expect(result.current.fileRevisions[clean.key]).toBe(1);
});

it("replays queued events against the latest tabs and dirty state after unlocking, only once", () => {
  const { result, options, emit, clean, dirty } = setup();
  options.fileOperationBusyRef.current = true;
  act(() => emit({ changedFiles: [clean.path, dirty.path] }));
  expect(result.current.refreshToken).toBe(0);
  expect(options.notify).not.toHaveBeenCalled();

  options.tabsRef.current = [clean];
  options.isTabDirty.mockReturnValue(true);
  options.activeKeyRef.current = clean.key;
  options.fileOperationBusyRef.current = false;
  act(() => result.current.flushFsChanges());
  expect(result.current.fileRevisions).toEqual({});
  expect(result.current.externalChanges).toEqual({ [clean.key]: 1 });
  act(() => result.current.flushFsChanges());
  expect(result.current.refreshToken).toBe(1);
  act(() => result.current.forgetFileState(clean.key));
  expect(result.current.externalChanges).toEqual({});
});

it("ignores events before the workspace is ready and merges directory refreshes per batch", () => {
  const { result, options, emit } = setup();
  options.isWorkspaceReady.mockReturnValue(false);
  act(() => emit({ changedDirectories: ["ignored"] }));
  expect(result.current.refreshToken).toBe(0);
  options.isWorkspaceReady.mockReturnValue(true);
  act(() => {
    emit({ changedDirectories: ["src"] });
    emit({ changedDirectories: ["src", "docs"] });
    emit({ projectId: "p2", changedDirectories: [""] });
  });
  expect(result.current.treeRefresh.directories).toEqual(
    new Map([
      ["p1", ["src", "docs"]],
      ["p2", [""]],
    ]),
  );
  act(() => {
    emit({ rescan: true });
    emit({ changedDirectories: ["later"] });
  });
  expect(result.current.treeRefresh.directories.get("p1")).toBeNull();
  act(() => vi.runOnlyPendingTimers());
  act(() => emit({ changedDirectories: ["next"] }));
  expect(result.current.treeRefresh.directories).toEqual(new Map([["p1", ["next"]]]));
});

it("removes its subscription and directory timer on unmount", async () => {
  const { emit, unmount, unlisten } = setup();
  await act(async () => {});
  act(() => emit({ changedDirectories: ["src"] }));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(unlisten).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("releases a subscription that finishes registering after unmount", async () => {
  let resolve!: (unlisten: () => void) => void;
  apiMock.onFsChange.mockReturnValue(new Promise<() => void>((done) => (resolve = done)));
  const { unmount } = renderHook(() =>
    useFileChanges({
      tabsRef: { current: [] },
      activeKeyRef: { current: null },
      fileOperationBusyRef: { current: false },
      isWorkspaceReady: () => true,
      isTabDirty: () => false,
      notify: vi.fn(),
    }),
  );
  unmount();
  const unlisten = vi.fn();
  await act(async () => resolve(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
});
