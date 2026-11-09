import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  bootstrapWorkspace: vi.fn(),
  importProjects: vi.fn(),
  removeProject: vi.fn(),
  setActiveProject: vi.fn(),
  setTheme: vi.fn(),
  saveSettings: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  readRecovery: vi.fn(),
  writeRecovery: vi.fn(),
  deleteRecovery: vi.fn(),
  writeFile: vi.fn(),
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
  undoReplace: vi.fn(),
  getOutline: vi.fn(),
  searchSymbols: vi.fn(),
  findDefinitions: vi.fn(),
  findReferences: vi.fn(),
  findImplementations: vi.fn(),
  onSearchEvent: vi.fn(),
  onFsChange: vi.fn(),
  onPathIndexStatus: vi.fn(),
  onLspStatus: vi.fn(),
  onFileDrop: vi.fn(),
  onOpenFiles: vi.fn(),
  takePendingFiles: vi.fn(),
  openExternalFiles: vi.fn(),
  closeExternalFile: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  api: apiMock,
  gitApi: {
    context: vi.fn().mockResolvedValue({ repository: null }),
    onRepositoryChange: vi.fn().mockResolvedValue(() => {}),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./git/GitWorkspace", () => ({ default: () => null }));

import App from "./App";
import { gitApi } from "./lib/api";
import type { GitContext } from "./git/models";
import { DEFAULT_FONT_SETTINGS, fontStack } from "./lib/fonts";
import { DEFAULT_PREFERENCES } from "./lib/preferences";

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitApi.context).mockResolvedValue({ repository: null } as GitContext);
    localStorage.clear();
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
      ],
    });
    for (const name of [
      "onSearchEvent",
      "onFsChange",
      "onPathIndexStatus",
      "onLspStatus",
      "onFileDrop",
      "onOpenFiles",
    ] as const) {
      apiMock[name].mockResolvedValue(() => undefined);
    }
    apiMock.readRecovery.mockResolvedValue(null);
    apiMock.writeRecovery.mockResolvedValue(null);
    apiMock.deleteRecovery.mockResolvedValue(undefined);
    apiMock.setTheme.mockResolvedValue(undefined);
    apiMock.saveSettings.mockResolvedValue(undefined);
    apiMock.setActiveProject.mockResolvedValue(undefined);
    apiMock.takePendingFiles.mockResolvedValue([]);
    apiMock.startSearch.mockResolvedValue(undefined);
    apiMock.cancelSearch.mockResolvedValue(undefined);
    apiMock.cancelReplacePreview.mockResolvedValue(undefined);
    apiMock.continueSearch.mockResolvedValue(undefined);
  });

  it("restores the saved language and switches only after saving without rebuilding the editor", async () => {
    const user = userEvent.setup();
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects: [{ id: "p1", name: "Demo", root: "/demo" }],
      activeProjectId: "p1",
      theme: "system",
      language: "en",
      fonts: DEFAULT_FONT_SETTINGS,
    });
    apiMock.readFile.mockResolvedValue({
      kind: "text",
      projectId: "p1",
      path: "README.md",
      content: "keep this buffer\n",
      encoding: "UTF-8",
      encodingKind: "utf8",
      lineEnding: "lf",
      mode: "normal",
      editable: true,
      editBlockedReason: null,
      fingerprint: { size: 17, modifiedNs: "1" },
      size: 17,
      warnings: [],
    });
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [{ projectId: "p1", path: "README.md" }],
        active: { projectId: "p1", path: "README.md" },
      }),
    );
    const app = render(<App />);
    try {
      await screen.findByRole("button", { name: "Settings" });
      const editor = await screen.findByRole("textbox", { name: "code file README.md" });
      const view = EditorView.findFromDOM(editor)!;
      view.dispatch({ selection: { anchor: 5 } });
      await user.click(screen.getByRole("button", { name: "Settings" }));
      await user.click(screen.getByRole("combobox", { name: "Language" }));
      await user.click(screen.getByRole("option", { name: "简体中文" }));
      apiMock.saveSettings.mockRejectedValueOnce(new Error("Cannot write settings"));
      await user.click(screen.getByRole("button", { name: "Save settings" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
      expect(document.documentElement.lang).toBe("en");
      await user.click(screen.getByRole("button", { name: "Save settings" }));
      await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
      expect(apiMock.saveSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ language: "zh-CN" }),
      );
      expect(screen.getByRole("textbox", { name: "代码文件 README.md" })).toBe(editor);
      expect(view.state.doc.toString()).toBe("keep this buffer\n");
      expect(view.state.selection.main.anchor).toBe(5);
    } finally {
      app.unmount();
      const { setLanguage } = await import("./lib/i18n");
      act(() => setLanguage("zh-CN"));
    }
  });

  it("shows the current project before its branch in the title bar and hides the branch without a repository", async () => {
    vi.mocked(gitApi.context).mockResolvedValue({
      repository: { id: 1, branch: "feature/title-bar" },
    } as GitContext);
    render(<App />);
    const branch = await screen.findByRole("status", { name: "当前 Git 分支" });
    expect(branch).toHaveTextContent("feature/title-bar");
    expect(branch.closest(".topbar")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toHaveTextContent(/Demo\s*feature\/title-bar/);
    vi.mocked(gitApi.context).mockResolvedValue({ repository: null } as GitContext);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.queryByRole("status", { name: "当前 Git 分支" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("banner")).getByText("Demo")).toBeInTheDocument();
  });

  it("keeps an undecided crash draft when closing and reopening its clean tab", async () => {
    const draft = {
      projectId: "p1",
      path: "README.md",
      content: "valuable crash draft\n",
      originalFingerprint: { size: 5, modifiedNs: "1" },
      updatedAtMs: 1_700_000_000_000,
    };
    apiMock.readRecovery.mockResolvedValue(draft);
    apiMock.readFile.mockResolvedValue({
      kind: "text",
      projectId: "p1",
      path: "README.md",
      content: "disk\n",
      encoding: "UTF-8",
      encodingKind: "utf8",
      lineEnding: "lf",
      mode: "normal",
      editable: true,
      editBlockedReason: null,
      fingerprint: draft.originalFingerprint,
      size: 5,
      warnings: [],
    });
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [{ projectId: "p1", path: "README.md" }],
        active: { projectId: "p1", path: "README.md" },
      }),
    );
    const user = userEvent.setup();
    const first = render(<App />);
    await screen.findByRole("button", { name: "恢复未保存修改" });
    expect(within(screen.getByRole("banner")).queryByText("README.md")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭 README.md" }));
    await waitFor(() => expect(screen.queryByRole("tab")).not.toBeInTheDocument());
    expect(apiMock.deleteRecovery).not.toHaveBeenCalled();
    first.unmount();
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [{ projectId: "p1", path: "README.md" }],
        active: { projectId: "p1", path: "README.md" },
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: "恢复未保存修改" });
    await user.click(screen.getByRole("button", { name: "放弃恢复" }));
    await waitFor(() => expect(apiMock.deleteRecovery).toHaveBeenCalledWith("p1", "README.md"));
  });

  it("preserves the actual editor buffer, selection and undo history across moving and merging panes", async () => {
    const user = userEvent.setup();
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects: [{ id: "p1", name: "Demo", root: "/demo" }],
      activeProjectId: "p1",
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
    });
    apiMock.readFile.mockResolvedValue({
      kind: "text",
      projectId: "p1",
      path: "README.md",
      content: "original\n",
      encoding: "UTF-8",
      encodingKind: "utf8",
      lineEnding: "lf",
      mode: "normal",
      editable: true,
      editBlockedReason: null,
      fingerprint: { size: 9, modifiedNs: "1" },
      size: 9,
      warnings: [],
    });
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [{ projectId: "p1", path: "README.md" }],
        active: { projectId: "p1", path: "README.md" },
      }),
    );
    render(<App />);
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    const element = document.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(element)!;
    act(() =>
      view.dispatch({ changes: { from: 0, to: 8, insert: "unsaved" }, selection: { anchor: 3 } }),
    );
    fireEvent.contextMenu(screen.getByRole("tab", { name: /README.md/ }));
    await user.click(await screen.findByRole("menuitem", { name: "移动到另一编辑区" }));
    expect(document.querySelector(".cm-editor")).toBe(element);
    expect(view.state.doc.toString()).toBe("unsaved\n");
    expect(view.state.selection.main.head).toBe(3);
    await user.click(screen.getByRole("button", { name: "关闭右侧编辑区" }));
    expect(document.querySelector(".cm-editor")).toBe(element);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("original\n");
    expect(apiMock.writeFile).not.toHaveBeenCalled();
    expect(apiMock.readFile).toHaveBeenCalledOnce();
  });

  it("locks the editor for replacement and reloads it after apply and undo", async () => {
    const user = userEvent.setup();
    apiMock.bootstrapWorkspace.mockResolvedValueOnce({
      projects: [{ id: "p1", name: "Demo", root: "/demo" }],
      activeProjectId: "p1",
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
    });
    let disk = "needle\n";
    let fingerprint = { size: disk.length, modifiedNs: "1" };
    apiMock.readFile.mockImplementation(async () => ({
      kind: "text",
      projectId: "p1",
      path: "README.md",
      content: disk,
      encoding: "UTF-8",
      encodingKind: "utf8",
      lineEnding: "lf",
      mode: "normal",
      editable: true,
      editBlockedReason: null,
      fingerprint,
      size: disk.length,
      warnings: [],
    }));
    apiMock.writeFile.mockImplementation(async (_projectId, _path, text) => {
      disk = text;
      fingerprint = { size: disk.length, modifiedNs: "2" };
      return { fingerprint, size: disk.length };
    });
    apiMock.previewReplace.mockImplementation(async () => ({
      files: [
        {
          projectId: "p1",
          path: "README.md",
          fingerprint,
          matchCount: 1,
          lines: [
            { lineNumber: 0, before: disk.trim(), after: disk.replace("needle", "value").trim() },
          ],
        },
      ],
      skipped: [],
      truncated: false,
    }));
    apiMock.applyReplace.mockImplementation(async (_query, _replacement, targets) => {
      expect(targets[0].fingerprint).toEqual({ size: "needle draft\n".length, modifiedNs: "2" });
      disk = "value draft\n";
      fingerprint = { size: disk.length, modifiedNs: "3" };
      return {
        outcomes: [
          { projectId: "p1", path: "README.md", status: "applied", matchCount: 1, message: null },
        ],
      };
    });
    apiMock.undoReplace.mockImplementation(async () => {
      disk = "needle draft\n";
      fingerprint = { size: disk.length, modifiedNs: "4" };
      return {
        outcomes: [
          { projectId: "p1", path: "README.md", status: "applied", matchCount: 1, message: null },
        ],
      };
    });
    localStorage.setItem(
      "gaze:session",
      JSON.stringify({
        version: 1,
        tabs: [{ projectId: "p1", path: "README.md" }],
        active: { projectId: "p1", path: "README.md" },
      }),
    );
    render(<App />);
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
    act(() => view.dispatch({ changes: { from: 6, insert: " draft" } }));
    await user.click(screen.getByRole("button", { name: "全局搜索" }));
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.change(screen.getByLabelText("替换为"), { target: { value: "value" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    await screen.findByText("1 个文件，1 处匹配");
    expect(apiMock.writeFile).toHaveBeenCalledOnce();
    expect(apiMock.previewReplace).toHaveBeenCalledTimes(2);
    expect(view.state.readOnly).toBe(true);
    act(() => view.dispatch({ changes: { from: 0, insert: "blocked" } }));
    expect(view.state.doc.toString()).toBe("needle draft\n");
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    await screen.findByText("已替换 1 处；1 个文件已处理。");
    await waitFor(() =>
      expect(document.querySelector(".cm-content")).toHaveTextContent("value draft"),
    );
    const reloaded = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(reloaded.state.readOnly).toBe(false);
    expect(apiMock.writeFile).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "撤销上次替换" }));
    expect(await screen.findByText("已恢复 1 个文件。")).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector(".cm-content")).toHaveTextContent("needle draft"),
    );
    expect(apiMock.undoReplace).toHaveBeenCalledOnce();
    expect(apiMock.writeFile).toHaveBeenCalledOnce();
  });

  it("cancels backend preview with its request id and ignores a late preview", async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    apiMock.previewReplace.mockImplementation(
      () =>
        new Promise<any>((resolve) => {
          finish = resolve;
        }),
    );
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "全局搜索" }));
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.change(screen.getByLabelText("替换为"), { target: { value: "value" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    await waitFor(() => expect(apiMock.previewReplace).toHaveBeenCalledOnce());
    const [requestId, query, replacement] = apiMock.previewReplace.mock.calls[0]!;
    expect(requestId).toEqual(expect.any(String));
    expect(query).toBe("needle");
    expect(replacement).toBe("value");
    const cancel = screen.getByRole("button", { name: "取消替换" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(apiMock.cancelReplacePreview).toHaveBeenCalledWith(requestId);
    await act(async () =>
      finish({
        files: [
          {
            projectId: "p1",
            path: "README.md",
            fingerprint: { size: 6, modifiedNs: "1" },
            matchCount: 1,
            lines: [],
          },
        ],
        skipped: [],
        truncated: false,
      }),
    );
    expect(screen.queryByText("1 个文件，1 处匹配")).not.toBeInTheDocument();
  });

  it("restores the workspace and persists theme changes through IPC", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("complementary", { name: "工作区侧栏" })).toBeInTheDocument();
    expect(screen.queryByText("READ · EDIT")).not.toBeInTheDocument();
    const themeButton = screen.getByRole("button", { name: "主题：跟随系统" });
    await user.click(themeButton);
    await waitFor(() => expect(apiMock.setTheme).toHaveBeenCalledWith("light"));
    await waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalledWith("p1", ""));
  });

  it("restores preferences and applies status bar changes only after saving", async () => {
    const user = userEvent.setup();
    apiMock.bootstrapWorkspace.mockResolvedValue({
      projects: [],
      activeProjectId: null,
      theme: "system",
      fonts: DEFAULT_FONT_SETTINGS,
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false, showStatusBar: false },
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    const statusbar = document.querySelector(".statusbar")!;
    expect(statusbar).not.toBeVisible();
    await user.click(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
        name: "窗口与布局",
      }),
    );
    await user.click(screen.getByRole("switch", { name: "显示状态栏" }));
    expect(statusbar).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(statusbar).toBeVisible());
    expect(apiMock.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: expect.objectContaining({ autoSave: false, showStatusBar: true }),
      }),
    );
  });

  it("restores fonts and applies settings only after a successful save", async () => {
    const user = userEvent.setup();
    const stored = { ui: "system", editor: "consolas", terminal: "maple" } as const;
    apiMock.bootstrapWorkspace.mockResolvedValue({
      projects: [],
      activeProjectId: null,
      theme: "system",
      fonts: stored,
    });
    apiMock.saveSettings.mockRejectedValueOnce(new Error("磁盘不可写"));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "编辑器" }));
    expect(screen.getByLabelText("编辑器字体")).toHaveTextContent("Consolas");
    await user.click(screen.getByLabelText("编辑器字体"));
    await user.click(screen.getByRole("option", { name: "Maple Mono NF CN（内置）" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
        name: "终端",
      }),
    );
    await user.click(screen.getByLabelText("终端字体"));
    await user.click(screen.getByRole("option", { name: "Consolas（本机字体）" }));
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(
      fontStack("consolas", "editor"),
    );
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘不可写");
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(
      fontStack("consolas", "editor"),
    );
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(apiMock.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fonts: {
          ui: "system",
          editor: "maple",
          terminal: "consolas",
        },
      }),
    );
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(
      fontStack("maple", "editor"),
    );
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
        name: "终端",
      }),
    );
    expect(screen.getByLabelText("终端字体")).toHaveTextContent("Consolas");
    await user.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(screen.getByLabelText("终端字体")).toHaveTextContent("Maple Mono NF CN");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(apiMock.saveSettings).toHaveBeenCalledTimes(2);
    await user.keyboard("{Control>}[Comma]{/Control}");
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
        name: "终端",
      }),
    );
    expect(screen.getByLabelText("终端字体")).toHaveTextContent("Consolas");
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toHaveFocus();
  });

  it("restores separate palettes, switches modes and keeps the palette on save failure", async () => {
    const user = userEvent.setup();
    apiMock.bootstrapWorkspace.mockResolvedValue({
      projects: [],
      activeProjectId: null,
      theme: "light",
      fonts: DEFAULT_FONT_SETTINGS,
      colorSchemes: { light: "catppuccin", dark: "nord" },
    });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    expect(document.documentElement.dataset.colorScheme).toBe("catppuccin");
    expect(document.documentElement.style.getPropertyValue("--surface")).toBe("#eff1f5");
    await user.click(screen.getByRole("button", { name: "GitHub Light" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(document.documentElement.dataset.colorScheme).toBe("catppuccin");
    await user.click(screen.getByRole("button", { name: "主题：浅色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.colorScheme).toBe("nord");
    await user.click(screen.getByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "GitHub Dark" }));
    apiMock.saveSettings.mockRejectedValueOnce(new Error("磁盘不可写"));
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘不可写");
    expect(document.documentElement.dataset.colorScheme).toBe("nord");
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(apiMock.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ colorSchemes: { light: "catppuccin", dark: "github" } }),
    );
    expect(document.documentElement.dataset.colorScheme).toBe("github");
    await user.click(screen.getByRole("button", { name: "设置" }));
    const original = screen.getAllByRole("button", { name: "Gaze 原配色" });
    await user.click(original[1]!);
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(document.documentElement.dataset.colorScheme).toBe("original"));
    expect(document.documentElement.style.getPropertyValue("--surface")).toBe("#24262c");
  });
});
