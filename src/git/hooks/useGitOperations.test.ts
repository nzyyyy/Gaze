import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type OperationEvent, type RepositorySummary } from "../api";
import { useGitOperations } from "./useGitOperations";

vi.mock("../api", () => ({
  api: {
    onOperationEvent: vi.fn(),
    previewOperation: vi.fn(),
    startOperation: vi.fn(),
    cancelOperation: vi.fn(),
  },
}));
let receive: (event: OperationEvent) => void;
const repository = { id: 1, path: "/repo" } as RepositorySummary;
const request = { type: "discardTracked" as const, paths: ["a.ts"] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.onOperationEvent).mockImplementation(async (handler) => {
    receive = handler;
    return () => {};
  });
  vi.mocked(api.previewOperation).mockResolvedValue({
    title: "Discard",
    summary: "a.ts",
    risk: "destructive",
    requiresConfirmation: true,
    affectedPaths: ["a.ts"],
    affectedRefs: [],
    recoverable: false,
  });
});

it("waits for confirmation and handles completion arriving before the invoke reply", async () => {
  const settle = vi.fn().mockResolvedValue(undefined),
    prepare = vi.fn().mockResolvedValue(settle),
    refresh = vi.fn().mockResolvedValue(undefined),
    completed = vi.fn();
  vi.mocked(api.startOperation).mockImplementation(async () => {
    receive({
      operationId: 7,
      repositoryId: 1,
      kind: "finished",
      message: "done",
      exitCode: 0,
      outcome: "succeeded",
    });
    return { operationId: 7, accepted: true };
  });
  const { result } = renderHook(() => useGitOperations(repository, prepare, refresh));
  await act(async () => {
    await result.current.run(request, completed);
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(api.startOperation).not.toHaveBeenCalled();
  act(() => result.current.confirmPending());
  await waitFor(() => expect(settle).toHaveBeenCalledWith("succeeded"));
  expect(prepare).toHaveBeenCalledWith("/repo", request);
  expect(api.startOperation).toHaveBeenCalledWith(1, request, true);
  expect(completed).toHaveBeenCalledWith("succeeded");
  expect(result.current.busy).toBe(false);
});

it("notifies success without opening the output panel", async () => {
  vi.mocked(api.previewOperation).mockResolvedValue({
    ...(await api.previewOperation(1, request)),
    requiresConfirmation: false,
  });
  const prepare = vi.fn().mockResolvedValue(vi.fn()),
    refresh = vi.fn().mockResolvedValue(undefined),
    notice = vi.fn();
  vi.mocked(api.startOperation).mockImplementation(async () => {
    receive({
      operationId: 9,
      repositoryId: 1,
      kind: "finished",
      message: "已推送。",
      exitCode: 0,
      outcome: "succeeded",
    });
    return { operationId: 9, accepted: true };
  });
  const { result } = renderHook(() => useGitOperations(repository, prepare, refresh, notice));
  await act(async () => {
    await result.current.run(request);
  });
  expect(notice).toHaveBeenCalledWith("Git 操作已完成。");
  expect(result.current.outputOpen).toBe(false);
});

it("does not execute Git if editor preparation fails", async () => {
  vi.mocked(api.previewOperation).mockResolvedValue({
    ...(await api.previewOperation(1, request)),
    requiresConfirmation: false,
  });
  const prepare = vi.fn().mockRejectedValue(new Error("unsaved conflict")),
    completed = vi.fn(),
    refresh = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useGitOperations(repository, prepare, refresh));
  await act(async () => {
    await result.current.run(request, completed);
  });
  expect(api.startOperation).not.toHaveBeenCalled();
  expect(completed).toHaveBeenCalledWith("failed");
  expect(result.current.status).toBe("unsaved conflict");
  expect(result.current.outputOpen).toBe(true);
});

it("cancels a pending confirmation when the repository changes", async () => {
  const completed = vi.fn(),
    prepare = vi.fn(),
    refresh = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(
    ({ id }) => useGitOperations({ ...repository, id }, prepare, refresh),
    { initialProps: { id: 1 } },
  );
  await act(async () => {
    await result.current.run(request, completed);
  });
  rerender({ id: 2 });
  expect(result.current.pending).toBeUndefined();
  expect(completed).toHaveBeenCalledWith("cancelled");
  expect(api.startOperation).not.toHaveBeenCalled();
});

it("ignores operation output and completion from other repositories", () => {
  const notice = vi.fn();
  const { result } = renderHook(() => useGitOperations(repository, vi.fn(), vi.fn(), notice));
  act(() =>
    receive({
      operationId: 20,
      repositoryId: 2,
      kind: "finished",
      message: "other",
      outcome: "succeeded",
      exitCode: 0,
    }),
  );
  expect(result.current.logs).toEqual([]);
  expect(result.current.status).toBe("");
  expect(notice).not.toHaveBeenCalled();
});
