import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GitWorkspace from "./GitWorkspace";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  type GitContext,
  type OperationEvent,
  type OperationPreview,
  type RepositoryRefresh,
  type RepositorySummary,
} from "./api";

vi.mock("./api", () => ({
  api: {
    context: vi.fn(),
    refreshRepository: vi.fn(),
    onOperationEvent: vi.fn(),
    onRepositoryChange: vi.fn(),
    getDiff: vi.fn(),
    getBranches: vi.fn(),
    getHistory: vi.fn(),
    getTags: vi.fn(),
    getRemotes: vi.fn(),
    getSubmodules: vi.fn(),
    getStashes: vi.fn(),
    previewOperation: vi.fn(),
    startOperation: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
const repository: RepositorySummary = {
  id: 1,
  path: "/repo",
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
  headOid: "abc",
  changedCount: 1,
  conflictCount: 0,
  ahead: 0,
  behind: 0,
  lastCommit: null,
  ongoing: null,
  error: null,
};
const context = (id = 1): GitContext => ({
  git: { path: "/usr/bin/git", version: "2.40", supported: true, error: null },
  repository: { ...repository, id },
  projectPrefix: "src",
  error: null,
});
const project = { id: "p1", name: "Project", root: "/repo/src" };
const callbacks = {
  prepareOperation: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenTerminal: vi.fn(),
  onSelectProject: vi.fn(),
  projects: [project],
  sidebarContainer: null as HTMLElement | null,
};
let sidebarContainer: HTMLElement;
beforeEach(() => {
  vi.resetAllMocks();
  sidebarContainer = document.createElement("div");
  document.body.append(sidebarContainer);
  callbacks.sidebarContainer = sidebarContainer;
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(api.context).mockResolvedValue(context());
  vi.mocked(api.refreshRepository).mockImplementation(async (id) => ({
    summary: { ...repository, id },
    snapshot: {
      id: 2,
      repositoryId: id,
      headOid: "abc",
      files: [
        {
          path: "src/a.ts",
          kind: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
          ignored: false,
          originalPath: null,
          indexStatus: null,
          worktreeStatus: "M",
          additions: 1,
          deletions: 0,
        },
      ],
    },
  }));
  vi.mocked(api.onOperationEvent).mockResolvedValue(() => {});
  vi.mocked(api.onRepositoryChange).mockResolvedValue(() => {});
  vi.mocked(api.getDiff).mockResolvedValue({
    path: "src/a.ts",
    staged: false,
    binary: false,
    tooLarge: false,
    patch: "mode change",
    hunks: [],
  });
});
afterEach(() => sidebarContainer.remove());

it("keeps projects, diffs and history browsable while disabling repository writes", async () => {
  let receive!: (event: OperationEvent) => void;
  vi.mocked(api.onOperationEvent).mockImplementation(async (handler) => {
    receive = handler;
    return () => {};
  });
  vi.mocked(api.previewOperation).mockResolvedValue({
    requiresConfirmation: false,
  } as OperationPreview);
  vi.mocked(api.startOperation).mockResolvedValue({ operationId: 9, accepted: true });
  vi.mocked(api.getHistory).mockResolvedValue({ commits: [], nextCursor: null });
  vi.mocked(api.getBranches).mockResolvedValue([]);
  const second = { id: "p2", name: "Second", root: "/second" };
  render(<GitWorkspace project={project} active {...callbacks} projects={[project, second]} />);
  await screen.findByRole("button", { name: "src/a.ts" });
  fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
  await waitFor(() => expect(api.startOperation).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "暂存 src/a.ts" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
  expect(await screen.findByRole("button", { name: "文件历史" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "在编辑器打开" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "历史" }));
  await waitFor(() => expect(api.getHistory).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "历史" })).toBeEnabled();
  const row = screen.getByText(second.name, { selector: "strong" }).closest("button")!;
  expect(row).toBeEnabled();
  fireEvent.click(row);
  expect(callbacks.onSelectProject).toHaveBeenCalledWith(second);
  await act(async () =>
    receive({
      operationId: 9,
      repositoryId: 1,
      kind: "finished",
      message: "done",
      outcome: "succeeded",
      exitCode: 0,
    }),
  );
});

it.each([
  [3, 0],
  [0, 2],
  [3, 2],
  [0, 0],
])("highlights pending sync counts and actions for ahead=%i behind=%i", async (ahead, behind) => {
  const next = await api.refreshRepository(1);
  vi.mocked(api.refreshRepository).mockResolvedValue({
    ...next,
    summary: { ...next.summary, ahead, behind },
  });
  const { container } = render(<GitWorkspace project={project} active {...callbacks} />);
  await screen.findByRole("button", { name: "src/a.ts" });
  const header = within(container.querySelector(".git-workspace-header")!);
  const push = header.getByRole("button", { name: `Push ↑${ahead}` });
  const pull = header.getByRole("button", { name: `Pull ↓${behind}` });
  const pushCount = header.getByLabelText(`待推送 ${ahead} 个提交`);
  const pullCount = header.getByLabelText(`待拉取 ${behind} 个提交`);
  for (const [count, elements] of [
    [ahead, [push, pushCount]],
    [behind, [pull, pullCount]],
  ] as const) {
    for (const element of elements) {
      if (count > 0) expect(element).toHaveClass("has-pending");
      else expect(element).not.toHaveClass("has-pending");
    }
  }
  expect(push).toBeEnabled();
  expect(pull).toBeEnabled();
});

it("uses consistent SVG icons for the header, local, current, and remote branches", async () => {
  vi.mocked(api.getBranches).mockResolvedValue(
    ["main", "develop", "origin/topic"].map((name) => ({
      name,
      current: name === "main",
      remote: name.startsWith("origin/"),
      oid: "abcdef12",
      upstream: null,
      committedAt: null,
    })),
  );
  vi.mocked(api.getTags).mockResolvedValue([]);
  vi.mocked(api.getRemotes).mockResolvedValue([]);
  vi.mocked(api.getSubmodules).mockResolvedValue([]);
  const { container } = render(<GitWorkspace project={project} active {...callbacks} />);
  await screen.findByRole("button", { name: "src/a.ts" });
  const headerBranch = container.querySelector(".git-workspace-branch")!;
  expect(headerBranch).toHaveTextContent("main");
  expect(headerBranch.querySelector("svg")).toHaveClass("lucide-git-branch");
  fireEvent.click(screen.getByRole("button", { name: "分支" }));
  const current = await screen.findByLabelText("main (当前分支)");
  const local = screen.getByText("develop");
  const remote = screen.getByText("origin/").closest("strong")!;
  for (const [label, icon] of [
    [current, "lucide-circle-check"],
    [local, "lucide-git-branch"],
    [remote, "lucide-cloud"],
  ] as const) {
    const svg = label.previousElementSibling;
    expect(svg?.tagName).toBe("svg");
    expect(svg).toHaveClass(icon);
    expect(svg).toHaveAttribute("aria-hidden", "true");
  }
  expect(remote).toHaveTextContent("origin/topic");
});

it("keeps the shared resizable separator across all four Git pages", async () => {
  vi.mocked(api.getBranches).mockResolvedValue([]);
  vi.mocked(api.getHistory).mockResolvedValue({ commits: [], nextCursor: null });
  vi.mocked(api.getTags).mockResolvedValue([]);
  vi.mocked(api.getRemotes).mockResolvedValue([]);
  vi.mocked(api.getSubmodules).mockResolvedValue([]);
  vi.mocked(api.getStashes).mockResolvedValue([]);
  render(<GitWorkspace project={project} active {...callbacks} />);
  await screen.findByRole("button", { name: "src/a.ts" });
  const separator = screen.getByRole("separator", { name: "调整 Git 列表与详情宽度" });
  expect(separator).toHaveAttribute("aria-orientation", "vertical");
  for (const name of ["历史", "分支", "Stash", /^更改 /]) {
    const before = Number(separator.getAttribute("aria-valuenow"));
    fireEvent.click(screen.getByRole("button", { name }));
    if (name === "历史") await waitFor(() => expect(api.getHistory).toHaveBeenCalled());
    expect(screen.getByRole("separator", { name: "调整 Git 列表与详情宽度" })).toBe(separator);
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(before);
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  }
  expect(api.getStashes).toHaveBeenCalled();
  localStorage.clear();
});

it("reuses context initialization when opening during hidden preloading", async () => {
  let finish!: (value: GitContext) => void;
  vi.mocked(api.context).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const props = { ...callbacks, sidebarContainer: null };
  const { rerender } = render(<GitWorkspace project={project} active={false} preload {...props} />);
  expect(api.context).toHaveBeenCalledTimes(1);
  expect(api.onRepositoryChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Git 工作区" })).not.toBeInTheDocument();
  rerender(<GitWorkspace project={project} active preload {...props} />);
  expect(api.context).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("正在加载 Git 工作区…");
  expect(screen.queryByText("Git 暂不可用")).not.toBeInTheDocument();
  await act(async () => {
    finish(context());
  });
  await screen.findByRole("button", { name: "src/a.ts" });
  expect(api.refreshRepository).toHaveBeenCalledTimes(1);
});

it("keeps one loading state and reuses the first snapshot request when preloading becomes visible", async () => {
  const next = await api.refreshRepository(1);
  vi.mocked(api.refreshRepository).mockClear();
  let finish!: (value: RepositoryRefresh) => void;
  vi.mocked(api.refreshRepository).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const props = { ...callbacks, sidebarContainer: null };
  const { rerender } = render(<GitWorkspace project={project} active={false} preload {...props} />);
  await waitFor(() => expect(api.refreshRepository).toHaveBeenCalledTimes(1));
  rerender(<GitWorkspace project={project} active preload {...props} />);
  expect(api.context).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("正在加载 Git 工作区…");
  expect(screen.queryByRole("textbox", { name: "提交信息" })).not.toBeInTheDocument();
  expect(api.refreshRepository).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(next);
  });
  await screen.findByRole("button", { name: "src/a.ts" });
});

it("warms the current repository while hidden and refreshes without replacing content on return", async () => {
  const props = { ...callbacks, sidebarContainer: null };
  const { rerender } = render(<GitWorkspace project={project} active={false} preload {...props} />);
  await waitFor(() => expect(api.refreshRepository).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "src/a.ts", hidden: true })).toBeInTheDocument(),
  );
  vi.mocked(api.refreshRepository).mockReturnValue(new Promise(() => {}));
  rerender(<GitWorkspace project={project} active preload {...props} />);
  expect(screen.getByRole("button", { name: "src/a.ts" })).toBeVisible();
  expect(screen.queryByText("正在加载 Git 工作区…")).not.toBeInTheDocument();
  await waitFor(() => expect(api.refreshRepository).toHaveBeenCalledTimes(2));
});

