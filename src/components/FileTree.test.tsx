import { createRef, type Ref } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry, Project } from "../lib/types";
import type { FileChange } from "../git/models";

const apiMock = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  hasFileClipboard: vi.fn(),
  copyEntry: vi.fn(),
  copyEntryPath: vi.fn(),
  revealEntry: vi.fn(),
}));
const gitApiMock = vi.hoisted(() => ({
  context: vi.fn(),
  getStatus: vi.fn(),
  onRepositoryChange: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: apiMock, gitApi: gitApiMock }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 27,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 27 })),
  }),
}));

import { FileTree, type FileTreeHandle } from "./FileTree";

const project = { id: "p1", name: "Demo", root: "/demo" };
const entry = (path: string, isDir = false, isSymlink = false): DirEntry => ({
  path,
  name: path.split("/").pop()!,
  isDir,
  isSymlink,
  size: 0,
  modifiedMs: null,
});
let listings: Record<string, DirEntry[]>;
afterEach(() => vi.restoreAllMocks());

function setup(
  ref?: Ref<FileTreeHandle>,
  restored?: {
    openProjects: string[];
    expandedDirectories: string[];
    onExpansionChange: (
      openProjects: ReadonlySet<string>,
      expandedDirectories: ReadonlySet<string>,
    ) => void;
  },
  projects: Project[] = [project],
) {
  const onFileOperation = vi.fn().mockResolvedValue(undefined);
  const onPaste = vi.fn().mockResolvedValue({ entries: [], failures: [] });
  const onOpenFile = vi.fn();
  const onNotice = vi.fn();
  render(
    <FileTree
      ref={ref}
      projects={projects}
      activeProjectId="p1"
      activeFilePath={null}
      active
      refresh={{ token: 0, directories: new Map() }}
      initialOpenProjects={restored?.openProjects}
      initialExpandedDirectories={restored?.expandedDirectories}
      onExpansionChange={restored?.onExpansionChange}
      onOpenProject={vi.fn()}
      onOpenFile={onOpenFile}
      onRemoveProject={vi.fn()}
      onImport={vi.fn()}
      onNotice={onNotice}
      onFileOperation={onFileOperation}
      onPaste={onPaste}
    />,
  );
  return { user: userEvent.setup(), onFileOperation, onOpenFile, onPaste, onNotice };
}

