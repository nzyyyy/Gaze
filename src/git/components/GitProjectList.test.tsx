import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { api, type FileChange, type GitContext, type RepositoryRefresh } from "../api";
import { GitProjectList } from "./GitProjectList";

vi.mock("../api", () => ({
  api: { context: vi.fn(), refreshRepository: vi.fn(), onRepositoryChange: vi.fn() },
}));

const projects = [
  { id: "p1", name: "Gaze", root: "/repo" },
  { id: "p2", name: "Gaze source", root: "/repo/src" },
  { id: "p3", name: "Clean", root: "/clean" },
  { id: "p4", name: "Notes", root: "/notes" },
];
const file = (fields: Partial<FileChange> = {}): FileChange => ({
  path: "a.ts",
  originalPath: null,
  kind: "modified",
  indexStatus: "M",
  worktreeStatus: "M",
  staged: true,
  unstaged: true,
  conflict: false,
  ignored: false,
  additions: 3,
  deletions: 2,
  ...fields,
});
const refresh = (id: number, files: FileChange[] = []): RepositoryRefresh => ({
  summary: {
    id,
    path: id === 1 ? "/repo" : "/clean",
    name: "Repo",
    group: null,
    favorite: false,
    order: 0,
    kind: "workTree",
    capabilities: {
      canRead: true,
      canWriteWorkTree: true,
      canManageRefs: true,
      canManageRemotes: true,
    },
    branch: "main",
    headOid: "abcdef123",
    changedCount: files.length,
    conflictCount: 0,
    ahead: 0,
    behind: 0,
    lastCommit: null,
    ongoing: null,
    error: null,
  },
  snapshot: { id: 1, repositoryId: id, headOid: "abcdef123", files },
});
const props = { projects, active: true, onSelect: vi.fn(), selectedProjectId: "p1" };
const row = (name: string) => screen.getByText(name, { selector: "strong" }).closest("button")!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.onRepositoryChange).mockResolvedValue(() => {});
  vi.mocked(api.context).mockImplementation(async (id) => ({
    git: { path: "git", version: "2.40", supported: true, error: null },
    repository: id === "p4" ? null : refresh(id === "p3" ? 2 : 1).summary,
    projectPrefix: id === "p2" ? "src" : "",
    error: null,
  }));
  vi.mocked(api.refreshRepository).mockImplementation(async (id) => refresh(id));
});

it("lists all imported projects, deduplicates shared worktrees and sums known line changes once", async () => {
  vi.mocked(api.refreshRepository).mockImplementation(async (id) =>
    refresh(
      id,
      id === 1
        ? [
            file(),
            file({ path: "new.ts", kind: "untracked", staged: false, additions: 5, deletions: 0 }),
            file({ path: "image.png", additions: null, deletions: null }),
            file({ path: "ignored.ts", ignored: true, additions: 999, deletions: 999 }),
          ]
        : [],
    ),
  );
  render(<GitProjectList {...props} />);
  expect(
    await screen.findAllByLabelText("新增 8 行，删除 2 行，1 个文件无法统计行数"),
  ).toHaveLength(2);
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
  expect(row("Gaze")).toHaveClass("has-changes");
  expect(row("Gaze")).toHaveAttribute("aria-current", "true");
  expect(within(row("Gaze")).getByText("+8")).toHaveClass("git-project-additions");
  expect(within(row("Gaze")).getByText("−2")).toHaveClass("git-project-deletions");
  expect(within(row("Clean")).getByText("工作区干净")).toBeInTheDocument();
  expect(row("Clean")).not.toHaveClass("has-changes");
  expect(within(row("Notes")).getByText("Git 不可用")).toBeInTheDocument();
  expect(api.refreshRepository).toHaveBeenCalledTimes(2);
  fireEvent.click(row("Gaze source"));
  expect(props.onSelect).toHaveBeenCalledWith(projects[1]);
});

it("shows pending sync counts for shared repositories and clears them after syncing", async () => {
  vi.mocked(api.refreshRepository).mockImplementation(async (id) => {
    const next = refresh(id);
    return { ...next, summary: { ...next.summary, ahead: id === 1 ? 3 : 0, behind: 2 } };
  });
  render(<GitProjectList {...props} />);
  await screen.findAllByLabelText("待推送 3 个提交");
  for (const name of ["Gaze", "Gaze source"]) {
    expect(within(row(name)).getByLabelText("待推送 3 个提交")).toHaveTextContent("↑3");
    expect(within(row(name)).getByLabelText("待拉取 2 个提交")).toHaveTextContent("↓2");
  }
  expect(within(row("Clean")).queryByText("↑0")).not.toBeInTheDocument();
  expect(within(row("Clean")).getByLabelText("待拉取 2 个提交")).toBeInTheDocument();
  expect(row("Notes").querySelector(".git-sync-counts")).toBeNull();
  expect(api.refreshRepository).toHaveBeenCalledTimes(2);
  vi.mocked(api.refreshRepository).mockImplementation(async (id) => refresh(id));
  act(() => vi.mocked(api.onRepositoryChange).mock.calls[0]![0](1));
  await waitFor(() => expect(row("Gaze").querySelector(".git-sync-counts")).toBeNull());
  expect(row("Gaze source").querySelector(".git-sync-counts")).toBeNull();
  expect(within(row("Clean")).getByLabelText("待拉取 2 个提交")).toBeInTheDocument();
});