it("does not restart preloading when a ready workspace is hidden", async () => {
  const props = { ...callbacks, sidebarContainer: null };
  const { rerender } = render(<GitWorkspace project={project} active preload {...props} />);
  await screen.findByRole("button", { name: "src/a.ts" });
  const contexts = vi.mocked(api.context).mock.calls.length;
  const refreshes = vi.mocked(api.refreshRepository).mock.calls.length;
  rerender(<GitWorkspace project={project} active={false} preload {...props} />);
  expect(api.context).toHaveBeenCalledTimes(contexts);
  expect(api.refreshRepository).toHaveBeenCalledTimes(refreshes);
});

it("ignores a late preloaded context after the project root changes", async () => {
  let finish!: (value: GitContext) => void;
  vi.mocked(api.context).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const props = { ...callbacks, sidebarContainer: null };
  const { rerender } = render(<GitWorkspace project={project} active={false} preload {...props} />);
  vi.mocked(api.context).mockResolvedValue(context(2));
  rerender(<GitWorkspace project={{ ...project, root: "/new" }} active preload {...props} />);
  await screen.findByRole("button", { name: "src/a.ts" });
  await act(async () => {
    finish(context(99));
  });
  expect(api.refreshRepository).not.toHaveBeenCalledWith(99);
  expect(api.refreshRepository).toHaveBeenCalledWith(2);
});

