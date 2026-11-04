import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileOperation, FileOperationResult } from "./components/FileOperationDialog";
import type { DirEntry, EditorStatus, Project } from "./lib/types";
import type { NativeMenuAction, NativeMenuState } from "./lib/nativeMenu";

const nativeMenu = vi.hoisted(() => ({
  state: null as NativeMenuState | null,
  action: null as ((action: NativeMenuAction) => Promise<void>) | null,
  error: null as ((error: unknown) => void) | null,
}));
vi.mock("./lib/nativeMenu", () => ({
  useNativeMenu: (
    state: NativeMenuState,
    action: typeof nativeMenu.action,
    error: typeof nativeMenu.error,
  ) => {
    nativeMenu.state = state;
    nativeMenu.action = action;
    nativeMenu.error = error;
  },
}));

const windowMock = vi.hoisted(() => ({ close: vi.fn(), onCloseRequested: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowMock }));
const fileSearchSpy = vi.hoisted(() => vi.fn());

const editorStatusHandler = vi.hoisted(() => ({
  current: null as null | ((status: EditorStatus | null) => void),
}));

const fileOperationHandler = vi.hoisted(() => ({
  current: null as
    null | ((operation: FileOperation, value: string) => Promise<FileOperationResult>),
}));
const finishSpy = vi.hoisted(() => vi.fn());
const trashSpy = vi.hoisted(() => vi.fn());
const renameSpy = vi.hoisted(() => vi.fn());
const createSpy = vi.hoisted(() => vi.fn());

const apiMock = vi.hoisted(() => ({
  bootstrapWorkspace: vi.fn(),
  importProjects: vi.fn(),
  removeProject: vi.fn(),
  setActiveProject: vi.fn(),
  setTheme: vi.fn(),
  saveSettings: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createEntry: vi.fn(),
  moveEntry: vi.fn(),
  trashEntry: vi.fn(),
  copyEntry: vi.fn(),
  pasteEntries: vi.fn(),
  syncDocument: vi.fn(),
  getCapabilities: vi.fn(),
  searchPaths: vi.fn(),
  pathIndexStatus: vi.fn(),
  startSearch: vi.fn(),
  continueSearch: vi.fn(),
  cancelSearch: vi.fn(),
  previewReplace: vi.fn(),
  cancelReplacePreview: vi.fn(),
  applyReplace: vi.fn(),
  getOutline: vi.fn(),
  searchSymbols: vi.fn(),
  findDefinitions: vi.fn(),
  findReferences: vi.fn(),
  findImplementations: vi.fn(),
  onSearchEvent: vi.fn(),
  onFsChange: vi.fn(),
  onPathIndexStatus: vi.fn(),
  onLspStatus: vi.fn(),
  onFileDrop: vi.fn().mockResolvedValue(() => {}),
  onOpenFiles: vi.fn().mockResolvedValue(() => {}),
  takePendingFiles: vi.fn().mockResolvedValue([]),
  openExternalFiles: vi.fn(),
  closeExternalFile: vi.fn().mockResolvedValue(undefined),
  copyDroppedFiles: vi.fn(),
}));

const saveSpy = vi.hoisted(() => vi.fn().mockResolvedValue({ status: "clean" }));
const discardRecoverySpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const gitApiMock = vi.hoisted(() => ({
  context: vi.fn().mockResolvedValue({ repository: null }),
  getFileBase: vi.fn(),
  onRepositoryChange: vi.fn(),
}));

vi.mock("./lib/api", () => ({ api: apiMock, gitApi: gitApiMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./components/TerminalPanel", () => ({
  TerminalPanel: ({ open }: { open: boolean }) => <section aria-label="终端面板" hidden={!open} />,
}));
vi.mock("./git/GitWorkspace", async () => {
  const { useState } = await import("react");
  return {
    default: function FakeGitWorkspace({
      active,
      preload,
      project,
      projects,
      onSelectProject,
    }: {
      active: boolean;
      preload?: boolean;
      project: Project | null;
      projects: Project[];
      onSelectProject: (project: Project) => void;
    }) {
      const [position, setPosition] = useState("");
      return (
        <section
          aria-label="Git 工作区"
          hidden={!active}
          data-preload={preload}
          data-root={project?.root}
        >
          <strong>{project?.name}</strong>
          <input
            aria-label="Git 浏览位置"
            value={position}
            onChange={(event) => setPosition(event.target.value)}
          />
          {projects.map((item) => (
            <button key={item.id} onClick={() => onSelectProject(item)}>
              Git 项目 {item.name}
            </button>
          ))}
        </section>
      );
    },
  };
});
vi.mock("./components/FileTree", async () => {
  const React = await import("react");
  const FileTree = (props: {
    ref?: React.Ref<{
      paste: (project: { id: string; name: string; root: string }, parent: string) => void;
      trash: (project: { id: string; name: string; root: string }, path: string) => void;
      rename: (project: { id: string; name: string; root: string }, path: string) => void;
      create: (
        project: { id: string; name: string; root: string },
        parent: string,
        isDir: boolean,
      ) => void;
    }>;
    onFileOperation: (operation: FileOperation, value: string) => Promise<FileOperationResult>;
    projects: { id: string; name: string; root: string }[];
    onOpenFile: (project: { id: string; name: string; root: string }, entry: object) => void;
    onPaste: (
      project: { id: string; name: string; root: string },
      parent: string,
      paths?: string[],
    ) => Promise<object>;
  }) => {
    React.useImperativeHandle(props.ref, () => ({
      paste: (project, parent) => void props.onPaste(project, parent),
      drop: async (project: Project, parent: string, paths: string[]) => {
        await props.onPaste(project, parent, paths);
      },
      trash: (project, path) => trashSpy(project.id, path),
      rename: (project, path) => renameSpy(project.id, path),
      create: (project, parent, isDir) => createSpy(project.id, parent, isDir),
    }));
    fileOperationHandler.current = props.onFileOperation;
    const project = props.projects[0];
    const open = (name: string) =>
      project &&
      props.onOpenFile(project, {
        name: name.split("/").pop()!,
        path: name,
        isDir: false,
        isSymlink: false,
        size: 10,
        modifiedMs: null,
      });
    return (
      <div className="file-tree-pane">
        <button onClick={() => open("README.md")}>README.md</button>
        <button onClick={() => open("package.json")}>package.json</button>
        <button onClick={() => open("src/a.ts")}>src/a.ts</button>
        <button onClick={() => open("src/nested/b.ts")}>src/nested/b.ts</button>
      </div>
    );
  };
  return { FileTree };
});
vi.mock("./components/CodeReader", async () => {
  const React = await import("react");
  const CodeReader = React.forwardRef(function FakeCodeReader(
    props: {
      tab: { key: string; name: string; projectId: string };
      onDirtyChange: (dirty: boolean) => void;
      onStatus: (status: EditorStatus | null) => void;
      reloadToken: number;
      externalChangeToken: number;
      previewRequest?: { fragment: string | null; nonce: number } | null;
      initialView?: { line: number; character: number; scrollTop: number };
      reveal?: { line: number; character: number; nonce: number } | null;
      onGoToDefinition?: (position: { line: number; character: number }) => void;
      onOpenMarkdownFile?: (projectId: string, path: string, fragment: string | null) => void;
    },
    ref,
  ) {
    editorStatusHandler.current = props.onStatus;
    const [dirty, setDirty] = React.useState(false);
    const [locked, setLocked] = React.useState(false);
    const [cursor, setCursor] = React.useState({ line: 0, character: 0 });
    React.useEffect(() => {
      if (props.reveal) setCursor({ line: props.reveal.line, character: props.reveal.character });
    }, [props.reveal]);
    React.useImperativeHandle(
      ref,
      () => ({
        getCursor: () => cursor,
        getViewState: () => ({ ...cursor, scrollTop: 0 }),
        reveal: (request: { line: number; character: number }) =>
          setCursor({ line: request.line, character: request.character }),
        openFileSearch: () => fileSearchSpy(props.tab.key),
        focus: () => undefined,
        getText: () => "",
        isDirty: () => dirty,
        save: saveSpy,
        discardRecovery: discardRecoverySpy,
        reloadFromDisk: () => undefined,
        prepareFileOperation: async () => {
          setLocked(true);
          if (!dirty) return { status: "clean" };
          const result = await saveSpy();
          if (result.status === "saved" || result.status === "clean") {
            setDirty(false);
            props.onDirtyChange(false);
          }
          return result;
        },
        finishFileOperation: (options?: { reload?: boolean }) => {
          setLocked(false);
          finishSpy(options);
        },
      }),
      [dirty, cursor, props.tab.key],
    );
    return (
      <div
        data-testid={`editor-${props.tab.key}`}
        data-locked={String(locked)}
        data-reload={props.reloadToken}
        data-external={props.externalChangeToken}
        data-preview-fragment={props.previewRequest?.fragment}
        data-initial-line={props.initialView?.line}
        data-initial-scroll={props.initialView?.scrollTop}
        data-cursor-line={cursor.line}
      >
        {props.tab.name}
        <button
          onClick={() => {
            setCursor({ line: 3, character: 7 });
            props.onGoToDefinition?.({ line: 3, character: 7 });
          }}
        >
          go to definition from {props.tab.name}
        </button>
        <button onClick={() => props.onOpenMarkdownFile?.("p1", "guide.md", "guide")}>
          open Markdown link from {props.tab.name}
        </button>
        <button
          onClick={() =>
            props.onOpenMarkdownFile?.(props.tab.projectId, "docs/guide.md", "chapter")
          }
        >
          open nested Markdown link from {props.tab.name}
        </button>
        <button
          onClick={() => {
            setDirty(true);
            props.onDirtyChange(true);
          }}
        >
          {`make ${props.tab.name} dirty`}
        </button>
      </div>
    );
  });
  return { CodeReader };
});