it("keeps branches and totals visible while refreshing on return", async () => {
  vi.mocked(api.refreshRepository).mockImplementation(async (id) => refresh(id, [file()]));
  const { rerender } = render(<GitProjectList {...props} />);
  await screen.findAllByLabelText("新增 3 行，删除 2 行");
  rerender(<GitProjectList {...props} active={false} />);
  let finish!: (value: GitContext) => void;
  vi.mocked(api.context).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  vi.mocked(api.refreshRepository).mockImplementation(async (id) => ({
    ...refresh(id),
    summary: { ...refresh(id).summary, branch: "dev" },
  }));
  rerender(<GitProjectList {...props} />);
  expect(within(row("Gaze")).getByText("main")).toBeInTheDocument();
  expect(row("Gaze")).toHaveClass("has-changes");
  expect(within(row("Gaze")).getByLabelText("新增 3 行，删除 2 行")).toBeInTheDocument();
  expect(screen.queryByText("正在读取…")).not.toBeInTheDocument();
  await act(async () => {
    finish({ repository: refresh(1).summary } as GitContext);
  });
  await waitFor(() => expect(within(row("Gaze")).getByText("dev")).toBeInTheDocument());
  expect(row("Gaze")).not.toHaveClass("has-changes");
});

it("shows the selected preloaded snapshot before sidebar requests resolve", () => {
  const next = refresh(1, [file()]);
  vi.mocked(api.context).mockReturnValue(new Promise(() => {}));
  render(<GitProjectList {...props} selectedRepository={next.summary} snapshot={next.snapshot!} />);
  expect(within(row("Gaze")).getByText("main")).toBeInTheDocument();
  expect(within(row("Gaze")).getByLabelText("新增 3 行，删除 2 行")).toBeInTheDocument();
});

it("invalidates cached results when a project root changes", async () => {
  const { rerender } = render(<GitProjectList {...props} projects={[projects[0]!]} />);
  await screen.findByText("工作区干净");
  vi.mocked(api.context).mockReturnValue(new Promise(() => {}));
  rerender(<GitProjectList {...props} projects={[{ ...projects[0]!, root: "/new" }]} />);
  expect(within(row("Gaze")).getByText("正在读取…")).toBeInTheDocument();
  expect(screen.queryByText("工作区干净")).not.toBeInTheDocument();
});

it("refreshes only the changed repository and clears its highlight when clean", async () => {
  vi.mocked(api.refreshRepository).mockImplementation(async (id) =>
    refresh(id, id === 1 ? [file()] : []),
  );
  render(<GitProjectList {...props} />);
  await screen.findAllByLabelText("新增 3 行，删除 2 行");
  vi.mocked(api.refreshRepository).mockImplementation(async (id) => ({
    ...refresh(id),
    summary: { ...refresh(id).summary, branch: "dev" },
  }));
  act(() => vi.mocked(api.onRepositoryChange).mock.calls[0]![0](1));
  await waitFor(() => expect(row("Gaze")).not.toHaveClass("has-changes"));
  expect(within(row("Gaze")).getByText("dev")).toBeInTheDocument();
  expect(vi.mocked(api.refreshRepository).mock.calls.map(([id]) => id)).toEqual([1, 2, 1]);
});

it("uses a newer selected snapshot immediately and keeps project navigation available", async () => {
  const { rerender } = render(<GitProjectList {...props} />);
  await screen.findAllByText("工作区干净");
  const next = refresh(1, [file({ additions: 10, deletions: 4, conflict: true })]);
  rerender(
    <GitProjectList
      {...props}
      selectedRepository={{ ...next.summary, ahead: 4, behind: 1 }}
      snapshot={{ ...next.snapshot!, id: 5 }}
    />,
  );
  expect(screen.getAllByLabelText("新增 10 行，删除 4 行")).toHaveLength(2);
  expect(row("Gaze")).toHaveClass("has-conflicts");
  expect(screen.getAllByLabelText("待推送 4 个提交")).toHaveLength(2);
  expect(screen.getAllByLabelText("待拉取 1 个提交")).toHaveLength(2);
  fireEvent.click(row("Clean"));
  expect(props.onSelect).toHaveBeenCalledWith(projects[2]);
  expect(row("Clean")).toBeEnabled();
});

it("removes old totals on failure even when the selected snapshot still contains changes", async () => {
  const next = refresh(1, [file()]);
  vi.mocked(api.refreshRepository).mockResolvedValue(next);
  render(
    <GitProjectList
      {...props}
      projects={[projects[0]!]}
      selectedRepository={next.summary}
      snapshot={next.snapshot!}
    />,
  );
  await screen.findByLabelText("新增 3 行，删除 2 行");
  vi.mocked(api.refreshRepository).mockRejectedValueOnce(new Error("repository unavailable"));
  act(() => vi.mocked(api.onRepositoryChange).mock.calls[0]![0](1));
  await screen.findByText("读取失败");
  expect(row("Gaze")).not.toHaveClass("has-changes");
  expect(screen.queryByLabelText("新增 3 行，删除 2 行")).not.toBeInTheDocument();
  expect(row("Gaze")).toHaveAttribute(
    "data-tooltip",
    expect.stringContaining("repository unavailable"),
  );
});

it("ignores responses from a removed project root and stops reading while hidden", async () => {
  let finish!: (value: GitContext) => void;
  vi.mocked(api.context).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { rerender } = render(<GitProjectList {...props} projects={[projects[0]!]} />);
  rerender(<GitProjectList {...props} projects={[{ ...projects[0]!, root: "/new" }]} />);
  await screen.findByText("工作区干净");
  await act(async () => {
    finish({ repository: refresh(99).summary } as GitContext);
  });
  expect(api.refreshRepository).not.toHaveBeenCalledWith(99);
  rerender(<GitProjectList {...props} active={false} />);
  const count = vi.mocked(api.refreshRepository).mock.calls.length;
  fireEvent.focus(window);
  act(() => vi.mocked(api.onRepositoryChange).mock.calls[0]![0](1));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(api.refreshRepository).toHaveBeenCalledTimes(count);
});
