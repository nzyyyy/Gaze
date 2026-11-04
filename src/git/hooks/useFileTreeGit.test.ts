import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { gitApi } from "../../lib/api";
import { useFileTreeGit } from "./useFileTreeGit";
import type { FileChange, GitContext, WorkingTreeSnapshot } from "../models";

vi.mock("../../lib/api", () => ({
  gitApi: { context: vi.fn(), getStatus: vi.fn(), onRepositoryChange: vi.fn() },
}));
const change = (path: string, kind: FileChange["kind"]): FileChange => ({
  path,
  kind,
  staged: false,
  unstaged: true,
  conflict: false,
  ignored: false,
  originalPath: null,
  indexStatus: null,
  worktreeStatus: "M",
  additions: 1,
  deletions: 0,
});
const context = (id: number, prefix = ""): GitContext => ({
  git: { path: "git", version: "2.40", supported: true, error: null },
  repository: { id, kind: "workTree" } as GitContext["repository"],
  projectPrefix: prefix,
  error: null,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(gitApi.onRepositoryChange).mockResolvedValue(() => {});
});

it("loads all projects, sharing one status for projects in the same worktree", async () => {
  vi.mocked(gitApi.context).mockImplementation(async (id) =>
    id === "p3" ? context(2) : context(1, id === "p1" ? "" : "src"),
  );
  vi.mocked(gitApi.getStatus).mockImplementation(async (id) => ({
    id,
    repositoryId: id,
    headOid: null,
    files: [change("src/new.ts", "untracked")],
  }));
  const projects = [
    { id: "p1", name: "Root", root: "/repo" },
    { id: "p2", name: "Sub", root: "/repo/src" },
    { id: "p3", name: "Closed", root: "/other" },
  ];
  const { result } = renderHook(() => useFileTreeGit(projects, 0));
  await waitFor(() => expect(result.current.get("p2")?.get("new.ts")?.kind).toBe("added"));
  expect(result.current.get("p1")?.get("src/new.ts")?.kind).toBe("added");
  await waitFor(() => expect(result.current.get("p3")?.get("src/new.ts")?.kind).toBe("added"));
  expect(gitApi.getStatus).toHaveBeenCalledTimes(2);
  expect(gitApi.context).toHaveBeenCalledWith("p3");
});

it("ignores a late snapshot after the same project points at a different root", async () => {
  let resolveOld!: (snapshot: WorkingTreeSnapshot) => void;
  vi.mocked(gitApi.context).mockResolvedValueOnce(context(1)).mockResolvedValueOnce(context(2));
  vi.mocked(gitApi.getStatus)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    )
    .mockResolvedValueOnce({
      id: 2,
      repositoryId: 2,
      headOid: null,
      files: [change("fresh.ts", "added")],
    });
  const { result, rerender } = renderHook(
    ({ root }) => useFileTreeGit([{ id: "p1", name: "Repo", root }], 0),
    { initialProps: { root: "/old" } },
  );
  await waitFor(() => expect(gitApi.getStatus).toHaveBeenCalledWith(1, false));
  rerender({ root: "/new" });
  await waitFor(() => expect(result.current.get("p1")?.get("fresh.ts")?.kind).toBe("added"));
  await act(async () => {
    resolveOld({ id: 1, repositoryId: 1, headOid: null, files: [change("old.ts", "modified")] });
  });
  expect(result.current.get("p1")?.get("fresh.ts")?.kind).toBe("added");
  expect(result.current.get("p1")?.has("old.ts")).toBe(false);
});

it("clears previous decorations when Git status fails", async () => {
  vi.mocked(gitApi.context).mockResolvedValue(context(1));
  vi.mocked(gitApi.getStatus).mockResolvedValue({
    id: 1,
    repositoryId: 1,
    headOid: null,
    files: [change("a.ts", "modified")],
  });
  const projects = [{ id: "p1", name: "Repo", root: "/repo" }];
  const { result } = renderHook(() => useFileTreeGit(projects, 0));
  await waitFor(() => expect(result.current.get("p1")?.has("a.ts")).toBe(true));
  vi.mocked(gitApi.getStatus).mockRejectedValueOnce(new Error("repository removed"));
  act(() => vi.mocked(gitApi.onRepositoryChange).mock.calls[0]![0](1));
  await waitFor(() => expect(result.current.get("p1")).toBeUndefined());
});

it("keeps other projects' decorations while a newly imported project is loading", async () => {
  const projects = [
    { id: "p1", name: "First", root: "/first" },
    { id: "p2", name: "Second", root: "/second" },
  ];
  vi.mocked(gitApi.context).mockImplementation(async (id) => context(id === "p1" ? 1 : 2));
  vi.mocked(gitApi.getStatus).mockImplementation(async (id) => ({
    id,
    repositoryId: id,
    headOid: null,
    files: [change("changed.ts", "modified")],
  }));
  const { result, rerender } = renderHook(({ items }) => useFileTreeGit(items, 0), {
    initialProps: { items: [projects[0]!] },
  });
  await waitFor(() => expect(result.current.get("p1")?.has("changed.ts")).toBe(true));
  vi.mocked(gitApi.context).mockImplementation(() => new Promise(() => {}));
  rerender({ items: projects });
  expect(result.current.get("p1")?.has("changed.ts")).toBe(true);
});
