import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { gitApi } from "../../lib/api";
import type { GitContext } from "../models";
import { useProjectBranch } from "./useProjectBranch";

vi.mock("../../lib/api", () => ({
  gitApi: { context: vi.fn(), onRepositoryChange: vi.fn() },
}));

const project = { id: "p1", root: "/repo", name: "Repo" };
const context = (branch: string | null = "main"): GitContext =>
  ({ repository: { id: 1, branch, headOid: "abcdef123456" } }) as GitContext;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(gitApi.context).mockResolvedValue(context());
  vi.mocked(gitApi.onRepositoryChange).mockResolvedValue(() => {});
});

it("updates the branch on repository changes and window focus and cleans up", async () => {
  const stop = vi.fn();
  vi.mocked(gitApi.onRepositoryChange).mockResolvedValue(stop);
  const { result, unmount } = renderHook(() => useProjectBranch(project));
  await waitFor(() => expect(result.current).toBe("main"));
  const changed = vi.mocked(gitApi.onRepositoryChange).mock.calls[0]![0];
  act(() => changed(2));
  expect(gitApi.context).toHaveBeenCalledTimes(1);
  vi.mocked(gitApi.context).mockResolvedValue(context("dev"));
  await act(async () => changed(1));
  expect(result.current).toBe("dev");
  vi.mocked(gitApi.context).mockResolvedValue(context("release"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(result.current).toBe("release");
  unmount();
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  fireFocus();
  expect(gitApi.context).toHaveBeenCalledTimes(3);
});

function fireFocus() {
  act(() => window.dispatchEvent(new Event("focus")));
}

it("hides the old branch immediately when the project or its root changes", async () => {
  const { result, rerender } = renderHook(({ current }) => useProjectBranch(current), {
    initialProps: { current: project },
  });
  await waitFor(() => expect(result.current).toBe("main"));
  let finish!: (value: GitContext) => void;
  vi.mocked(gitApi.context).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  rerender({ current: { ...project, root: "/new" } });
  expect(result.current).toBeNull();
  vi.mocked(gitApi.context).mockResolvedValue(context("other"));
  rerender({ current: { ...project, id: "p2", root: "/other" } });
  await waitFor(() => expect(result.current).toBe("other"));
  await act(async () => finish(context("stale")));
  expect(result.current).toBe("other");
});

it("ignores an older refresh that finishes after a newer one", async () => {
  const { result } = renderHook(() => useProjectBranch(project));
  await waitFor(() => expect(result.current).toBe("main"));
  let finish!: (value: GitContext) => void;
  vi.mocked(gitApi.context).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  fireFocus();
  vi.mocked(gitApi.context).mockResolvedValue(context("new"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => finish(context("old")));
  expect(result.current).toBe("new");
});

it("hides the branch when the repository disappears or reading fails", async () => {
  const { result } = renderHook(() => useProjectBranch(project));
  await waitFor(() => expect(result.current).toBe("main"));
  vi.mocked(gitApi.context).mockResolvedValue({ repository: null } as GitContext);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(result.current).toBeNull();
  vi.mocked(gitApi.context).mockResolvedValue(context("restored"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(result.current).toBe("restored");
  vi.mocked(gitApi.context).mockRejectedValue(new Error("unavailable"));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(result.current).toBeNull();
});

it("shows detached HEAD with its short commit ID", async () => {
  vi.mocked(gitApi.context).mockResolvedValue(context(null));
  const { result } = renderHook(() => useProjectBranch(project));
  await waitFor(() => expect(result.current).toBe("分离 HEAD · abcdef12"));
});

it("does not request Git context without a current project", () => {
  const { result } = renderHook(() => useProjectBranch(null));
  expect(result.current).toBeNull();
  expect(gitApi.context).not.toHaveBeenCalled();
});