describe("FileTree operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.hasFileClipboard.mockResolvedValue(true);
    apiMock.copyEntry.mockResolvedValue(undefined);
    apiMock.copyEntryPath.mockResolvedValue(undefined);
    apiMock.revealEntry.mockResolvedValue(undefined);
    gitApiMock.context.mockResolvedValue({ repository: null, projectPrefix: "" });
    gitApiMock.onRepositoryChange.mockResolvedValue(() => {});
    listings = {
      "": [
        entry("src", true),
        entry("target", true),
        entry("link", true, true),
        entry("readme.md"),
      ],
      src: [],
      target: [],
    };
    apiMock.listDirectory.mockImplementation(async (_id: string, path: string) => ({
      projectId: "p1",
      path,
      entries: [...(listings[path] ?? [])],
    }));
  });

  it("selects with Cmd/Ctrl and Shift without opening files, and confirms bulk trash", async () => {
    const { user, onOpenFile, onFileOperation } = setup();
    await screen.findByRole("button", { name: "readme.md" });
    fireEvent.click(screen.getByRole("button", { name: "src" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "readme.md" }), { shiftKey: true });
    expect(screen.getByRole("tree")).toHaveAttribute("aria-multiselectable", "true");
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(4);
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "target" }), { metaKey: true });
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(3);
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Delete" });
    const dialog = screen.getByRole("dialog", { name: "移到废纸篓" });
    expect(within(dialog).getByRole("list", { name: "操作项目" })).toHaveTextContent("readme.md");
    expect(onFileOperation).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "移到废纸篓" }));
    expect(onFileOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "trash",
        entries: [entry("src", true), entry("link", true, true), entry("readme.md")],
      }),
      "",
    );
  });

  it.each(["editor", "tree", "heading"])(
    "clears multi-selection and its range anchor when clicking the %s",
    async (area) => {
      const { user } = setup();
      render(<button onPointerDown={(event) => event.stopPropagation()}>编辑区域</button>);
      await screen.findByRole("button", { name: "readme.md" });
      fireEvent.click(screen.getByRole("button", { name: "src" }), { ctrlKey: true });
      fireEvent.click(screen.getByRole("button", { name: "readme.md" }), { shiftKey: true });
      expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(4);

      const target =
        area === "editor"
          ? screen.getByRole("button", { name: "编辑区域" })
          : area === "tree"
            ? screen.getByRole("tree")
            : screen.getByText("项目 · 已选 4 项");
      await user.click(target);
      expect(screen.queryAllByRole("treeitem", { selected: true })).toHaveLength(0);
      expect(screen.queryByText(/已选 \d+ 项/)).not.toBeInTheDocument();
      expect(screen.getByRole("tree")).not.toHaveAttribute("aria-activedescendant");

      fireEvent.click(screen.getByRole("button", { name: "readme.md" }), { shiftKey: true });
      expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(1);
    },
  );

  it("moves a multi-selection and disables selected directories in the picker", async () => {
    const { user, onFileOperation } = setup();
    await screen.findByRole("button", { name: "readme.md" });
    fireEvent.click(screen.getByRole("button", { name: "src" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "readme.md" }), { ctrlKey: true });
    await user.click(screen.getByRole("button", { name: "src 的更多操作" }));
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(2);
    await user.click(screen.getByRole("menuitem", { name: "移动所选 2 项到…" }));
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(2);
    const dialog = screen.getByRole("dialog", { name: "移动到文件夹" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "src" })).toBeDisabled());
    await user.click(within(dialog).getByRole("button", { name: "target" }));
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "移动到此文件夹" }));
    expect(onFileOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "move", entries: [entry("src", true), entry("readme.md")] }),
      "target",
    );
  });

  it("refreshes completed items and retries only failures after partial success", async () => {
    const { user, onFileOperation } = setup();
    await screen.findByRole("button", { name: "readme.md" });
    fireEvent.click(screen.getByRole("button", { name: "src" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "readme.md" }), { ctrlKey: true });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "readme.md" }).closest('[role="treeitem"]')!,
    );
    await user.click(screen.getByRole("menuitem", { name: "将所选 2 项移到废纸篓" }));
    onFileOperation.mockImplementationOnce(async () => {
      listings[""] = listings[""]!.filter((item) => item.path !== "readme.md");
      return {
        results: [{ source: entry("src", true), error: "denied" }, { source: entry("readme.md") }],
      };
    });
    await user.click(screen.getByRole("button", { name: "移到废纸篓" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("已完成 1 项，失败 1 项");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "readme.md" })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "移到废纸篓" }));
    expect(onFileOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({ entry: entry("src", true), entries: [entry("src", true)] }),
      "",
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps modified selections within one project", async () => {
    setup(undefined, undefined, [project, { id: "p2", name: "Other", root: "/other" }]);
    await screen.findByRole("button", { name: "readme.md" });
    fireEvent.click(screen.getByRole("button", { name: "src" }), { ctrlKey: true });
    await userEvent.click(screen.getByRole("button", { name: "展开 Other" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "readme.md" })).toHaveLength(2),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "src" })[0]!, { ctrlKey: true });
    fireEvent.click(screen.getAllByRole("button", { name: "readme.md" })[1]!, { ctrlKey: true });
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("tree"), { key: "a", metaKey: true });
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(4);
    expect(
      screen
        .getAllByRole("treeitem", { selected: true })
        .every((row) => row.getAttribute("data-drop-project") === "p2"),
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Backspace", metaKey: true });
    expect(screen.getByRole("dialog")).toHaveTextContent("所选 4 项");
  });

  it("supports keyboard range selection and selects all visible entries", async () => {
    setup();
    await screen.findByRole("button", { name: "readme.md" });
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(2);
    fireEvent.keyDown(tree, { key: "a", ctrlKey: true });
    expect(screen.getAllByRole("treeitem", { selected: true })).toHaveLength(4);
  });

  it("restores expanded directories and publishes later expansion changes", async () => {
    listings.src = [entry("src/a.ts")];
    const onExpansionChange = vi.fn();
    const { user } = setup(undefined, {
      openProjects: ["p1"],
      expandedDirectories: ["p1\u0000src"],
      onExpansionChange,
    });
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(apiMock.listDirectory).toHaveBeenCalledWith("p1", "src");
    await user.click(screen.getByRole("button", { name: "src" }));
    await waitFor(() =>
      expect(onExpansionChange).toHaveBeenLastCalledWith(new Set(["p1"]), new Set()),
    );
  });

  it("offers root creation without root rename/delete, supports keyboard cancellation and focus restoration", async () => {
    const { user, onFileOperation } = setup();
    const trigger = screen.getByRole("button", { name: "Demo 的更多操作" });
    await user.click(trigger);
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "重命名" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "移到废纸篓" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "从工作区移除" })).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("dialog", { name: "新建文件夹" })).toBeInTheDocument();
    await user.keyboard("temporary{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onFileOperation).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("pastes into the root, folder or file parent, then refreshes without opening a file", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    const { user, onPaste, onNotice } = setup();
    await screen.findByText("readme.md");
    for (const [name, parent, copiedName] of [
      ["Demo", "", "root-copied.txt"],
      ["src", "src", "nested-copied.txt"],
      ["readme.md", "", "parent-copied.txt"],
    ]) {
      await user.click(screen.getByRole("button", { name: `${name} 的更多操作` }));
      const paste = screen.getByRole("menuitem", { name: "粘贴" });
      await waitFor(() => expect(paste).toBeEnabled());
      onPaste.mockImplementationOnce(async () => {
        listings[parent!]!.push(entry(`${parent ? parent + "/" : ""}${copiedName}`));
        return {
          entries: [entry(copiedName!)],
          failures: [{ name: "missing", message: "不存在" }],
        };
      });
      await user.click(paste);
      expect(onPaste).toHaveBeenLastCalledWith(project, parent);
      await waitFor(() =>
        expect(apiMock.listDirectory).toHaveBeenLastCalledWith(project.id, expect.any(String)),
      );
      expect(onNotice).toHaveBeenLastCalledWith("已粘贴 1 项\nmissing：不存在");
    }
    expect(await screen.findByText("root-copied.txt")).toBeInTheDocument();
    expect(await screen.findByText("nested-copied.txt")).toBeInTheDocument();
    expect(await screen.findByText("parent-copied.txt")).toBeInTheDocument();
  });

  it("publishes drop destinations and refreshes the destination after a dropped copy", async () => {
    const ref = createRef<FileTreeHandle>();
    const { onPaste, onNotice } = setup(ref);
    await screen.findByText("readme.md");
    expect(
      screen.getByRole("button", { name: "Demo" }).closest("[data-drop-project]"),
    ).toHaveAttribute("data-drop-parent", "");
    expect(
      screen.getByRole("button", { name: "src" }).closest("[data-drop-project]"),
    ).toHaveAttribute("data-drop-parent", "src");
    expect(
      screen.getByRole("button", { name: "readme.md" }).closest("[data-drop-project]"),
    ).toHaveAttribute("data-drop-parent", "");
    onPaste.mockImplementationOnce(async () => {
      listings.src!.push(entry("src/copied.txt"));
      return { entries: [entry("src/copied.txt")], failures: [] };
    });
    await act(async () => {
      await ref.current?.drop(project, "src", ["/outside/copied.txt"]);
    });
    expect(onPaste).toHaveBeenCalledWith(project, "src", ["/outside/copied.txt"]);
    expect(await screen.findByText("copied.txt")).toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith("已复制 1 项");
  });

  it("exposes file operations through its handle so shortcuts match the row menu", async () => {
    const ref = createRef<FileTreeHandle>();
    const { user, onFileOperation, onPaste, onNotice } = setup(ref);
    await screen.findByText("readme.md");
    onPaste.mockImplementationOnce(async () => {
      listings.src!.push(entry("src/copied.txt"));
      return { entries: [entry("copied.txt")], failures: [] };
    });
    act(() => ref.current?.paste(project, "src"));
    await waitFor(() => expect(onPaste).toHaveBeenCalledWith(project, "src"));
    await waitFor(() => expect(apiMock.listDirectory).toHaveBeenLastCalledWith("p1", "src"));
    expect(onNotice).toHaveBeenLastCalledWith("已粘贴 1 项");
    expect(await screen.findByText("copied.txt")).toBeInTheDocument();

    act(() => ref.current?.rename(project, "readme.md"));
    const renameDialog = await screen.findByRole("dialog", { name: "重命名" });
    expect(renameDialog.closest(".file-tree-pane")).toBeNull();
    expect(within(renameDialog).getByLabelText("名称")).toHaveValue("readme.md");
    await user.click(within(renameDialog).getByRole("button", { name: "取消" }));

    act(() => ref.current?.create(project, "src", true));
    const createDialog = await screen.findByRole("dialog", { name: "新建文件夹" });
    await user.click(within(createDialog).getByRole("button", { name: "取消" }));

    act(() => ref.current?.trash(project, "readme.md"));
    await screen.findByRole("dialog", { name: "移到废纸篓" });
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(onFileOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "trash",
          entry: expect.objectContaining({ path: "readme.md" }),
        }),
        "",
      ),
    );
  });

  it("moves the selection with arrow keys and opens the selected file with Enter", async () => {
    const { user, onOpenFile } = setup();
    await screen.findByText("readme.md");
    const row = (name: string) => screen.getByText(name).closest(".tree-row");

    await user.click(screen.getByText("readme.md"));
    expect(onOpenFile).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ path: "readme.md" }),
    );
    expect(row("readme.md")).toHaveClass("is-selected");

    await user.keyboard("{ArrowUp}");
    expect(row("readme.md")).not.toHaveClass("is-selected");
    expect(row("link")).toHaveClass("is-selected");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(row("readme.md")).toHaveClass("is-selected");
    expect(onOpenFile).toHaveBeenLastCalledWith(
      project,
      expect.objectContaining({ path: "readme.md" }),
    );
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it("expands, enters children, collapses and returns to parents with horizontal arrows", async () => {
    listings.src = [entry("src/a.ts"), entry("src/nested", true)];
    const { user } = setup();
    await screen.findByText("readme.md");
    const tree = screen.getByRole("tree");
    const row = (name: string) => screen.getByText(name).closest(".tree-row")!;
    expect(tree).toHaveAttribute("tabindex", "0");

    fireEvent.click(row("src"));
    tree.focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(tree).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(row("a.ts")).toHaveClass("is-selected");
    expect(tree).toHaveAttribute("aria-activedescendant", row("a.ts")!.id);
    await user.keyboard("{ArrowLeft}");
    expect(row("src")).toHaveClass("is-selected");
    expect(row("a.ts")).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");
    expect(row("src")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(row("Demo")).toHaveClass("is-selected");

    await user.keyboard("{ArrowLeft}");
    expect(row("Demo")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("src")).not.toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("src")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(row("src")).toHaveClass("is-selected");

    fireEvent.click(row("link"));
    tree.focus();
    await user.keyboard("{ArrowRight}");
    expect(apiMock.listDirectory).not.toHaveBeenCalledWith("p1", "link");
    expect(row("link")).not.toHaveAttribute("aria-expanded");
  });

  it("exposes each visible tree item's level and real sibling position", async () => {
    listings.src = [entry("src/a.ts"), entry("src/nested", true)];
    listings["src/nested"] = [entry("src/nested/deep.ts")];
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "src" }));
    await screen.findByText("a.ts");
    await user.click(screen.getByRole("button", { name: "nested" }));
    await screen.findByText("deep.ts");

    const expectPosition = (name: string, level: number, setSize: number, position: number) => {
      const item = screen.getByText(name).closest('[role="treeitem"]');
      expect(item).toHaveAttribute("aria-level", String(level));
      expect(item).toHaveAttribute("aria-setsize", String(setSize));
      expect(item).toHaveAttribute("aria-posinset", String(position));
    };
    expectPosition("Demo", 1, 1, 1);
    expectPosition("src", 2, 4, 1);
    expectPosition("target", 2, 4, 2);
    expectPosition("link", 2, 4, 3);
    expectPosition("readme.md", 2, 4, 4);
    expectPosition("a.ts", 3, 2, 1);
    expectPosition("nested", 3, 2, 2);
    expectPosition("deep.ts", 4, 1, 1);
  });

  it("copies files and both path forms, reveals the selected item, and disables unsafe paste targets", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    const { user } = setup();
    await screen.findByText("readme.md");
    for (const [label, method] of [
      ["复制", apiMock.copyEntry],
      ["复制绝对路径", apiMock.copyEntryPath],
      ["复制相对路径", apiMock.copyEntryPath],
      ["在访达中打开", apiMock.revealEntry],
    ] as const) {
      await user.click(screen.getByRole("button", { name: "readme.md 的更多操作" }));
      await user.click(screen.getByRole("menuitem", { name: label }));
      if (method === apiMock.copyEntryPath) {
        expect(method).toHaveBeenLastCalledWith(project.id, "readme.md", label === "复制相对路径");
      } else {
        expect(method).toHaveBeenLastCalledWith(project.id, "readme.md");
      }
    }
    await user.click(screen.getByRole("button", { name: "link 的更多操作" }));
    expect(screen.getByRole("menuitem", { name: "粘贴" })).toBeDisabled();
    await user.keyboard("{Escape}");
    apiMock.hasFileClipboard.mockResolvedValue(false);
    await user.click(screen.getByRole("button", { name: "Demo 的更多操作" }));
    expect(screen.getByRole("menuitem", { name: "粘贴" })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "复制绝对路径" }));
    expect(apiMock.copyEntryPath).toHaveBeenLastCalledWith(project.id, "", false);
    await user.click(screen.getByRole("button", { name: "Demo 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
    expect(apiMock.copyEntryPath).toHaveBeenLastCalledWith(project.id, "", true);
  });

  it("blocks repeat paste while a request is running and reports errors", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    const { user, onPaste, onNotice } = setup();
    let reject!: (error: Error) => void;
    onPaste.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const trigger = screen.getByRole("button", { name: "Demo 的更多操作" });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "粘贴" })).toBeEnabled());
    await user.click(screen.getByRole("menuitem", { name: "粘贴" }));
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "粘贴" })).toBeDisabled();
    expect(onPaste).toHaveBeenCalledOnce();
    await act(async () => reject(new Error("无法读取剪贴板")));
    expect(onNotice).toHaveBeenCalledWith("无法读取剪贴板");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "粘贴" })).toBeEnabled());
  });

  it("colors Git changes independently of selection and exposes status descriptions without badges", async () => {
    let onChange!: (repositoryId: number) => void;
    gitApiMock.onRepositoryChange.mockImplementation(async (callback) => {
      onChange = callback;
      return () => {};
    });
    gitApiMock.context.mockResolvedValue({
      repository: { id: 1, kind: "workTree" },
      projectPrefix: "",
    });
    const change = (path: string, overrides: Partial<FileChange> = {}): FileChange => ({
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
    gitApiMock.getStatus.mockResolvedValue({
      files: [
        change("readme.md", { staged: true, unstaged: false }),
        change("src/new.ts", { kind: "untracked" }),
        change("src/edit.ts", { staged: true }),
        change("src/conflict.ts", { conflict: true, kind: "conflicted" }),
        change("src/renamed.ts", { kind: "renamed", originalPath: "src/old.ts" }),
        change("src/deleted.ts", { kind: "deleted" }),
      ],
    });
    listings.src = [
      entry("src/new.ts"),
      entry("src/edit.ts"),
      entry("src/conflict.ts"),
      entry("src/renamed.ts"),
    ];
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "src" }));
    await waitFor(() =>
      expect(screen.getByText("readme.md").closest('[role="treeitem"]')).toHaveClass(
        "git-modified",
      ),
    );
    expect(screen.getByText("new.ts").closest('[role="treeitem"]')).toHaveClass("git-added");
    expect(screen.getByText("edit.ts").closest('[role="treeitem"]')).toHaveClass("git-modified");
    expect(screen.getByText("conflict.ts").closest('[role="treeitem"]')).toHaveClass(
      "git-conflict",
    );
    expect(screen.getByRole("button", { name: "src" }).closest('[role="treeitem"]')).toHaveClass(
      "git-conflict",
    );
    expect(screen.queryByText("deleted.ts")).not.toBeInTheDocument();
    for (const [name, description] of [
      ["readme.md", "已修改（已暂存）"],
      ["new.ts", "未跟踪（未暂存）"],
      ["edit.ts", "已修改（部分暂存）"],
      ["conflict.ts", "Git 冲突（未暂存）"],
      ["renamed.ts", "已重命名（未暂存）"],
    ]) {
      expect(screen.getByText(name!).closest('[role="treeitem"]')).toHaveAttribute(
        "aria-description",
        description,
      );
    }
    expect(screen.queryByRole("img", { name: /Git：/ })).not.toBeInTheDocument();
    expect(screen.getByText("edit.ts").closest('[role="treeitem"]')).toHaveAttribute(
      "aria-selected",
      "false",
    );
    gitApiMock.getStatus.mockResolvedValue({ files: [] });
    act(() => onChange(1));
    await waitFor(() =>
      expect(document.querySelectorAll('[role="treeitem"][class*="git-"]')).toHaveLength(0),
    );
    expect(screen.queryByRole("img", { name: /Git：/ })).not.toBeInTheDocument();
  });

  it("creates inside a collapsed folder, expands its parent and refreshes the listing", async () => {
    const { user, onFileOperation } = setup();
    const trigger = await screen.findByRole("button", { name: "src 的更多操作" });
    fireEvent.contextMenu(trigger.closest('[role="treeitem"]')!);
    await user.click(screen.getByRole("menuitem", { name: "新建文件" }));
    const created = entry("src/new.ts");
    onFileOperation.mockImplementation(async () => {
      listings.src = [created];
      return created;
    });
    await user.type(screen.getByRole("textbox", { name: "名称" }), "new.ts");
    await user.click(screen.getByRole("button", { name: "新建文件" }));
    await waitFor(() =>
      expect(onFileOperation).toHaveBeenCalledWith(
        { kind: "createFile", project, parentPath: "src" },
        "new.ts",
      ),
    );
    expect(await screen.findByText("new.ts")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps rename errors in the dialog without changing the tree", async () => {
    const { user, onFileOperation } = setup();
    await user.click(await screen.findByRole("button", { name: "readme.md 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    onFileOperation.mockRejectedValue(new Error("目标名称已存在"));
    const input = screen.getByRole("textbox", { name: "名称" });
    expect(input).toHaveValue("readme.md");
    await user.clear(input);
    await user.type(input, "taken.md");
    await user.click(screen.getByRole("button", { name: "重命名" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("目标名称已存在");
    expect(screen.getByRole("button", { name: "readme.md 的更多操作" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("selects a lazy-loaded destination, excludes links and rejects the source subtree", async () => {
    const { user, onFileOperation } = setup();
    await user.click(await screen.findByRole("button", { name: "src 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "移动到…" }));
    const dialog = screen.getByRole("dialog", { name: "移动到文件夹" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(await within(dialog).findByRole("button", { name: "src" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "link" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "target" }));
    expect(await within(dialog).findByText("没有子文件夹")).toBeInTheDocument();
    onFileOperation.mockResolvedValue(entry("target/src", true));
    await user.click(within(dialog).getByRole("button", { name: "移动到此文件夹" }));
    await waitFor(() =>
      expect(onFileOperation).toHaveBeenCalledWith(
        { kind: "move", project, entry: entry("src", true) },
        "target",
      ),
    );
    expect(apiMock.listDirectory).toHaveBeenCalledWith("p1", "target");
  });

  it("requires trash confirmation and displays failures without removing the entry", async () => {
    const { user, onFileOperation } = setup();
    await user.click(await screen.findByRole("button", { name: "src 的更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "移到废纸篓" }));
    const dialog = screen.getByRole("dialog", { name: "移到废纸篓" });
    expect(dialog).toHaveTextContent("及其全部内容");
    expect(onFileOperation).not.toHaveBeenCalled();
    onFileOperation.mockRejectedValue(new Error("废纸篓不可用"));
    await user.click(within(dialog).getByRole("button", { name: "移到废纸篓" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("废纸篓不可用");
    expect(screen.getByRole("button", { name: "src 的更多操作" })).toBeInTheDocument();
  });
});

describe("FileTree refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitApiMock.context.mockResolvedValue({ repository: null, projectPrefix: "" });
    gitApiMock.onRepositoryChange.mockResolvedValue(() => {});
    apiMock.listDirectory.mockImplementation(async (_id: string, path: string) => ({
      projectId: "p1",
      path,
      entries: path ? [] : [entry("src", true), entry("target", true)],
    }));
  });
  const props = () => ({
    projects: [project],
    activeProjectId: "p1",
    activeFilePath: null,
    onOpenProject: vi.fn(),
    onOpenFile: vi.fn(),
    onRemoveProject: vi.fn(),
    onImport: vi.fn(),
    onNotice: vi.fn(),
    onFileOperation: vi.fn().mockResolvedValue(undefined),
    onPaste: vi.fn().mockResolvedValue({ entries: [], failures: [] }),
  });
  const idle = { token: 0, directories: new Map<string, string[]>() };

  it("shows Git colors on collapsed projects and keeps both projects decorated when selection changes", async () => {
    const second = { id: "p2", name: "Other", root: "/other" };
    gitApiMock.context.mockImplementation(async (id: string) => ({
      repository: { id: id === "p1" ? 1 : 2, kind: "workTree" },
      projectPrefix: "",
    }));
    gitApiMock.getStatus.mockImplementation(async (id: number) => ({
      files: [{ path: id === 1 ? "first.ts" : "second.ts", kind: id === 1 ? "modified" : "added" }],
    }));
    apiMock.listDirectory.mockImplementation(async (id: string, path: string) => ({
      projectId: id,
      path,
      entries: [entry(id === "p1" ? "first.ts" : "second.ts")],
    }));
    const base = { ...props(), projects: [project, second] };
    const { rerender } = render(<FileTree {...base} active refresh={idle} />);
    await waitFor(() =>
      expect(screen.getByText("Other").closest(".tree-row")).toHaveClass("git-modified"),
    );
    expect(screen.queryByText("second.ts")).not.toBeInTheDocument();
    expect(screen.getByText("first.ts").closest(".tree-row")).toHaveClass("git-modified");
    rerender(<FileTree {...base} activeProjectId="p2" active refresh={idle} />);
    await screen.findByText("second.ts");
    expect(screen.getByText("second.ts").closest(".tree-row")).toHaveClass("git-added");
    expect(screen.getByText("first.ts").closest(".tree-row")).toHaveClass("git-modified");
    expect(screen.getByText("Demo").closest(".tree-row")).toHaveClass("git-modified");
    await userEvent.setup().click(screen.getByRole("button", { name: "折叠 Demo" }));
    expect(screen.getByText("Demo").closest(".tree-row")).toHaveClass("git-modified");
    expect(gitApiMock.getStatus).toHaveBeenCalledTimes(2);
  });

  it("reloads cached nested listings on a whole-project refresh", async () => {
    const folders: Record<string, DirEntry[]> = {
      "": [entry("src", true)],
      src: [entry("src/old.ts")],
    };
    gitApiMock.context.mockResolvedValue({ repository: null, projectPrefix: "" });
    gitApiMock.onRepositoryChange.mockResolvedValue(() => {});
    apiMock.listDirectory.mockImplementation(async (_id: string, path: string) => ({
      projectId: "p1",
      path,
      entries: [...(folders[path] ?? [])],
    }));
    const base = props();
    const { rerender } = render(<FileTree {...base} active refresh={idle} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "src" }));
    await screen.findByText("old.ts");
    await user.click(screen.getByRole("button", { name: "src" }));
    folders.src = [entry("src/new.ts")];
    apiMock.listDirectory.mockClear();
    rerender(
      <FileTree {...base} active refresh={{ token: 1, directories: new Map([["p1", null]]) }} />,
    );
    await waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalledWith("p1", "src"));
    await user.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByText("new.ts")).toBeInTheDocument();
    expect(screen.queryByText("old.ts")).not.toBeInTheDocument();
  });

  it("reloads only the directories the watcher reported", async () => {
    const base = props();
    const { rerender } = render(<FileTree {...base} active refresh={idle} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "src" }));
    await user.click(screen.getByRole("button", { name: "target" }));
    await waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalledWith("p1", "target"));
    apiMock.listDirectory.mockClear();
    rerender(
      <FileTree {...base} active refresh={{ token: 1, directories: new Map([["p1", ["src"]]]) }} />,
    );
    await waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalledWith("p1", "src"));
    expect(apiMock.listDirectory).toHaveBeenCalledWith("p1", "");
    expect(apiMock.listDirectory).not.toHaveBeenCalledWith("p1", "target");
  });

  it("does not poll Git while the tree is hidden", async () => {
    gitApiMock.context.mockResolvedValue({
      repository: { id: 1, kind: "workTree" },
      projectPrefix: "",
    });
    gitApiMock.getStatus.mockResolvedValue({ files: [] });
    const base = props();
    const { rerender } = render(<FileTree {...base} active={false} refresh={idle} />);
    await waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalled());
    expect(gitApiMock.getStatus).not.toHaveBeenCalled();
    rerender(<FileTree {...base} active refresh={idle} />);
    await waitFor(() => expect(gitApiMock.getStatus).toHaveBeenCalledWith(1, false));
  });
});