it("ignores a late preloaded snapshot after switching projects", async () => {
  const first = await api.refreshRepository(1);
  vi.mocked(api.refreshRepository).mockClear();
  let finish!: (value: RepositoryRefresh) => void;
  vi.mocked(api.refreshRepository).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const props = { ...callbacks, sidebarContainer: null };
  const { rerender } = render(<GitWorkspace project={project} active={false} preload {...props} />);
  await waitFor(() => expect(api.refreshRepository).toHaveBeenCalledWith(1));
  vi.mocked(api.context).mockResolvedValue(context(2));
  rerender(
    <GitWorkspace project={{ ...project, id: "p2", name: "Second" }} active preload {...props} />,
  );
  await screen.findByRole("button", { name: "src/a.ts" });
  await act(async () => {
    finish({ ...first, summary: { ...first.summary, branch: "stale" } });
  });
  expect(screen.queryByText("stale")).not.toBeInTheDocument();
  expect(screen.getByText("Second")).toBeInTheDocument();
});

it("shows initialization failures with a working retry instead of remaining in loading", async () => {
  vi.mocked(api.context).mockRejectedValueOnce(new Error("context failed"));
  render(<GitWorkspace project={project} active {...callbacks} sidebarContainer={null} />);
  expect(await screen.findByText("context failed")).toBeInTheDocument();
  expect(screen.queryByText("正在加载 Git 工作区…")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
  await screen.findByRole("button", { name: "src/a.ts" });
});

it("finishes loading with an error if the first snapshot fails", async () => {
  vi.mocked(api.refreshRepository).mockRejectedValueOnce(new Error("snapshot failed"));
  render(<GitWorkspace project={project} active {...callbacks} sidebarContainer={null} />);
  expect(await screen.findByText("snapshot failed")).toBeInTheDocument();
  expect(screen.queryByText("正在加载 Git 工作区…")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByRole("button", { name: "src/a.ts" });
});

it("shows the whole repository for a subdirectory project and opens a changed file in Gaze", async () => {
  render(<GitWorkspace project={project} active {...callbacks} />);
  expect(await screen.findByText(/当前项目位于 src/)).toHaveTextContent("/repo · 整个仓库");
  const sidebar = screen.getByRole("region", { name: "Git 管理列表" });
  expect(within(sidebar).getByRole("button", { name: /Project/ })).toBeInTheDocument();
  expect(within(sidebar).queryByRole("button", { name: "src/a.ts" })).not.toBeInTheDocument();
  expect(
    await within(screen.getByRole("region", { name: "Git 工作区" })).findByRole("button", {
      name: "src/a.ts",
    }),
  ).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "src/a.ts" }));
  expect(await screen.findByRole("button", { name: "在编辑器打开" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "在编辑器打开" }));
  expect(callbacks.onOpenFile).toHaveBeenCalledWith("/repo", "src/a.ts");
});