import App from "./App";
import { DEFAULT_FONT_SETTINGS } from "./lib/fonts";
import { DEFAULT_PREFERENCES } from "./lib/preferences";
import { open } from "@tauri-apps/plugin-dialog";

async function menuAction(action: NativeMenuAction) {
  await act(async () => {
    try {
      await nativeMenu.action!(action);
    } catch (error) {
      nativeMenu.error!(error);
    }
  });
}

const editableStatus: EditorStatus = {
  path: "README.md",
  language: "Markdown",
  mode: "normal",
  lines: 1,
  readOnly: false,
  dirty: false,
  saving: false,
  autoSavePaused: false,
  warnings: [],
  encoding: "UTF-8",
};

describe("App editor panes", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    saveSpy.mockResolvedValue({ status: "clean" });
    gitApiMock.getFileBase.mockResolvedValue(null);
    gitApiMock.onRepositoryChange.mockResolvedValue(() => {});
    apiMock.bootstrapWorkspace.mockResolvedValue({
      projects: [{ id: "p1", name: "Demo", root: "/demo" }],
      activeProjectId: "p1",
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    apiMock.getCapabilities.mockResolvedValue({
      rgAvailable: true,
      ctagsAvailable: true,
      ctagsMessage: null,
      configMessage: null,
      lspServers: [],
    });
    apiMock.searchPaths.mockResolvedValue({ hits: [], indexing: false, message: null });
    apiMock.listDirectory.mockResolvedValue({
      projectId: "p1",
      path: "",
      entries: [
        {
          name: "README.md",
          path: "README.md",
          isDir: false,
          isSymlink: false,
          size: 10,
          modifiedMs: null,
        },
        {
          name: "package.json",
          path: "package.json",
          isDir: false,
          isSymlink: false,
          size: 10,
          modifiedMs: null,
        },
      ],
    });
    for (const name of [
      "onSearchEvent",
      "onFsChange",
      "onPathIndexStatus",
      "onLspStatus",
    ] as const) {
      apiMock[name].mockResolvedValue(() => undefined);
    }
    apiMock.setTheme.mockResolvedValue(undefined);
    apiMock.saveSettings.mockResolvedValue(undefined);
    windowMock.onCloseRequested.mockResolvedValue(() => {});
    windowMock.close.mockResolvedValue(undefined);
    apiMock.setActiveProject.mockResolvedValue(undefined);
    apiMock.startSearch.mockResolvedValue(undefined);
    apiMock.cancelSearch.mockResolvedValue(undefined);
    apiMock.cancelReplacePreview.mockResolvedValue(undefined);
    apiMock.continueSearch.mockResolvedValue(undefined);
    apiMock.takePendingFiles.mockResolvedValue([]);
    apiMock.onFileDrop.mockResolvedValue(() => {});
    apiMock.onOpenFiles.mockResolvedValue(() => {});
  });

  it("restores workspace tabs, the active tab and initial editor views", async () => {
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [
          { projectId: "p1", path: "README.md" },
          { projectId: "p1", path: "package.json" },
          { projectId: "removed", path: "gone.ts" },
          { projectId: "external:temp", path: "outside.ts" },
        ],
        active: { projectId: "p1", path: "README.md" },
        views: { "p1\u0000README.md": { line: 4, character: 2, scrollTop: 80 } },
        tree: { openProjects: ["p1"], expandedDirectories: [] },
      }),
    );
    render(<App />);
    const active = await screen.findByRole("tab", { name: "README.md" });
    await waitFor(() => expect(active).toHaveAttribute("aria-selected", "true"));
    expect(
      Array.from(document.querySelectorAll("[data-testid^='editor-']")).map((element) =>
        element.getAttribute("data-testid"),
      ),
    ).toEqual(["editor-p1\u0000README.md", "editor-p1\u0000package.json"]);
    expect(screen.getByTestId("editor-p1\u0000README.md")).toHaveAttribute(
      "data-initial-line",
      "4",
    );
    expect(screen.getByTestId("editor-p1\u0000README.md")).toHaveAttribute(
      "data-initial-scroll",
      "80",
    );
    expect(screen.queryByText("gone.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("outside.ts")).not.toBeInTheDocument();
  });

  it("keeps file actions unavailable in an empty workspace and restores saved menu settings", async () => {
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects: [],
      activeProjectId: null,
      theme: "dark",
      fonts: DEFAULT_FONT_SETTINGS,
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false, lineNumbers: false },
    });
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
    expect(nativeMenu.state).toMatchObject({
      ready: true,
      blocked: false,
      hasFile: false,
      canSave: false,
      canNavigate: false,
      theme: "dark",
      autoSave: false,
      lineNumbers: false,
    });
    await menuAction("save");
    await menuAction("close-tab");
    await menuAction("definition");
    await menuAction("terminal");
    expect(saveSpy).not.toHaveBeenCalled();
    expect(apiMock.findDefinitions).not.toHaveBeenCalled();
    expect(nativeMenu.state!.terminalOpen).toBe(true);
    expect(screen.getByRole("region", { name: "终端面板" })).toBeVisible();
    await menuAction("terminal");
    expect(nativeMenu.state!.terminalOpen).toBe(false);
    fireEvent.keyDown(window, { code: "Backquote", key: "`", ctrlKey: true });
    expect(screen.getByRole("region", { name: "终端面板" })).toBeVisible();
  });

  it("saves and searches the active file, disabling save while readonly or saving", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    act(() => editorStatusHandler.current!(editableStatus));
    expect(nativeMenu.state!.canSave).toBe(true);
    await menuAction("save");
    await menuAction("find");
    expect(saveSpy).toHaveBeenCalledOnce();
    expect(fileSearchSpy).toHaveBeenCalledOnce();
    for (const status of [
      { ...editableStatus, readOnly: true },
      { ...editableStatus, saving: true },
    ]) {
      act(() => editorStatusHandler.current!(status));
      expect(nativeMenu.state!.canSave).toBe(false);
      await menuAction("save");
    }
    expect(saveSpy).toHaveBeenCalledOnce();
  });

  it("routes Cmd+F and menu find to the active split pane without duplicate calls", async () => {
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        splitOpen: true,
        activePane: "secondary",
        tabs: [
          { projectId: "p1", path: "README.md", pane: "primary" },
          { projectId: "p1", path: "package.json", pane: "secondary" },
        ],
        active: { projectId: "p1", path: "package.json", pane: "secondary" },
        views: {},
        tree: { openProjects: [], expandedDirectories: [] },
      }),
    );
    render(<App />);
    let calls = 0;
    for (const path of ["package.json", "README.md"]) {
      const key = `p1\u0000${path}`;
      const editor = await screen.findByTestId(`editor-${key}`);
      fireEvent.pointerDown(editor);
      for (let press = 0; press < 2; press++) {
        fireEvent.keyDown(editor, { key: "f", code: "KeyF", metaKey: true });
        expect(fileSearchSpy).toHaveBeenCalledTimes(++calls);
        expect(fileSearchSpy).toHaveBeenLastCalledWith(key);
      }
      await menuAction("find");
      expect(fileSearchSpy).toHaveBeenCalledTimes(++calls);
      expect(fileSearchSpy).toHaveBeenLastCalledWith(key);
    }
  });

  it.each([
    ["definition", "findDefinitions"],
    ["references", "findReferences"],
    ["implementation", "findImplementations"],
  ] as const)("routes the %s menu to existing navigation", async (action, apiName) => {
    const user = userEvent.setup();
    apiMock[apiName].mockResolvedValueOnce({ source: "lsp", locations: [], message: null });
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    act(() => editorStatusHandler.current!(editableStatus));
    await menuAction(action);
    expect(apiMock[apiName]).toHaveBeenCalledWith("p1", "README.md", { line: 0, character: 0 });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("routes clicks through definition lookup with the source tab and its unsaved buffer", async () => {
    const user = userEvent.setup();
    apiMock.findDefinitions.mockResolvedValueOnce({
      source: "ctags",
      message: null,
      locations: [],
    });
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await user.click(screen.getByText("package.json"));
    // The callback explicitly identifies the source, even before a pane activation rerender.
    fireEvent.click(screen.getByText("go to definition from README.md"));
    await waitFor(() =>
      expect(apiMock.findDefinitions).toHaveBeenCalledWith("p1", "README.md", {
        line: 3,
        character: 7,
      }),
    );
    expect(apiMock.syncDocument).toHaveBeenCalledWith("p1", "README.md", "");
    expect(apiMock.syncDocument.mock.invocationCallOrder.at(-1)).toBeLessThan(
      apiMock.findDefinitions.mock.invocationCallOrder.at(-1)!,
    );
    expect(await screen.findByRole("dialog", { name: "定义" })).toBeInTheDocument();
  });

  it("navigates back and forward through definition jumps and clears forward on a new jump", async () => {
    const user = userEvent.setup();
    apiMock.findDefinitions.mockResolvedValueOnce({
      source: "lsp",
      message: null,
      locations: [
        {
          projectId: "p1",
          projectName: "Demo",
          path: "src/a.ts",
          name: "a",
          line: 7,
          character: 3,
          endLine: 7,
          endCharacter: 4,
        },
      ],
    });
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    act(() => editorStatusHandler.current!(editableStatus));
    await menuAction("definition");
    expect(await screen.findByRole("tab", { name: "a.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("editor-p1\u0000src/a.ts")).toHaveAttribute("data-cursor-line", "7");
    await waitFor(() => expect(nativeMenu.state!.canGoBack).toBe(true));

    await menuAction("back");
    expect(screen.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(nativeMenu.state!.canGoForward).toBe(true));
    await menuAction("forward");
    expect(screen.getByRole("tab", { name: "a.ts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("editor-p1\u0000src/a.ts")).toHaveAttribute("data-cursor-line", "7");

    await menuAction("back");
    await user.click(screen.getByText("package.json"));
    await waitFor(() => expect(nativeMenu.state!.canGoForward).toBe(false));
    fireEvent.keyDown(window, { code: "ArrowLeft", ctrlKey: true, altKey: true });
    expect(screen.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true");
  });

  it("saves and locks affected editors before the final preview, then applies without saving again", async () => {
    const user = userEvent.setup();
    apiMock.previewReplace.mockResolvedValue({
      files: [
        {
          projectId: "p1",
          path: "README.md",
          fingerprint: { size: 10, modifiedNs: "1" },
          matchCount: 2,
          lines: [{ lineNumber: 0, before: "needle", after: "value" }],
        },
      ],
      skipped: [],
      truncated: false,
    });
    apiMock.applyReplace.mockResolvedValue({
      outcomes: [
        {
          projectId: "p1",
          path: "README.md",
          status: "applied",
          matchCount: 2,
          message: null,
        },
      ],
    });
    saveSpy.mockResolvedValueOnce({ status: "saved" });
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await menuAction("search-workspace");
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), {
      target: { value: "needle" },
    });
    fireEvent.change(screen.getByLabelText("替换为"), { target: { value: "value" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    expect(await screen.findByText("1 个文件，2 处匹配")).toBeInTheDocument();
    expect(saveSpy).toHaveBeenCalledOnce();
    expect(apiMock.previewReplace).toHaveBeenCalledTimes(2);
    expect(apiMock.applyReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-p1\u0000README.md")).toHaveAttribute("data-locked", "true");
    expect(finishSpy).not.toHaveBeenCalled();
    saveSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    await waitFor(() =>
      expect(apiMock.applyReplace).toHaveBeenCalledWith(
        "needle",
        "value",
        [
          {
            projectId: "p1",
            path: "README.md",
            fingerprint: { size: 10, modifiedNs: "1" },
          },
        ],
        expect.objectContaining({ caseSensitive: false, regex: false }),
      ),
    );
    expect(await screen.findByText("已替换 2 处；1 个文件已处理。")).toBeInTheDocument();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(finishSpy).toHaveBeenCalledWith({ reload: true });
    expect(screen.getByTestId("editor-p1\u0000README.md")).toHaveAttribute("data-locked", "false");
  });

  it.each([
    "cancel",
    "leave",
    "save-conflict",
    "preview-error",
    "apply-error",
    "truncated",
  ] as const)("unlocks replacement editors after %s", async (scenario) => {
    const user = userEvent.setup();
    const preview = {
      files: [
        {
          projectId: "p1",
          path: "README.md",
          fingerprint: { size: 10, modifiedNs: "1" },
          matchCount: 1,
          lines: [],
        },
      ],
      skipped: [],
      truncated: false,
    };
    apiMock.previewReplace.mockResolvedValue(preview);
    if (scenario === "preview-error")
      apiMock.previewReplace
        .mockResolvedValueOnce(preview)
        .mockRejectedValueOnce(new Error("preview failed"));
    if (scenario === "truncated")
      apiMock.previewReplace
        .mockResolvedValueOnce(preview)
        .mockResolvedValueOnce({ ...preview, truncated: true });
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    if (scenario === "save-conflict") {
      await user.click(screen.getByText("make README.md dirty"));
      saveSpy.mockResolvedValueOnce({ status: "conflict", message: "save conflict" });
    }
    await menuAction("search-workspace");
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    if (scenario === "save-conflict" || scenario === "preview-error") {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        scenario === "save-conflict" ? "save conflict" : "preview failed",
      );
      expect(apiMock.previewReplace).toHaveBeenCalledTimes(scenario === "save-conflict" ? 1 : 2);
    } else {
      await screen.findByText("1 个文件，1 处匹配");
      if (scenario === "apply-error") {
        apiMock.applyReplace.mockRejectedValueOnce(new Error("apply failed"));
        fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("apply failed");
      } else if (scenario === "leave") {
        await user.click(screen.getByRole("button", { name: "项目文件" }));
      } else {
        if (scenario === "truncated")
          expect(screen.getByRole("button", { name: "应用替换" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "取消替换" }));
      }
    }
    await waitFor(() =>
      expect(screen.getByTestId("editor-p1\u0000README.md")).toHaveAttribute(
        "data-locked",
        "false",
      ),
    );
    expect(finishSpy).toHaveBeenCalledWith({ reload: false });
    await waitFor(() => expect(nativeMenu.state!.blocked).toBe(false));
    expect(screen.getByLabelText("在工作区中搜索")).not.toBeDisabled();
  });

  it("saves both panes before confirmation and only reloads successful replacement files", async () => {
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        splitOpen: true,
        activePane: "primary",
        tabs: [
          { projectId: "p1", path: "README.md", pane: "primary" },
          { projectId: "p1", path: "package.json", pane: "secondary" },
        ],
        active: { projectId: "p1", path: "README.md", pane: "primary" },
      }),
    );
    const files = ["README.md", "package.json"].map((path) => ({
      projectId: "p1",
      path,
      fingerprint: { size: 10, modifiedNs: "1" },
      matchCount: 1,
      lines: [],
    }));
    apiMock.previewReplace.mockResolvedValue({ files, skipped: [], truncated: false });
    apiMock.applyReplace.mockResolvedValueOnce({
      outcomes: [
        { projectId: "p1", path: "README.md", status: "applied", matchCount: 1, message: null },
        {
          projectId: "p1",
          path: "package.json",
          status: "conflict",
          matchCount: 1,
          message: "external conflict",
        },
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByText("make README.md dirty"));
    fireEvent.click(screen.getByText("make package.json dirty"));
    saveSpy.mockResolvedValue({ status: "saved" });
    await menuAction("search-workspace");
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    await screen.findByText("2 个文件，2 处匹配");
    expect(saveSpy).toHaveBeenCalledTimes(2);
    for (const path of ["README.md", "package.json"])
      expect(screen.getByTestId(`editor-p1\u0000${path}`)).toHaveAttribute("data-locked", "true");
    expect(finishSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    expect(await screen.findByText("已替换 1 处；2 个文件已处理。")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("external conflict");
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(finishSpy).toHaveBeenNthCalledWith(1, { reload: true });
    expect(finishSpy).toHaveBeenNthCalledWith(2, { reload: false });
  });

  it("locks and reloads an editor opened through a different nested project root", async () => {
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects: [
        { id: "p1", name: "Outer", root: "/demo" },
        { id: "p2", name: "Inner", root: "/demo/sub" },
      ],
      activeProjectId: "p1",
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [{ projectId: "p1", path: "sub/a.ts" }],
        active: { projectId: "p1", path: "sub/a.ts" },
      }),
    );
    apiMock.previewReplace.mockResolvedValue({
      files: [
        {
          projectId: "p2",
          path: "a.ts",
          fingerprint: { size: 1, modifiedNs: "1" },
          matchCount: 1,
          lines: [],
        },
      ],
      skipped: [],
      truncated: false,
    });
    apiMock.applyReplace.mockResolvedValueOnce({
      outcomes: [
        { projectId: "p2", path: "a.ts", status: "applied", matchCount: 1, message: null },
      ],
    });
    render(<App />);
    await screen.findByTestId("editor-p1\u0000sub/a.ts");
    await menuAction("search-workspace");
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    await screen.findByText("1 个文件，1 处匹配");
    expect(screen.getByTestId("editor-p1\u0000sub/a.ts")).toHaveAttribute("data-locked", "true");
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    await screen.findByText("已替换 1 处；1 个文件已处理。");
    expect(finishSpy).toHaveBeenCalledWith({ reload: true });
  });

  it("reorders tabs within each pane, persists order and preserves dirty editor instances", async () => {
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        splitOpen: true,
        activePane: "primary",
        tabs: [
          { projectId: "p1", path: "README.md", pane: "primary" },
          { projectId: "p1", path: "package.json", pane: "secondary" },
          { projectId: "p1", path: "src/a.ts", pane: "primary" },
          { projectId: "p1", path: "src/nested/b.ts", pane: "secondary" },
        ],
        active: { projectId: "p1", path: "README.md", pane: "primary" },
        paneActive: {
          primary: { projectId: "p1", path: "README.md" },
          secondary: { projectId: "p1", path: "package.json" },
        },
      }),
    );
    render(<App />);
    const editor = await screen.findByTestId("editor-p1\u0000README.md");
    const secondaryEditor = screen.getByTestId("editor-p1\u0000package.json");
    await userEvent.click(within(editor).getByRole("button", { name: "make README.md dirty" }));
    const readme = screen.getByRole("tab", { name: "README.md（未保存）" });
    const primary = document.querySelector<HTMLElement>('.editor-pane[data-pane="primary"]')!;
    const secondary = document.querySelector<HTMLElement>('.editor-pane[data-pane="secondary"]')!;
    saveSpy.mockClear();
    fireEvent.keyDown(readme, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(
      within(primary)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label")),
    ).toEqual(["a.ts", "README.md（未保存）"]);
    expect(
      within(secondary)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label")),
    ).toEqual(["package.json", "b.ts"]);
    fireEvent.keyDown(screen.getByRole("tab", { name: "b.ts" }), {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    });
    expect(
      within(secondary)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label")),
    ).toEqual(["b.ts", "package.json"]);
    const separator = screen.getByRole("separator", { name: "调整左右编辑区宽度" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "55");
    expect(screen.getByTestId("editor-p1\u0000README.md")).toBe(editor);
    expect(screen.getByTestId("editor-p1\u0000package.json")).toBe(secondaryEditor);
    expect(editor.closest(".document-panel")).not.toHaveAttribute("hidden");
    expect(readme).toHaveAttribute("aria-selected", "true");
    expect(saveSpy).not.toHaveBeenCalled();
    const stored = JSON.parse(localStorage.getItem("gaze:session")!);
    expect(
      stored.tabs
        .filter((tab: { pane: string }) => tab.pane === "primary")
        .map((tab: { path: string }) => tab.path),
    ).toEqual(["src/a.ts", "README.md"]);
    expect(
      stored.tabs
        .filter((tab: { pane: string }) => tab.pane === "secondary")
        .map((tab: { path: string }) => tab.path),
    ).toEqual(["src/nested/b.ts", "package.json"]);
  });

  it("keeps one editor per file across split panes and collapses an empty right pane", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByRole("button", { name: "在右侧打开编辑区" }));
    expect(screen.getByRole("separator", { name: "调整左右编辑区宽度" })).toBeInTheDocument();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByText("package.json"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "package.json" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    const readmePane = screen
      .getByTestId("editor-p1\u0000README.md")
      .closest(".document-panel")!
      .getAttribute("data-pane");
    const packagePane = screen
      .getByTestId("editor-p1\u0000package.json")
      .closest(".document-panel")!
      .getAttribute("data-pane");
    expect(readmePane).not.toBe(packagePane);
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "关闭右侧编辑区" }));
    expect(document.querySelectorAll(".editor-pane")).toHaveLength(1);
    expect(screen.queryByRole("separator", { name: "调整左右编辑区宽度" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "在右侧打开编辑区" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: "package.json" }));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "package.json" }));
    await user.click(await screen.findByRole("menuitem", { name: "移动到另一编辑区" }));
    expect(
      screen.getByTestId("editor-p1\u0000package.json").closest(".document-panel"),
    ).not.toHaveAttribute("hidden");

    await user.click(screen.getByRole("button", { name: "关闭 package.json" }));
    await waitFor(() => expect(document.querySelectorAll(".editor-pane")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "在右侧打开编辑区" })).toBeInTheDocument();
  });

  it("selects a fallback after moving a tab and collapses an empty secondary pane on a normal open", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("package.json"));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "package.json" }));
    await user.click(await screen.findByRole("menuitem", { name: "移动到另一编辑区" }));
    expect(
      screen.getByTestId("editor-p1\u0000README.md").closest(".document-panel"),
    ).not.toHaveAttribute("hidden");
    await user.click(screen.getByRole("tab", { name: "README.md" }));
    await user.click(screen.getByRole("button", { name: "package.json" }));
    expect(document.querySelectorAll(".editor-pane")).toHaveLength(1);
    expect(
      screen.getByTestId("editor-p1\u0000package.json").closest(".document-panel"),
    ).not.toHaveAttribute("hidden");
  });

  it("uses the clicked pane's project for current-project search", async () => {
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects: [
        { id: "p1", name: "One", root: "/one" },
        { id: "p2", name: "Two", root: "/two" },
      ],
      activeProjectId: "p2",
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        splitOpen: true,
        activePane: "secondary",
        tabs: [
          { projectId: "p1", path: "README.md", pane: "primary" },
          { projectId: "p2", path: "package.json", pane: "secondary" },
        ],
        active: { projectId: "p2", path: "package.json", pane: "secondary" },
        views: {},
        tree: { openProjects: [], expandedDirectories: [] },
      }),
    );
    render(<App />);
    fireEvent.pointerDown(await screen.findByTestId("editor-p1\u0000README.md"));
    await menuAction("search-workspace");
    expect(screen.getByRole("option", { name: "当前项目：One" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索范围"), { target: { value: "current" } });
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    await waitFor(() =>
      expect(apiMock.startSearch).toHaveBeenLastCalledWith(
        expect.any(String),
        "needle",
        expect.objectContaining({ projectIds: ["p1"] }),
      ),
    );
  });

  it("restores each pane's selected tab independently", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        splitOpen: true,
        activePane: "secondary",
        tabs: [
          { projectId: "p1", path: "README.md", pane: "primary" },
          { projectId: "p1", path: "package.json", pane: "primary" },
          { projectId: "p1", path: "src/a.ts", pane: "secondary" },
        ],
        active: { projectId: "p1", path: "src/a.ts", pane: "secondary" },
        views: {},
        tree: { openProjects: [], expandedDirectories: [] },
      }),
    );
    const first = render(<App />);
    await user.click(await screen.findByRole("tab", { name: "README.md" }));
    await user.click(screen.getByRole("tab", { name: "a.ts" }));
    first.unmount();
    render(<App />);
    expect(
      (await screen.findByTestId("editor-p1\u0000README.md")).closest(".document-panel"),
    ).not.toHaveAttribute("hidden");
    expect(
      screen.getByTestId("editor-p1\u0000src/a.ts").closest(".document-panel"),
    ).not.toHaveAttribute("hidden");
  });

  it("restores split pane ownership and the active pane from the session", async () => {
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [
          { projectId: "p1", path: "README.md", pane: "primary" },
          { projectId: "p1", path: "package.json", pane: "secondary" },
        ],
        active: { projectId: "p1", path: "README.md", pane: "primary" },
        activePane: "primary",
        splitOpen: true,
        views: {},
        tree: { openProjects: ["p1"], expandedDirectories: [] },
      }),
    );
    render(<App />);
    await screen.findByRole("tab", { name: "README.md" });
    expect(document.querySelectorAll(".editor-pane")).toHaveLength(2);
    expect(
      screen.getByTestId("editor-p1\u0000README.md").closest(".document-panel"),
    ).not.toHaveAttribute("hidden");
    expect(
      screen.getByTestId("editor-p1\u0000package.json").closest(".document-panel"),
    ).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "关闭右侧编辑区" })).toBeInTheDocument();
  });

  it("toggles the terminal before a focused input can consume Ctrl+Backquote", async () => {
    render(<App />);
    await waitFor(() => expect(nativeMenu.state?.ready).toBe(true));
    const input = document.createElement("textarea");
    const consume = vi.fn((event: KeyboardEvent) => event.stopPropagation());
    input.addEventListener("keydown", consume);
    document.body.append(input);
    input.focus();
    try {
      fireEvent.keyDown(input, { code: "Backquote", key: "`", ctrlKey: true });
      expect(screen.getByRole("region", { name: "终端面板" })).toBeVisible();
      fireEvent.keyDown(input, { code: "Backquote", key: "`", ctrlKey: true });
      expect(nativeMenu.state!.terminalOpen).toBe(false);
      expect(consume).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { code: "Backquote", key: "`", metaKey: true });
      expect(nativeMenu.state!.terminalOpen).toBe(false);
    } finally {
      input.remove();
    }
  });

  it("opens settings, search, views, terminal and quick open from menus", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
    await menuAction("search-workspace");
    expect(nativeMenu.state!.sidebarView).toBe("search");
    await menuAction("symbols");
    expect(nativeMenu.state!.sidebarView).toBe("symbols");
    await menuAction("git");
    expect(await screen.findByRole("region", { name: "Git 工作区" })).toBeVisible();
    await menuAction("files");
    expect(nativeMenu.state!.sidebarView).toBe("files");
    await menuAction("terminal");
    expect(screen.getByRole("region", { name: "终端面板" })).toBeVisible();
    await menuAction("terminal");
    expect(nativeMenu.state!.terminalOpen).toBe(false);
    await menuAction("quick-open");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(nativeMenu.state!.blocked).toBe(true);
    await menuAction("settings");
    expect(screen.queryByRole("dialog", { name: "设置" })).not.toBeInTheDocument();
  });

  it("opens selected files through the existing external-file flow and imports projects", async () => {
    vi.mocked(open).mockResolvedValueOnce(["/outside/test.md"]);
    apiMock.openExternalFiles.mockResolvedValueOnce({
      files: [
        { project: { id: "p1", name: "Demo", root: "/demo" }, path: "README.md", temporary: false },
      ],
      failures: [],
    });
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
    await menuAction("open-file");
    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false, title: "打开文件" });
    expect(apiMock.openExternalFiles).toHaveBeenCalledWith(["/outside/test.md"]);
    expect(await screen.findByRole("tab", { name: "README.md" })).toBeInTheDocument();
    vi.mocked(open).mockResolvedValueOnce(["/new-project"]);
    apiMock.importProjects.mockResolvedValueOnce({ projects: [], failures: [] });
    await menuAction("import-project");
    expect(apiMock.importProjects).toHaveBeenCalledWith(["/new-project"]);
    vi.mocked(open).mockResolvedValueOnce(null);
    await menuAction("open-file");
    expect(apiMock.openExternalFiles).toHaveBeenCalledOnce();
    expect(nativeMenu.state!.blocked).toBe(false);
  });

  it("persists quick settings serially and synchronizes with the settings dialog", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
    let finish!: () => void;
    apiMock.saveSettings.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = nativeMenu.action!("auto-save");
    });
    expect(nativeMenu.state).toMatchObject({ blocked: true, autoSave: true });
    await menuAction("word-wrap");
    expect(apiMock.saveSettings).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await pending;
    });
    expect(nativeMenu.state).toMatchObject({ blocked: false, autoSave: false, wordWrap: true });
    await menuAction("word-wrap");
    await menuAction("line-numbers");
    await menuAction("status-bar");
    expect(nativeMenu.state).toMatchObject({
      wordWrap: false,
      lineNumbers: false,
      showStatusBar: false,
    });
    expect(document.querySelector(".statusbar")).not.toBeVisible();
    await menuAction("settings");
    await user.click(screen.getByRole("button", { name: "文件与保存" }));
    expect(screen.getByRole("switch", { name: "自动保存" })).not.toBeChecked();
    await menuAction("auto-save");
    expect(apiMock.saveSettings).toHaveBeenCalledTimes(4);
    await user.click(screen.getByRole("switch", { name: "自动保存" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(nativeMenu.state).toMatchObject({ blocked: false, autoSave: true });
    expect(apiMock.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({
          autoSave: true,
          wordWrap: false,
          lineNumbers: false,
        }),
      }),
    );
  });

  it("keeps committed settings on save failure and updates themes through the existing IPC", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
    apiMock.saveSettings.mockRejectedValueOnce(new Error("磁盘不可写"));
    await menuAction("auto-save");
    expect(nativeMenu.state).toMatchObject({ autoSave: true, blocked: false });
    expect(screen.getByText("磁盘不可写")).toBeInTheDocument();
    await menuAction("theme-dark");
    expect(apiMock.setTheme).toHaveBeenLastCalledWith("dark");
    expect(nativeMenu.state!.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    apiMock.setTheme.mockRejectedValueOnce(new Error("主题保存失败"));
    await menuAction("theme-light");
    expect(nativeMenu.state!.theme).toBe("dark");
    expect(screen.getByText("主题保存失败")).toBeInTheDocument();
  });

  it("preserves the tab on menu-close conflicts and supports cancellation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    saveSpy.mockResolvedValueOnce({ status: "conflict", message: "文件已在磁盘上修改。" });
    await menuAction("close-tab");
    expect(screen.getByRole("dialog")).toHaveTextContent("文件已在磁盘上修改。");
    expect(screen.getByRole("tab")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await menuAction("close-tab");
    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
  });

  it.each(["error", "conflict"])(
    "keeps the window on menu-quit %s and allows retry",
    async (status) => {
      const user = userEvent.setup();
      const closed = vi.fn();
      windowMock.close.mockImplementation(async () => {
        const event = { preventDefault: vi.fn() };
        windowMock.onCloseRequested.mock.calls.at(-1)![0](event);
        if (!event.preventDefault.mock.calls.length) closed();
      });
      render(<App />);
      await user.click(await screen.findByText("README.md"));
      await user.click(screen.getByText("make README.md dirty"));
      saveSpy.mockResolvedValueOnce({ status, message: "保存失败" });
      await waitFor(() => expect(windowMock.onCloseRequested).toHaveBeenCalled());
      expect(screen.getByRole("tab")).toHaveAccessibleName("README.md（未保存）");
      await menuAction("quit");
      expect(windowMock.close).toHaveBeenCalledOnce();
      expect(saveSpy).toHaveBeenCalledOnce();
      expect(await screen.findByRole("dialog")).toHaveTextContent("保存失败");
      expect(closed).not.toHaveBeenCalled();
      expect(screen.getByRole("tab")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "取消" }));
      await menuAction("quit");
      await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    },
  );

  it("blocks menu actions while a file operation is in flight", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
    let finish!: (entry: DirEntry) => void;
    apiMock.createEntry.mockReturnValueOnce(
      new Promise<DirEntry>((resolve) => {
        finish = resolve;
      }),
    );
    let pending!: Promise<FileOperationResult>;
    act(() => {
      pending = fileOperationHandler.current!(
        {
          kind: "createFile",
          project: { id: "p1", name: "Demo", root: "/demo" },
          parentPath: "",
        },
        "new.txt",
      );
    });
    expect(nativeMenu.state!.blocked).toBe(true);
    await menuAction("settings");
    await menuAction("quit");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(windowMock.close).not.toHaveBeenCalled();
    await act(async () => {
      finish({
        path: "new.txt",
        name: "new.txt",
        isDir: false,
        isSymlink: false,
        size: 0,
        modifiedMs: null,
      });
      await pending;
    });
    expect(nativeMenu.state!.blocked).toBe(false);
  });

  async function emitDrop(paths: string[], element: Element, type = "drop") {
    vi.spyOn(document, "elementFromPoint").mockReturnValue(element);
    await waitFor(() => expect(apiMock.onFileDrop).toHaveBeenCalled());
    await act(async () =>
      apiMock.onFileDrop.mock.calls[0]![0]({ type, paths, position: { x: 40, y: 60 } }),
    );
  }

  const externalProject = { id: "external:test", name: "/outside", root: "/outside" };

  it("opens multiple dropped originals, deduplicates dirty tabs and preserves the active workspace", async () => {
    const user = userEvent.setup();
    apiMock.openExternalFiles.mockImplementation(async (paths: string[]) => ({
      files: paths.map((path) => ({
        project: externalProject,
        path: path.split("/").pop(),
        temporary: true,
      })),
      failures: [],
    }));
    render(<App />);
    await screen.findByRole("complementary", { name: "工作区侧栏" });
    await emitDrop(["/outside/a.txt", "/outside/b.txt"], document.querySelector(".document-area")!);
    expect(await screen.findByRole("tab", { name: "b.txt" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "make b.txt dirty" }));
    await emitDrop(["/outside/b.txt"], document.querySelector(".tab-strip")!);
    await waitFor(() => expect(apiMock.openExternalFiles).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "b.txt（未保存）" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "a.txt" }));
    expect(apiMock.setActiveProject).not.toHaveBeenCalled();
    expect(apiMock.importProjects).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "关闭 a.txt" }));
    await waitFor(() =>
      expect(apiMock.closeExternalFile).toHaveBeenCalledWith("external:test", "a.txt"),
    );
  });

  it("copies drops into the resolved tree directory and opens the returned copy names", async () => {
    apiMock.copyDroppedFiles.mockResolvedValue({
      entries: [
        { name: "a 副本.txt", path: "src/a 副本.txt", isDir: false },
        { name: "b.txt", path: "src/b.txt", isDir: false },
      ],
      failures: [],
    });
    render(<App />);
    await screen.findByRole("complementary", { name: "工作区侧栏" });
    const tree = document.querySelector<HTMLElement>(".file-tree-pane")!;
    tree.dataset.dropProject = "p1";
    tree.dataset.dropParent = "src";
    await emitDrop(["/outside/a.txt", "/outside/b.txt"], tree);
    expect(await screen.findByRole("tab", { name: "b.txt" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(apiMock.copyDroppedFiles).toHaveBeenCalledWith("p1", "src", [
      "/outside/a.txt",
      "/outside/b.txt",
    ]);
    expect(screen.getByRole("tab", { name: "a 副本.txt" })).toBeInTheDocument();
    expect(apiMock.openExternalFiles).not.toHaveBeenCalled();
    expect(apiMock.pasteEntries).not.toHaveBeenCalled();
  });

  it("rejects a tree drop without a project and clears drag feedback on leave", async () => {
    apiMock.bootstrapWorkspace.mockResolvedValue({
      projects: [],
      activeProjectId: null,
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    render(<App />);
    await screen.findByRole("button", { name: "设置" });
    const tree = document.querySelector(".file-tree-pane")!;
    await emitDrop(["/outside/a.txt"], tree, "enter");
    expect(tree).toHaveClass("file-drop-target");
    expect(screen.getByText("复制并打开")).toBeInTheDocument();
    await emitDrop([], tree, "leave");
    expect(tree).not.toHaveClass("file-drop-target");
    expect(screen.queryByText("复制并打开")).not.toBeInTheDocument();
    await emitDrop(["/outside/a.txt"], tree);
    expect(await screen.findByText("请先导入并选择一个项目。")).toBeInTheDocument();
    expect(apiMock.copyDroppedFiles).not.toHaveBeenCalled();
  });

  it("drains startup and running Dock requests after registering the listener", async () => {
    const order: string[] = [];
    apiMock.onOpenFiles.mockImplementation(async () => {
      order.push("listen");
      return () => {};
    });
    apiMock.takePendingFiles.mockImplementation(async () => {
      order.push("take");
      return order.filter((item) => item === "take").length === 1
        ? ["/outside/start.txt"]
        : ["/outside/running.txt"];
    });
    apiMock.openExternalFiles.mockImplementation(async (paths: string[]) => ({
      files: paths.map((path) => ({
        project: externalProject,
        path: path.split("/").pop(),
        temporary: true,
      })),
      failures: [],
    }));
    render(<App />);
    expect(await screen.findByRole("tab", { name: "start.txt" })).toBeInTheDocument();
    expect(order.slice(0, 2)).toEqual(["listen", "take"]);
    await act(async () => apiMock.onOpenFiles.mock.calls[0]![0]());
    expect(await screen.findByRole("tab", { name: "running.txt" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(apiMock.openExternalFiles.mock.calls.map(([paths]) => paths)).toEqual([
      ["/outside/start.txt"],
      ["/outside/running.txt"],
    ]);
  });

  it("keeps successful files when a batch also contains rejected folders", async () => {
    apiMock.openExternalFiles.mockResolvedValue({
      files: [{ project: externalProject, path: "a.txt", temporary: true }],
      failures: [{ path: "/outside/folder", message: "暂不支持拖入文件夹或特殊文件。" }],
    });
    render(<App />);
    await screen.findByRole("complementary", { name: "工作区侧栏" });
    await emitDrop(
      ["/outside/folder", "/outside/a.txt"],
      document.querySelector(".document-area")!,
    );
    expect(await screen.findByRole("tab", { name: "a.txt" })).toBeInTheDocument();
    expect(screen.getByText("folder：暂不支持拖入文件夹或特殊文件。")).toBeInTheDocument();
  });

  it("forwards Markdown anchors to a sibling opened under a different temporary context", async () => {
    const user = userEvent.setup();
    apiMock.openExternalFiles
      .mockResolvedValueOnce({
        files: [{ project: externalProject, path: "start.md", temporary: true }],
        failures: [],
      })
      .mockResolvedValueOnce({
        files: [
          {
            project: { id: "external:nested", root: "/outside/docs", name: "/outside/docs" },
            path: "guide.md",
            temporary: true,
          },
        ],
        failures: [],
      });
    render(<App />);
    await screen.findByRole("complementary", { name: "工作区侧栏" });
    await emitDrop(["/outside/start.md"], document.querySelector(".document-area")!);
    await user.click(
      await screen.findByRole("button", { name: "open nested Markdown link from start.md" }),
    );
    expect(await screen.findByRole("tab", { name: "guide.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("editor-external:nested\u0000guide.md")).toHaveAttribute(
      "data-preview-fragment",
      "chapter",
    );
    expect(apiMock.openExternalFiles).toHaveBeenLastCalledWith(["/outside/docs/guide.md"]);
  });

  it("opens Markdown links through the existing tabs and forwards the preview anchor", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByRole("button", { name: "open Markdown link from README.md" }));
    expect(await screen.findByRole("tab", { name: "guide.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("editor-p1\u0000guide.md")).toHaveAttribute(
      "data-preview-fragment",
      "guide",
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "open Markdown link from guide.md" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("hides routine editor badges while retaining read-only and save warnings", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    const status: EditorStatus = {
      path: "README.md",
      language: "Markdown",
      mode: "normal",
      lines: 1,
      readOnly: false,
      dirty: false,
      saving: false,
      autoSavePaused: false,
      warnings: [],
      encoding: "UTF-8",
    };
    const footer = within(screen.getByRole("contentinfo"));
    act(() => editorStatusHandler.current!(status));
    expect(footer.getByText("Markdown")).toBeInTheDocument();
    expect(footer.queryByText("可编辑")).not.toBeInTheDocument();
    expect(footer.queryByText("自动保存", { exact: true })).not.toBeInTheDocument();

    for (const [field, label] of [
      ["readOnly", "只读"],
      ["saving", "保存中…"],
      ["dirty", "未保存"],
      ["autoSavePaused", "自动保存已暂停"],
    ] as const) {
      act(() => editorStatusHandler.current!({ ...status, [field]: true }));
      expect(footer.getByText(label)).toBeInTheDocument();
    }
  });

  it("keeps every opened editor mounted and saves the active tab with Ctrl+S", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText("README.md"));
    await waitFor(() => expect(screen.getByTestId("editor-p1\u0000README.md")).toBeInTheDocument());

    await user.click(screen.getByText("package.json"));
    await waitFor(() =>
      expect(screen.getByTestId("editor-p1\u0000package.json")).toBeInTheDocument(),
    );

    const firstPane = screen.getByTestId("editor-p1\u0000README.md").closest(".document-panel");
    const secondPane = screen.getByTestId("editor-p1\u0000package.json").closest(".document-panel");
    expect(firstPane).toHaveAttribute("hidden");
    expect(secondPane).not.toHaveAttribute("hidden");

    await user.keyboard("{Control>}s{/Control}");
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it("saves before closing a dirty tab and only asks when saving fails", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await user.click(screen.getByRole("button", { name: "关闭 README.md" }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("editor-p1\u0000README.md")).not.toBeInTheDocument(),
    );

    discardRecoverySpy.mockClear();
    saveSpy.mockResolvedValueOnce({ status: "conflict", message: "文件已在磁盘上修改。" });
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    await user.click(screen.getByRole("button", { name: "关闭 package.json" }));

    const dialog = await screen.findByRole("dialog", { name: "关闭 package.json？" });
    expect(dialog).toHaveTextContent("文件已在磁盘上修改。");
    expect(discardRecoverySpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "放弃修改并关闭" }));
    await waitFor(() =>
      expect(screen.queryByTestId("editor-p1\u0000package.json")).not.toBeInTheDocument(),
    );
    expect(discardRecoverySpy).toHaveBeenCalledOnce();
  });

  it("saves the whole batch before closing and selects the nearest remaining tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    await user.click(screen.getByText("src/a.ts"));
    saveSpy.mockClear();
    // The context tab differs from the active tab.
    fireEvent.contextMenu(screen.getByRole("tab", { name: "README.md（未保存）" }));
    await user.click(screen.getByRole("menuitem", { name: "关闭右侧" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(screen.getByRole("tab")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab")).toHaveAccessibleName("README.md（未保存）");
    expect(saveSpy).toHaveBeenCalledOnce();
  });

  it("keeps the entire batch when saving fails, supports cancel, retry and discard", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    const closeAll = async () => {
      fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
      await user.click(screen.getByRole("menuitem", { name: "关闭所有" }));
    };
    saveSpy.mockResolvedValueOnce({ status: "conflict", message: "磁盘冲突" });
    await closeAll();
    expect(await screen.findByRole("dialog", { name: "关闭这些标签页？" })).toHaveTextContent(
      "磁盘冲突",
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    saveSpy.mockRejectedValueOnce(new Error("磁盘不可写"));
    await closeAll();
    expect(await screen.findByRole("dialog")).toHaveTextContent("磁盘不可写");
    saveSpy.mockResolvedValueOnce({ status: "error", message: "重试失败" });
    await user.click(screen.getByRole("button", { name: "重试保存并关闭" }));
    expect(await screen.findByText("重试失败")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "放弃修改并关闭" }));
    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
  });

  it("retries saving successfully and then closes the complete batch", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await user.click(screen.getByText("package.json"));
    saveSpy.mockResolvedValueOnce({ status: "conflict" });
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
    await user.click(screen.getByRole("menuitem", { name: "关闭所有" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "重试保存并关闭" }));
    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("selects the nearest tab on the right, then the left, when closing the active tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("src/a.ts"));
    await user.click(screen.getByRole("tab", { name: "package.json" }));
    await user.click(screen.getByRole("button", { name: "关闭 package.json" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "a.ts" })).toHaveAttribute("aria-selected", "true"),
    );
    await user.click(screen.getByRole("button", { name: "关闭 a.ts" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "README.md" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("retains every target until all saves finish and releases the editor locks", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    let finish!: (result: { status: string }) => void;
    saveSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    finishSpy.mockClear();
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
    await user.click(screen.getByRole("menuitem", { name: "关闭所有" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(finishSpy).not.toHaveBeenCalled();
    await act(async () => finish({ status: "saved" }));
    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
    expect(finishSpy).toHaveBeenCalledTimes(2);
  });

  const project = { id: "p1", name: "Demo", root: "/demo" };
  const entry = (path: string, isDir = false): DirEntry => ({
    path,
    name: path.split("/").pop()!,
    isDir,
    isSymlink: false,
    size: 0,
    modifiedMs: null,
  });

  it("saves affected tabs, remaps directory descendants and keeps the active tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("src/a.ts"));
    await user.click(screen.getByText("make a.ts dirty"));
    await user.click(screen.getByText("src/nested/b.ts"));
    await user.click(screen.getByText("make b.ts dirty"));
    saveSpy.mockClear();
    apiMock.moveEntry.mockImplementation(async () => {
      expect(saveSpy).toHaveBeenCalledTimes(2);
      return entry("renamed", true);
    });
    await act(async () => {
      await fileOperationHandler.current!(
        { kind: "rename", project, entry: entry("src", true) },
        "renamed",
      );
    });
    expect(apiMock.moveEntry).toHaveBeenCalledWith("p1", "src", "renamed");
    expect(screen.queryByTestId("editor-p1\u0000src/a.ts")).not.toBeInTheDocument();
    expect(screen.getByTestId("editor-p1\u0000renamed/a.ts")).toBeInTheDocument();
    expect(
      screen.getByTestId("editor-p1\u0000renamed/nested/b.ts").closest(".document-panel"),
    ).not.toHaveAttribute("hidden");
    expect(finishSpy).toHaveBeenCalledTimes(2);
  });

  it("saves the whole selection before bulk mutations and keeps failed files open", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    saveSpy.mockClear();
    apiMock.trashEntry.mockImplementation(async (_id: string, path: string) => {
      expect(saveSpy).toHaveBeenCalledTimes(2);
      if (path === "package.json") throw new Error("denied");
    });
    let result: FileOperationResult;
    await act(async () => {
      result = await fileOperationHandler.current!(
        {
          kind: "trash",
          project,
          entry: entry("README.md"),
          entries: [entry("README.md"), entry("package.json")],
        },
        "",
      );
    });
    expect(result!).toEqual({
      results: [
        { source: entry("README.md"), entry: undefined },
        { source: entry("package.json"), error: "denied" },
      ],
    });
    expect(screen.queryByTestId("editor-p1\u0000README.md")).not.toBeInTheDocument();
    expect(screen.getByTestId("editor-p1\u0000package.json")).toBeInTheDocument();
  });

  it("rejects the entire bulk operation when any editor cannot save", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    saveSpy
      .mockResolvedValueOnce({ status: "saved" })
      .mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await expect(
        fileOperationHandler.current!(
          {
            kind: "trash",
            project,
            entry: entry("README.md"),
            entries: [entry("README.md"), entry("package.json")],
          },
          "",
        ),
      ).rejects.toThrow("disk full");
    });
    expect(apiMock.trashEntry).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-p1\u0000README.md")).toBeInTheDocument();
    expect(screen.getByTestId("editor-p1\u0000package.json")).toBeInTheDocument();
    expect(finishSpy).toHaveBeenCalledTimes(2);
  });

  it("moves each selected root once and remaps every open descendant", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("src/a.ts"));
    await user.click(screen.getByText("README.md"));
    apiMock.moveEntry.mockImplementation(async (_id: string, _path: string, destination: string) =>
      entry(destination, destination === "target/src"),
    );
    await act(async () => {
      await fileOperationHandler.current!(
        {
          kind: "move",
          project,
          entry: entry("src", true),
          entries: [entry("src", true), entry("src/a.ts"), entry("README.md"), entry("README.md")],
        },
        "target",
      );
    });
    expect(apiMock.moveEntry.mock.calls).toEqual([
      ["p1", "src", "target/src"],
      ["p1", "README.md", "target/README.md"],
    ]);
    expect(screen.getByTestId("editor-p1\u0000target/src/a.ts")).toBeInTheDocument();
    expect(screen.getByTestId("editor-p1\u0000target/README.md")).toBeInTheDocument();
  });

  it("blocks trash on save conflict and preserves the original editor", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("make README.md dirty"));
    saveSpy.mockResolvedValueOnce({ status: "conflict", message: "resolve conflict first" });
    await act(async () => {
      await expect(
        fileOperationHandler.current!({ kind: "trash", project, entry: entry("README.md") }, ""),
      ).rejects.toThrow("resolve conflict first");
    });
    expect(apiMock.trashEntry).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-p1\u0000README.md")).toBeInTheDocument();
    expect(finishSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves tabs on mutation failure and closes descendants only after successful trash", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("src/a.ts"));
    await user.click(screen.getByText("src/nested/b.ts"));
    apiMock.trashEntry.mockRejectedValueOnce(new Error("trash failed"));
    const operation: FileOperation = { kind: "trash", project, entry: entry("src", true) };
    await act(async () => {
      await expect(fileOperationHandler.current!(operation, "")).rejects.toThrow("trash failed");
    });
    expect(screen.getByTestId("editor-p1\u0000src/a.ts")).toBeInTheDocument();
    expect(screen.getByTestId("editor-p1\u0000src/nested/b.ts")).toBeInTheDocument();
    apiMock.trashEntry.mockResolvedValueOnce(undefined);
    await act(async () => {
      await fileOperationHandler.current!(operation, "");
    });
    expect(screen.queryByTestId("editor-p1\u0000src/a.ts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-p1\u0000src/nested/b.ts")).not.toBeInTheDocument();
  });

  it("refreshes every open project file after watcher overflow, including files outside the index", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    const fsChange = apiMock.onFsChange.mock.calls[0]![0];
    act(() =>
      fsChange({
        projectId: "p1",
        rescan: true,
        changedFiles: [],
        changedDirectories: [""],
        removedPaths: [],
      }),
    );
    expect(screen.getByTestId("editor-p1\u0000README.md")).toHaveAttribute("data-reload", "1");
    expect(screen.getByTestId("editor-p1\u0000package.json")).toHaveAttribute("data-reload", "0");
    expect(screen.getByTestId("editor-p1\u0000package.json")).toHaveAttribute("data-external", "1");
  });

  it("queues watcher events during a move and handles unrelated external changes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("package.json"));
    const fsChange = apiMock.onFsChange.mock.calls[0]![0];
    apiMock.moveEntry.mockImplementation(async () => {
      fsChange({
        projectId: "p1",
        changedFiles: ["package.json", "new.md"],
        changedDirectories: [""],
        removedPaths: ["README.md"],
      });
      expect(screen.getByTestId("editor-p1\u0000package.json")).toHaveAttribute("data-reload", "0");
      return entry("new.md");
    });
    await act(async () => {
      await fileOperationHandler.current!(
        { kind: "rename", project, entry: entry("README.md") },
        "new.md",
      );
    });
    expect(screen.getByTestId("editor-p1\u0000new.md")).toHaveAttribute("data-reload", "2");
    expect(screen.getByTestId("editor-p1\u0000package.json")).toHaveAttribute("data-reload", "1");
    expect(screen.queryByText("当前文件已在磁盘上删除。")).not.toBeInTheDocument();
  });

  it("opens the Git workspace and returns to the same file editor", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    const editor = screen.getByTestId("editor-p1\u0000README.md");
    await user.click(screen.getByRole("button", { name: "Git 管理" }));
    expect(await screen.findByRole("region", { name: "Git 工作区" })).toBeVisible();
    const rail = screen.getByRole("navigation", { name: "侧栏视图" });
    expect(within(rail).getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(within(rail).getByRole("button", { name: "项目文件" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    const sidebar = screen.getByRole("complementary", { name: "工作区侧栏" });
    expect(within(sidebar).queryByRole("button", { name: "README.md" })).not.toBeInTheDocument();
    expect(editor).not.toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭 Git 工作区" })).not.toBeInTheDocument();
    await user.click(within(rail).getByRole("button", { name: "项目文件" }));
    expect(screen.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("editor-p1\u0000README.md")).toBe(editor);
    expect(editor).toBeVisible();
    expect(within(rail).getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(within(rail).getByRole("button", { name: "项目文件" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("preloads only the default Git project in idle time without changing the visible view", async () => {
    let idle!: IdleRequestCallback;
    const schedule = vi.fn((callback: IdleRequestCallback) => {
      idle = callback;
      return 7;
    });
    vi.stubGlobal("requestIdleCallback", schedule);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects: [project, { id: "p2", name: "Second", root: "/second" }],
      activeProjectId: project.id,
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Git 管理" });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), { timeout: 1500 });
    expect(container.querySelector('[aria-label="Git 工作区"]')).toBeNull();
    await act(async () => {
      idle({ didTimeout: false, timeRemaining: () => 10 });
    });
    await waitFor(() =>
      expect(container.querySelectorAll('[aria-label="Git 工作区"]')).toHaveLength(1),
    );
    const workspace = container.querySelector('[aria-label="Git 工作区"]')!;
    expect(workspace).toHaveAttribute("data-preload", "true");
    expect(workspace).toHaveAttribute("data-root", "/demo");
    expect(workspace).not.toBeVisible();
    expect(screen.getByRole("button", { name: "项目文件" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await menuAction("git");
    expect(screen.getByRole("region", { name: "Git 工作区" })).toBe(workspace);
    expect(workspace).toBeVisible();
  });

  it("cancels pending idle preloading on unmount", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn(() => 8),
    );
    vi.stubGlobal("cancelIdleCallback", cancel);
    const { unmount } = render(<App />);
    await screen.findByRole("button", { name: "Git 管理" });
    unmount();
    expect(cancel).toHaveBeenCalledWith(8);
  });

  it.each([
    {
      change: "root changes",
      projects: [{ id: "p1", name: "Demo", root: "/new" }],
      activeProjectId: "p1",
    },
    {
      change: "default project changes",
      projects: [{ id: "p2", name: "Second", root: "/second" }],
      activeProjectId: "p2",
    },
    { change: "project is removed", projects: [], activeProjectId: null },
  ])("cancels old idle work when the $change", async ({ projects, activeProjectId }) => {
    const cancel = vi.fn();
    const schedule = vi.fn().mockReturnValueOnce(9).mockReturnValue(10);
    vi.stubGlobal("requestIdleCallback", schedule);
    vi.stubGlobal("cancelIdleCallback", cancel);
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Git 管理" });
    vi.mocked(open).mockResolvedValueOnce(["/new"]);
    apiMock.importProjects.mockResolvedValueOnce({ projects: [], failures: [] });
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects,
      activeProjectId,
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    await menuAction("import-project");
    expect(cancel).toHaveBeenCalledWith(9);
    if (!projects.length) {
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[aria-label="Git 工作区"]')).toBeNull();
      return;
    }
    expect(schedule).toHaveBeenCalledTimes(2);
    await act(async () => {
      schedule.mock.calls[1]![0]();
    });
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Git 工作区"]')).toHaveAttribute(
        "data-root",
        projects[0]!.root,
      ),
    );
  });

  it("preloads after the fallback delay when idle callbacks are unavailable", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Git 管理" });
    expect(container.querySelector('[aria-label="Git 工作区"]')).toBeNull();
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Git 工作区"]')).toHaveAttribute(
        "data-preload",
        "true",
      ),
    );
    expect(screen.queryByRole("region", { name: "Git 工作区" })).not.toBeInTheDocument();
  });

  it("keeps a separate Git browsing position for each visited project without opening tabs", async () => {
    const user = userEvent.setup();
    apiMock.bootstrapWorkspace.mockResolvedValue({
      projects: [project, { id: "p2", name: "Second", root: "/second" }],
      activeProjectId: project.id,
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Git 管理" }));
    const first = await screen.findByRole("textbox", { name: "Git 浏览位置" });
    await user.type(first, "src/a.ts");
    await user.click(screen.getByRole("button", { name: "Git 项目 Second" }));
    const second = screen.getByRole("textbox", { name: "Git 浏览位置" });
    expect(second).not.toBe(first);
    expect(second).toHaveValue("");
    await user.type(second, "历史 / abc123");
    await user.click(screen.getByRole("button", { name: `Git 项目 ${project.name}` }));
    expect(screen.getByRole("textbox", { name: "Git 浏览位置" })).toBe(first);
    expect(first).toHaveValue("src/a.ts");
    await user.click(screen.getByRole("button", { name: "Git 项目 Second" }));
    expect(screen.getByRole("textbox", { name: "Git 浏览位置" })).toBe(second);
    expect(second).toHaveValue("历史 / abc123");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "Git 工作区" })).toHaveLength(1);
  });

  it("replaces Git with project files when its sidebar icon is selected", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: "README.md" });
    await user.click(screen.getByRole("button", { name: "Git 管理" }));
    expect(await screen.findByRole("region", { name: "Git 工作区" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "项目文件" }));
    expect(screen.getByRole("button", { name: "README.md" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Git 工作区" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Git 管理" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("opens a newly created file and moves within a selected parent", async () => {
    render(<App />);
    await screen.findByText("README.md");
    apiMock.createEntry.mockResolvedValueOnce(entry("new.ts"));
    await act(async () => {
      await fileOperationHandler.current!(
        { kind: "createFile", project, parentPath: "" },
        "new.ts",
      );
    });
    expect(screen.getByTestId("editor-p1\u0000new.ts")).toBeInTheDocument();
    apiMock.moveEntry.mockResolvedValueOnce(entry("src/new.ts"));
    await act(async () => {
      await fileOperationHandler.current!({ kind: "move", project, entry: entry("new.ts") }, "src");
    });
    expect(apiMock.moveEntry).toHaveBeenCalledWith("p1", "new.ts", "src/new.ts");
    expect(screen.getByTestId("editor-p1\u0000src/new.ts")).toBeInTheDocument();
  });

  it("does not replace an open destination tab with unsaved contents", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("README.md"));
    await user.click(screen.getByText("package.json"));
    await user.click(screen.getByText("make package.json dirty"));
    await act(async () => {
      await expect(
        fileOperationHandler.current!(
          { kind: "rename", project, entry: entry("README.md") },
          "package.json",
        ),
      ).rejects.toThrow("目标路径在编辑器中仍有未保存内容");
    });
    expect(apiMock.moveEntry).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-p1\u0000package.json")).toBeInTheDocument();
    expect(screen.getByTestId("editor-p1\u0000README.md")).toBeInTheDocument();
  });

  it("routes Cmd file shortcuts to the tree and leaves text fields alone", async () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
      configurable: true,
    });
    apiMock.copyEntry.mockResolvedValue(undefined);
    apiMock.pasteEntries.mockResolvedValue({ entries: [], failures: [] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText("src/a.ts"));

    fireEvent.keyDown(window, { code: "KeyC", key: "c", metaKey: true });
    await waitFor(() => expect(apiMock.copyEntry).toHaveBeenCalledWith("p1", "src/a.ts"));
    fireEvent.keyDown(window, { code: "KeyV", key: "v", metaKey: true });
    await waitFor(() => expect(apiMock.pasteEntries).toHaveBeenCalledWith("p1", "src"));
    fireEvent.keyDown(window, { code: "Backspace", key: "Backspace", metaKey: true });
    expect(trashSpy).toHaveBeenCalledWith("p1", "src/a.ts");
    fireEvent.keyDown(window, { code: "KeyN", key: "n", metaKey: true });
    expect(createSpy).toHaveBeenLastCalledWith("p1", "src", false);
    fireEvent.keyDown(window, { code: "KeyN", key: "N", metaKey: true, shiftKey: true });
    expect(createSpy).toHaveBeenLastCalledWith("p1", "src", true);
    fireEvent.keyDown(window, { code: "F2", key: "F2" });
    expect(renameSpy).toHaveBeenCalledWith("p1", "src/a.ts");

    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { code: "KeyC", key: "c", metaKey: true });
    fireEvent.keyDown(input, { code: "KeyN", key: "n", metaKey: true });
    fireEvent.keyDown(input, { code: "F2", key: "F2" });
    input.remove();
    expect(apiMock.copyEntry).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(renameSpy).toHaveBeenCalledTimes(1);
  });
});