it("does not let a late context restore the previous project", async () => {
  let finish!: (value: GitContext) => void;
  const pending = new Promise<GitContext>((resolve) => {
    finish = resolve;
  });
  vi.mocked(api.context).mockImplementation((id) =>
    id === "p1" ? pending : Promise.resolve(context(2)),
  );
  const { rerender } = render(<GitWorkspace project={project} active {...callbacks} />);
  rerender(
    <GitWorkspace
      project={{ ...project, id: "p2", name: "Second" }}
      active
      {...callbacks}
      projects={[{ ...project, id: "p2", name: "Second" }]}
    />,
  );
  await waitFor(() => expect(api.refreshRepository).toHaveBeenCalledWith(2));
  await act(async () => {
    finish(context(1));
  });
  expect(api.refreshRepository).not.toHaveBeenCalledWith(1);
  expect(
    within(screen.getByRole("region", { name: "Git 工作区" })).getByText("Second"),
  ).toBeInTheDocument();
});

it("switches projects from the Git sidebar without showing a file tree", async () => {
  const second = { ...project, id: "p2", name: "Second", root: "/second" };
  render(<GitWorkspace project={project} active {...callbacks} projects={[project, second]} />);
  const row = within(sidebarContainer).getByRole("button", { name: /Second/ });
  fireEvent.click(row);
  expect(callbacks.onSelectProject).toHaveBeenCalledWith(second);
  expect(within(sidebarContainer).queryByRole("tree")).not.toBeInTheDocument();
});

it("retains the open diff and commit draft while hidden and refreshes them on return", async () => {
  const { rerender } = render(<GitWorkspace project={project} active {...callbacks} />);
  fireEvent.click(await screen.findByRole("button", { name: "src/a.ts" }));
  await screen.findByRole("button", { name: "在编辑器打开" });
  const draft = screen.getByRole("textbox", { name: "提交信息" });
  fireEvent.change(draft, { target: { value: "保留这份提交草稿" } });
  rerender(<GitWorkspace project={project} active={false} {...callbacks} />);
  expect(screen.queryByRole("region", { name: "Git 工作区" })).not.toBeInTheDocument();
  const count = vi.mocked(api.refreshRepository).mock.calls.length;
  rerender(<GitWorkspace project={project} active {...callbacks} />);
  expect(screen.getByRole("button", { name: "在编辑器打开" })).toBeVisible();
  await waitFor(() =>
    expect(vi.mocked(api.refreshRepository).mock.calls.length).toBeGreaterThan(count),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "提交信息" })).toHaveValue("保留这份提交草稿"),
  );
  expect(screen.getByRole("textbox", { name: "提交信息" })).toBe(draft);
});
