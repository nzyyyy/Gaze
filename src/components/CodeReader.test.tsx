import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { EditorView, showTooltip } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { setDiagnostics } from "@codemirror/lint";
import { completionStatus, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  readRecovery: vi.fn(),
  writeRecovery: vi.fn(),
  deleteRecovery: vi.fn(),
  writeFile: vi.fn(),
  completeCode: vi.fn(),
  completePaths: vi.fn(),
  requestAiCompletion: vi.fn(),
  cancelAiCompletion: vi.fn(),
  syncDocument: vi.fn(),
  findDefinitions: vi.fn(),
  resolveMarkdownLink: vi.fn(),
}));

const gitApiMock = vi.hoisted(() => ({
  getFileBase: vi.fn(),
  onRepositoryChange: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMock, gitApi: gitApiMock }));

beforeEach(() => {
  gitApiMock.getFileBase.mockResolvedValue(null);
  gitApiMock.onRepositoryChange.mockResolvedValue(() => {});
  apiMock.readRecovery.mockResolvedValue(null);
  apiMock.writeRecovery.mockResolvedValue(null);
  apiMock.deleteRecovery.mockResolvedValue(undefined);
  apiMock.completeCode.mockResolvedValue({ items: [] });
  apiMock.completePaths.mockReset().mockResolvedValue([]);
  apiMock.requestAiCompletion.mockReset().mockResolvedValue({ type: "empty" });
  apiMock.cancelAiCompletion.mockReset().mockResolvedValue(undefined);
  apiMock.syncDocument.mockResolvedValue(undefined);
  apiMock.findDefinitions.mockResolvedValue({
    source: "lsp",
    message: null,
    locations: [
      { projectId: "p1", path: "src/a.ts", line: 0, character: 0, endLine: 0, endCharacter: 8 },
    ],
  });
  apiMock.resolveMarkdownLink.mockRejectedValue(new Error("missing"));
});

import { CodeReader, type CodeReaderHandle, type EditorTab, type SaveResult } from "./CodeReader";
import type { EditorDiffSnapshot } from "../git/EditorDiff";
import type { TextFile } from "../lib/types";
import { DEFAULT_PREFERENCES, type Preferences } from "../lib/preferences";
import type { RecoveryRecord } from "../lib/api";
import type { NavigationTarget } from "../lib/shortcuts";
import { setLanguage } from "../lib/i18n";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { columnMode, selectedEditorText } from "../lib/columnSelection";
import { pluginApi } from "../plugins/api";
import { PluginProvider } from "../plugins/runtime";

const tab: EditorTab = {
  key: "p1\u0000src/a.ts",
  projectId: "p1",
  projectName: "Demo",
  path: "src/a.ts",
  name: "a.ts",
};

function textFile(content: string, overrides: Partial<TextFile> = {}): TextFile {
  return {
    kind: "text",
    projectId: "p1",
    path: "src/a.ts",
    content,
    encoding: "UTF-8",
    encodingKind: "utf8",
    lineEnding: "lf",
    mode: "normal",
    editable: true,
    editBlockedReason: null,
    fingerprint: { size: content.length, modifiedNs: "1" },
    size: content.length,
    warnings: [],
    ...overrides,
  };
}

function renderReader(
  overrides: {
    editable?: boolean;
    reason?: string | null;
    content?: string;
    lineEnding?: "lf" | "crlf";
    filename?: string;
    mode?: TextFile["mode"];
    active?: boolean;
    initialView?: { line: number; character: number; scrollTop: number };
    recovery?: RecoveryRecord | null;
    preferences?: Preferences;
    withPlugins?: boolean;
    onGoToDefinition?: (position: { line: number; character: number }) => void;
    onNavigate?: (target: NavigationTarget) => boolean;
    onOpenComparison?: (snapshot: EditorDiffSnapshot) => void;
  } = {},
) {
  const onDirtyChange = vi.fn();
  const onSaved = vi.fn();
  const onStatus = vi.fn();
  const ref = createRef<CodeReaderHandle>();
  apiMock.readRecovery.mockResolvedValue(overrides.recovery ?? null);
  apiMock.readFile.mockResolvedValue(
    textFile(overrides.content ?? "const value = 1;\n", {
      editable: overrides.editable ?? true,
      editBlockedReason: overrides.reason ?? null,
      lineEnding: overrides.lineEnding ?? "lf",
      mode: overrides.mode ?? "normal",
    }),
  );
  const props = {
    ref,
    tab: overrides.filename
      ? {
          ...tab,
          key: `p1\u0000${overrides.filename}`,
          path: overrides.filename,
          name: overrides.filename,
        }
      : tab,
    active: overrides.active ?? true,
    theme: "light" as const,
    preferences: overrides.preferences,
    initialView: overrides.initialView,
    reveal: null,
    reloadToken: 0,
    externalChangeToken: 0,
    onGoToDefinition: overrides.onGoToDefinition,
    onNavigate: overrides.onNavigate,
    onOpenComparison: overrides.onOpenComparison,
    onStatus,
    onDirtyChange,
    onSaved,
  };
  const reader = <CodeReader {...props} />;
  const tree = overrides.withPlugins ? (
    <PluginProvider preferences={DEFAULT_PREFERENCES}>{reader}</PluginProvider>
  ) : (
    reader
  );
  return { ...render(tree), ref, onDirtyChange, onSaved, onStatus, props };
}

async function editorContent(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return document.querySelector(".cm-content") as HTMLElement;
}

async function clickGitMarker(view: EditorView, kind: "added" | "deleted", line: number) {
  const marker = await waitFor(() => {
    const element = view.dom.querySelector<HTMLElement>(`.cm-git-line-${kind}`);
    expect(element).not.toBeNull();
    return element!;
  });
  const block = view.lineBlockAt(view.state.doc.line(line).from);
  vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, view.documentTop + block.top, 11, block.height),
  );
  fireEvent.mouseDown(marker, { button: 0 });
}

it("binds navigation and problem keys from the configured shortcuts", async () => {
  const onNavigate = vi.fn().mockReturnValue(true);
  renderReader({
    content: "const first = 1;\nconst second = 2;\n",
    onNavigate,
    preferences: { ...DEFAULT_PREFERENCES, shortcuts: { back: "F4", definition: "" } },
  });
  const view = EditorView.findFromDOM(await editorContent())!;
  act(() =>
    view.dispatch(
      setDiagnostics(view.state, [{ from: 6, to: 11, severity: "error", message: "Problem" }]),
    ),
  );
  view.focus();
  // An unbound key falls through: nothing else uses ⌘B here.
  expect(fireEvent.keyDown(view.contentDOM, { code: "KeyB", key: "b", metaKey: true })).toBe(true);
  expect(onNavigate).not.toHaveBeenCalled();
  act(() => view.dispatch({ selection: { anchor: 8 } }));
  fireEvent.keyDown(view.contentDOM, {
    code: "BracketRight",
    key: "]",
    metaKey: true,
  });
  expect(onNavigate).toHaveBeenCalledOnce();
  expect(onNavigate).toHaveBeenLastCalledWith("forward");
  fireEvent.keyDown(view.contentDOM, { code: "ArrowUp", key: "ArrowUp", altKey: true });
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
    "first",
  );
  fireEvent.keyDown(view.contentDOM, { code: "ArrowDown", key: "ArrowDown", altKey: true });
  expect(view.state.selection.main.from).toBe(view.state.selection.main.to);
  // F2 moves to the next problem instead of renaming the file.
  fireEvent.keyDown(view.contentDOM, { code: "F2", key: "F2" });
  expect(view.state.selection.main.from).toBe(6);
  fireEvent.keyDown(view.contentDOM, { code: "F4", key: "F4" });
  expect(onNavigate).toHaveBeenCalledTimes(2);
  expect(onNavigate).toHaveBeenLastCalledWith("back");
});

it("selects matches in temporal order and keeps the latest selected match as the primary cursor", async () => {
  const content = "name names name NAME name";
  renderReader({ content });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  view.focus();
  act(() => view.dispatch({ selection: { anchor: 12 } }));
  const next = () => fireEvent.keyDown(dom, { code: "KeyG", key: "g", ctrlKey: true });
  next();
  next();
  next();
  expect(view.state.selection.ranges.map(({ from }) => from)).toEqual([0, 11, 21]);
  expect(view.state.selection.main.from).toBe(0);
  fireEvent.keyDown(dom, { code: "KeyG", key: "G", ctrlKey: true, shiftKey: true });
  expect(view.state.selection.ranges.map(({ from }) => from)).toEqual([11, 21]);
  expect(view.state.selection.main.from).toBe(21);
  fireEvent.keyDown(dom, { code: "Escape", key: "Escape" });
  expect(view.state.selection.ranges.map(({ from, to }) => [from, to])).toEqual([[25, 25]]);
  act(() => view.dispatch({ selection: { anchor: 1 } }));
  fireEvent.keyDown(dom, { code: "KeyG", key: "g", ctrlKey: true, metaKey: true });
  expect(view.state.selection.ranges.map(({ from }) => from)).toEqual([0, 11, 21]);
});

it("duplicates selected text and entire lines, moves and deletes lines, and opens the file shortcuts", async () => {
  renderReader({ content: "first\nlast" });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  view.focus();
  const key = (code: string, name: string) =>
    fireEvent.keyDown(dom, { code, key: name, metaKey: true });
  act(() => view.dispatch({ selection: { anchor: 1, head: 3 } }));
  key("KeyD", "d");
  expect(view.state.doc.toString()).toBe("firirst\nlast");
  act(() => view.dispatch({ selection: { anchor: 0 } }));
  key("KeyD", "d");
  expect(view.state.doc.toString()).toBe("firirst\nfirirst\nlast");
  act(() => view.dispatch({ selection: { anchor: view.state.doc.line(3).from } }));
  fireEvent.keyDown(dom, { code: "ArrowUp", key: "ArrowUp", altKey: true, shiftKey: true });
  expect(view.state.doc.toString()).toBe("firirst\nlast\nfirirst");
  key("Backspace", "Backspace");
  expect(view.state.doc.toString()).toBe("firirst\nfirirst");
  key("KeyL", "l");
  expect(document.querySelector(".cm-goto-line input")).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape" });
  key("KeyR", "r");
  expect(document.querySelector('.cm-search input[name="replace"]')).toHaveFocus();
});

it("moves a complete TypeScript statement and its inline comment with Command Shift arrows", async () => {
  const original = "first(\n  1,\n); // first\nsecond();\n";
  renderReader({ content: original });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  await waitFor(() => expect(syntaxTree(view.state).topNode.name).toBe("Script"));
  view.focus();
  act(() => view.dispatch({ selection: { anchor: original.indexOf("1") } }));
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", metaKey: true, shiftKey: true });
  const moved = "second();\nfirst(\n  1,\n); // first\n";
  expect(view.state.doc.toString()).toBe(moved);
  expect(view.state.selection.main.head).toBe(moved.indexOf("1"));
  expect(view.state.selection.main.empty).toBe(true);
  fireEvent.keyDown(dom, { code: "ArrowUp", key: "ArrowUp", metaKey: true, shiftKey: true });
  expect(view.state.doc.toString()).toBe(original);
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe(moved);
});

it("keeps moved Python statements and their comments in the same suite", async () => {
  const original =
    "def run():\n    first()\n    # Attached\n    second(\n        1,\n    )\n\noutside()\n";
  renderReader({ filename: "example.py", content: original });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  await waitFor(() =>
    expect(syntaxTree(view.state).topNode.firstChild?.name).toBe("FunctionDefinition"),
  );
  view.focus();
  act(() => view.dispatch({ selection: { anchor: original.indexOf("second") } }));
  const up = () =>
    fireEvent.keyDown(dom, { code: "ArrowUp", key: "ArrowUp", metaKey: true, shiftKey: true });
  const moved =
    "def run():\n    # Attached\n    second(\n        1,\n    )\n    first()\n\noutside()\n";
  up();
  expect(view.state.doc.toString()).toBe(moved);
  up();
  expect(view.state.doc.toString()).toBe(moved);
});

it("leaves code intact if rearranging statements would merge them", async () => {
  const content = "const zero = 0;\n(first)()\nsecond()\n";
  renderReader({ content });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  await waitFor(() => expect(syntaxTree(view.state).topNode.name).toBe("Script"));
  view.focus();
  act(() => view.dispatch({ selection: { anchor: content.indexOf("first") } }));
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", metaKey: true, shiftKey: true });
  expect(view.state.doc.toString()).toBe(content);
  expect(view.state.selection.main.empty).toBe(true);
});

it("moves a method within its class instead of moving the enclosing declaration", async () => {
  const content = "class Example {\n  first() {\n    run();\n  }\n  second() {}\n}\noutside();\n";
  renderReader({ content });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  await waitFor(() => expect(syntaxTree(view.state).topNode.name).toBe("Script"));
  view.focus();
  act(() => view.dispatch({ selection: { anchor: content.indexOf("first") } }));
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", metaKey: true, shiftKey: true });
  expect(view.state.doc.toString()).toBe(
    "class Example {\n  second() {}\n  first() {\n    run();\n  }\n}\noutside();\n",
  );
});

it("honors duplicate remapping and does not fall back to the former move-line binding", async () => {
  renderReader({
    content: "first\nlast",
    preferences: { ...DEFAULT_PREFERENCES, shortcuts: { duplicate: "F4", "move-line-down": "" } },
  });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  view.focus();
  fireEvent.keyDown(dom, { code: "KeyD", key: "d", metaKey: true });
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", altKey: true, shiftKey: true });
  fireEvent.keyDown(dom, { code: "F4", key: "F4", isComposing: true });
  expect(view.state.doc.toString()).toBe("first\nlast");
  fireEvent.keyDown(dom, { code: "F4", key: "F4" });
  expect(view.state.doc.toString()).toBe("first\nfirst\nlast");
});

it("moves lines with statement shortcuts in a plain-text gitignore", async () => {
  renderReader({ filename: ".gitignore", content: "node_modules/\ndist/\ncoverage/\n" });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  view.focus();
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", metaKey: true, shiftKey: true });
  expect(view.state.doc.toString()).toBe("dist/\nnode_modules/\ncoverage/\n");
  expect(view.state.selection.main.head).toBe(6);
  fireEvent.keyDown(dom, { code: "ArrowUp", key: "ArrowUp", metaKey: true, shiftKey: true });
  expect(view.state.doc.toString()).toBe("node_modules/\ndist/\ncoverage/\n");
});

it("adds and removes mouse carets and clones the primary caret with a double Option gesture", async () => {
  renderReader({
    content: "one\ntwo\nthree",
    preferences: { ...DEFAULT_PREFERENCES, wordWrap: false },
  });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  view.focus();
  const position = vi.spyOn(view, "posAtCoords").mockReturnValue(4);
  fireEvent.mouseDown(dom, { button: 0, altKey: true, shiftKey: true });
  expect(view.state.selection.ranges.map(({ head }) => head)).toEqual([0, 4]);
  fireEvent.mouseDown(dom, { button: 0, altKey: true, shiftKey: true });
  expect(view.state.selection.ranges.map(({ head }) => head)).toEqual([0]);
  position.mockRestore();
  vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(4));
  fireEvent.keyDown(dom, { code: "AltLeft", key: "Alt", altKey: true });
  fireEvent.keyUp(dom, { code: "AltLeft", key: "Alt" });
  fireEvent.keyDown(dom, { code: "AltLeft", key: "Alt", altKey: true });
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", altKey: true });
  expect(view.state.selection.ranges.map(({ head }) => head)).toEqual([0, 4]);
  expect(view.state.selection.main.head).toBe(4);
});

it.each([true, false])(
  "keeps a single caret on a double-click in plain indentation (guides: %s)",
  async (showIndentGuides) => {
    renderReader({
      filename: "data.json",
      content: '{\n    "first": 1,\n    "second": 2\n}',
      preferences: { ...DEFAULT_PREFERENCES, showIndentGuides },
    });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    view.focus();
    const pos = view.state.doc.line(2).from + 2;
    vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
    vi.spyOn(view, "posAndSideAtCoords").mockReturnValue({ pos, assoc: 1 });
    fireEvent.mouseDown(content, { button: 0, detail: 2, clientX: 20, clientY: 35 });
    fireEvent.mouseUp(document);
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(view.state.selection.main).toMatchObject({ anchor: pos, head: pos });
    expect(content.querySelector(".cm-selectionMatch")).toBeNull();
  },
);

it("restores the viewport before resolving the first mouse selection after blur", async () => {
  renderReader({
    content: Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join("\n"),
  });
  const content = await editorContent();
  const view = EditorView.findFromDOM(content)!;
  const { scrollDOM } = view;
  view.focus();
  content.blur();
  scrollDOM.scrollTop = 400;
  scrollDOM.scrollLeft = 32;
  content.addEventListener(
    "focus",
    () => {
      scrollDOM.scrollTop = 1200;
      scrollDOM.scrollLeft = 0;
    },
    { once: true },
  );
  const anchor = view.state.doc.line(21).from + 6;
  const dragEnd = view.state.doc.line(22).from + 6;
  vi.spyOn(view, "posAndSideAtCoords").mockImplementation(({ y }) => ({
    pos: scrollDOM.scrollTop === 400 ? (y === 40 ? anchor : dragEnd) : view.state.doc.line(61).from,
    assoc: 1,
  }));

  const pointer = new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 40 });
  Object.defineProperty(pointer, "pointerType", { value: "mouse" });
  fireEvent(content, pointer);
  expect(content).toHaveFocus();
  expect(scrollDOM).toMatchObject({ scrollTop: 400, scrollLeft: 32 });
  fireEvent.mouseDown(content, { button: 0, buttons: 1, detail: 1, clientY: 40 });
  fireEvent.mouseUp(document, { button: 0, clientY: 40 });
  expect(view.state.selection.main).toMatchObject({ anchor, head: anchor });
  fireEvent.mouseDown(content, { button: 0, buttons: 1, detail: 1, clientY: 40 });
  fireEvent.mouseMove(document, { buttons: 1, clientY: 60 });
  fireEvent.mouseUp(document, { button: 0, clientY: 60 });
  expect(view.state.selection.main).toMatchObject({ anchor, head: dragEnd });
});

it("copies virtual columns and pads paste and IME input in a single undoable edit", async () => {
  const original = "\tab\nx\n";
  const user = userEvent.setup();
  renderReader({ content: original, preferences: { ...DEFAULT_PREFERENCES, tabSize: 4 } });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  view.focus();
  act(() => view.dispatch({ selection: { anchor: 3 } }));
  fireEvent.keyDown(dom, { code: "Digit8", key: "*", metaKey: true, shiftKey: true });
  expect(columnMode(view.state)).toBe(true);
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", shiftKey: true });
  fireEvent.keyDown(dom, { code: "ArrowRight", key: "ArrowRight", shiftKey: true });
  expect(selectedEditorText(view.state)).toBe(" \n ");
  expect(view.state.doc.toString()).toBe(original);
  await navigator.clipboard.writeText("Y\nZ");
  await user.paste();
  expect(view.state.doc.toString()).toBe("\tabY\nx     Z\n");
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe(original);
  expect(selectedEditorText(view.state)).toBe(" \n ");
  act(() => view.dispatch({ selection: { anchor: 3 } }));
  fireEvent.keyDown(dom, { code: "ArrowDown", key: "ArrowDown", shiftKey: true });
  act(() => view.dispatch(view.state.replaceSelection("中"), { userEvent: "input.type.compose" }));
  expect(view.state.doc.toString()).toBe("\tab中\nx     中\n");
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe(original);
});

it("tracks virtual columns during a mouse drag and keeps line endings intact on Delete", async () => {
  const original = "\tab\nx\n";
  renderReader({ content: original, preferences: { ...DEFAULT_PREFERENCES, tabSize: 4 } });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  view.focus();
  fireEvent.keyDown(dom, { code: "Digit8", key: "*", metaKey: true, shiftKey: true });
  vi.spyOn(view, "defaultCharacterWidth", "get").mockReturnValue(8);
  vi.spyOn(view, "posAtCoords").mockImplementation(({ y }) => (y < 20 ? 3 : 5));
  vi.spyOn(view, "coordsAtPos").mockImplementation((pos) =>
    pos === 3
      ? { left: 48, right: 48, top: 5, bottom: 18 }
      : { left: 8, right: 8, top: 24, bottom: 38 },
  );
  fireEvent.mouseDown(dom, { button: 0, buttons: 1, detail: 1, clientX: 48, clientY: 10 });
  fireEvent.mouseMove(document, { buttons: 1, clientX: 64, clientY: 30 });
  fireEvent.mouseUp(document, { button: 0, clientX: 64, clientY: 30 });
  expect(selectedEditorText(view.state)).toBe("  \n  ");
  fireEvent.keyDown(dom, { code: "Delete", key: "Delete" });
  expect(view.state.doc.toString()).toBe(original);
  fireEvent.keyDown(dom, { code: "Delete", key: "Delete" });
  expect(view.state.doc.toString()).toBe(original);
  fireEvent.keyDown(dom, { code: "Backspace", key: "Backspace" });
  expect(view.state.doc.toString()).toBe("\ta\nx\n");
});

it("opens the contextual menu without collapsing ranges and scopes clipboard actions to unchanged state", async () => {
  const user = userEvent.setup();
  renderReader({ content: "first second" });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  act(() =>
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(6, 12),
      ]),
    }),
  );
  vi.spyOn(view, "posAtCoords").mockReturnValue(2);
  fireEvent.contextMenu(dom, { button: 2 });
  let menu = screen.getByRole("menu", { name: "编辑器操作" });
  expect(menu).toHaveFocus();
  expect(within(menu).getByRole("menuitem", { name: "剪切" })).not.toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(within(menu).getByRole("menuitem", { name: "剪切" })).toHaveFocus();
  expect(view.state.selection.ranges).toHaveLength(2);
  await user.click(within(menu).getByRole("menuitem", { name: "复制" }));
  expect(await navigator.clipboard.readText()).toBe("first\nsecond");
  expect(view.state.selection.ranges).toHaveLength(2);
  fireEvent.keyDown(dom, { code: "KeyC", key: "C", metaKey: true, altKey: true, shiftKey: true });
  expect(await navigator.clipboard.readText()).toBe("src/a.ts:1");
  vi.spyOn(view, "posAtCoords").mockReturnValue(5);
  act(() => view.dispatch({ selection: { anchor: 6, head: 12 } }));
  fireEvent.contextMenu(dom, { button: 2 });
  menu = screen.getByRole("menu", { name: "编辑器操作" });
  expect(menu).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(within(menu).getAllByRole("menuitem").at(-1)).toHaveFocus();
  expect(view.state.selection.main.head).toBe(5);
  expect(within(menu).queryByRole("menuitem", { name: /^剪切/ })).not.toBeInTheDocument();
  const read = vi.spyOn(navigator.clipboard, "readText");
  let completePaste: (text: string) => void = () => {};
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completePaste = resolve;
      }),
  );
  fireEvent.click(within(menu).getByRole("menuitem", { name: /^粘贴/ }));
  act(() => view.dispatch({ selection: { anchor: 0 } }));
  await act(async () => completePaste("stale"));
  expect(view.state.doc.toString()).toBe("first second");
  view.focus();
  fireEvent.keyDown(dom, { code: "F10", key: "F10", shiftKey: true });
  expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "粘贴" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(dom).toHaveFocus();
});

it("leaves the document untouched when clipboard writes fail or Git locks the editor", async () => {
  const user = userEvent.setup();
  const { rerender, props } = renderReader({ content: "first second" });
  const dom = await editorContent();
  const view = EditorView.findFromDOM(dom)!;
  const onNotice = vi.fn();
  rerender(<CodeReader {...props} onNotice={onNotice} />);
  act(() => view.dispatch({ selection: { anchor: 0, head: 5 } }));
  vi.spyOn(view, "posAtCoords").mockReturnValue(2);
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
    new Error("clipboard unavailable"),
  );
  fireEvent.contextMenu(dom, { button: 2 });
  await user.click(screen.getByRole("menuitem", { name: /^剪切/ }));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("clipboard unavailable"));
  expect(view.state.doc.toString()).toBe("first second");
  rerender(<CodeReader {...props} gitLocked />);
  fireEvent.contextMenu(dom, { button: 2 });
  expect(screen.getByRole("menuitem", { name: /^剪切/ })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: /^粘贴/ })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "复制" })).toBeEnabled();
  fireEvent.keyDown(dom, { code: "Backspace", key: "Backspace", metaKey: true });
  expect(view.state.doc.toString()).toBe("first second");
});

it("keeps the bold shortcut in Markdown files instead of navigating", async () => {
  const onNavigate = vi.fn().mockReturnValue(true);
  const { ref } = renderReader({
    filename: "README.md",
    content: "word",
    onNavigate,
    preferences: {
      ...DEFAULT_PREFERENCES,
      shortcuts: { definition: /Mac/.test(navigator.platform) ? "Mod+KeyB" : "Ctrl+KeyB" },
    },
  });
  const view = await markdownEditor("word".length);
  pressMarkdownShortcut(view, "b");
  expect(ref.current!.getText()).toContain("**");
  expect(onNavigate).not.toHaveBeenCalled();
});

it("runs Markdown navigation when the shortcut does not match formatting", async () => {
  const onNavigate = vi.fn().mockReturnValue(true);
  renderReader({
    filename: "README.md",
    content: "word",
    onNavigate,
    preferences: { ...DEFAULT_PREFERENCES, shortcuts: { definition: "F8" } },
  });
  const view = await markdownEditor(0);
  fireEvent.keyDown(view.contentDOM, { code: "F8", key: "F8" });
  fireEvent.keyDown(view.contentDOM, { code: "F7", key: "F7", altKey: true });
  expect(onNavigate.mock.calls).toEqual([["definition"], ["references"]]);
});

it("rebinds file search in the editor and search panel, then clears it", async () => {
  const preferences = { ...DEFAULT_PREFERENCES, shortcuts: { find: "F8" } };
  const { props, rerender } = renderReader({ preferences });
  const view = EditorView.findFromDOM(await editorContent())!;
  view.focus();
  const searchInput = () =>
    view.dom.querySelector<HTMLInputElement>('.cm-search input[name="search"]');
  const defaultShortcut = { code: "KeyF", key: "f", metaKey: true };
  fireEvent.keyDown(view.contentDOM, defaultShortcut);
  expect(searchInput()).toBeNull();

  const shortcut = { code: "F8", key: "F8" };
  fireEvent.keyDown(view.contentDOM, shortcut);
  expect(searchInput()).toHaveFocus();
  expect(fireEvent.keyDown(searchInput()!, shortcut)).toBe(false);
  fireEvent.keyDown(searchInput()!, { key: "Escape" });
  expect(searchInput()).toBeNull();

  rerender(<CodeReader {...props} preferences={{ ...preferences, shortcuts: { find: "" } }} />);
  fireEvent.keyDown(view.contentDOM, shortcut);
  fireEvent.keyDown(view.contentDOM, defaultShortcut);
  expect(searchInput()).toBeNull();
});

it("opens the current file's problems from the icon and jumps to the chosen location", async () => {
  renderReader({ content: "const first = 1;\nconst second = 2;\n" });
  const view = EditorView.findFromDOM(await editorContent())!;
  act(() =>
    view.dispatch(
      setDiagnostics(view.state, [
        { from: 6, to: 11, severity: "error", message: "First problem" },
        { from: 23, to: 29, severity: "error", message: "Second problem" },
      ]),
    ),
  );
  const trigger = screen.getByRole("button", { name: "当前文件问题：2 个错误" });
  expect(trigger.closest(".editor-surface-wrap")).not.toBeNull();
  expect(trigger).toHaveTextContent("2");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  const panel = screen.getByRole("list", { name: "当前文件问题" });
  const second = within(panel).getByRole("button", { name: /Second problem/ });
  expect(second).toHaveTextContent("2:7");
  fireEvent.click(second);
  expect(view.state.selection.main.from).toBe(23);
  expect(screen.queryByRole("list", { name: "当前文件问题" })).toBeNull();
  expect(view.contentDOM).toHaveFocus();
  fireEvent.keyDown(view.contentDOM, { key: "F2" });
  expect(view.state.selection.main.from).toBe(6);
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  act(() => view.dispatch(setDiagnostics(view.state, [])));
  expect(screen.queryByRole("button", { name: /当前文件问题/ })).toBeNull();
});

async function markdownEditor(anchor: number) {
  const view = EditorView.findFromDOM(await editorContent())!;
  await waitFor(() => expect(syntaxTree(view.state).topNode.name).toBe("Document"));
  act(() => {
    view.dispatch({ selection: { anchor } });
    view.focus();
  });
  return view;
}

function typeInEditor(view: EditorView, text: string) {
  act(() => view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.type" }));
}

function pressMarkdownShortcut(view: EditorView, key: string) {
  fireEvent.keyDown(view.contentDOM, {
    key,
    metaKey: /Mac/.test(navigator.platform),
    ctrlKey: !/Mac/.test(navigator.platform),
  });
}

describe("CodeReader editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.writeFile.mockResolvedValue({
      fingerprint: { size: 20, modifiedNs: "2" },
      size: 20,
    });
  });

  it("updates indent guide visibility on the existing normal editor", async () => {
    const { props, rerender } = renderReader({ content: "root\n    body\n        child" });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    expect(view.dom.querySelector(".cm-indent-guides")).toBeInTheDocument();

    rerender(
      <CodeReader {...props} preferences={{ ...DEFAULT_PREFERENCES, showIndentGuides: false }} />,
    );
    expect(view.dom.querySelector(".cm-indent-guides")).not.toBeInTheDocument();
    expect(await editorContent()).toBe(content);

    rerender(<CodeReader {...props} preferences={DEFAULT_PREFERENCES} />);
    expect(view.dom.querySelector(".cm-indent-guides")).toBeInTheDocument();
  });

  it.each([
    ["a.ts", "(", ")"],
    ["a.ts", "{", "}"],
    ["a.ts", "'", "'"],
    ["notes.md", "[", "]"],
    ["notes.md", '"', '"'],
  ])("auto-closes %s input %s with %s", async (filename, open, close) => {
    renderReader({ filename, content: "" });
    const view = EditorView.findFromDOM(await editorContent())!;
    await waitFor(() => expect(syntaxTree(view.state).topNode.name).not.toBe(""));
    const type = (character: string) => {
      const { from, to } = view.state.selection.main;
      act(() => {
        const handled = view.state
          .facet(EditorView.inputHandler)
          .some((handler) =>
            handler(view, from, to, character, () =>
              view.state.update(view.state.replaceSelection(character)),
            ),
          );
        expect(handled).toBe(true);
      });
    };

    type(open);
    expect(view.state.doc.toString()).toBe(open + close);
    expect(view.state.selection.main.head).toBe(1);
    type(close);
    expect(view.state.doc.toString()).toBe(open + close);
    expect(view.state.selection.main.head).toBe(2);

    act(() => view.dispatch({ selection: { anchor: 1 } }));
    fireEvent.keyDown(view.contentDOM, { key: "Backspace" });
    expect(view.state.doc.toString()).toBe("");
  });

  it.each([136, 612])(
    "keeps tooltips inside the editor viewport near vertical position %s",
    async (top) => {
      renderReader();
      const content = await editorContent();
      const view = EditorView.findFromDOM(content)!;
      const viewport = new DOMRect(240, 128, 740, 512);
      vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(viewport);
      vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(viewport);
      vi.spyOn(view, "inView", "get").mockReturnValue(true);
      vi.spyOn(view, "coordsAtPos").mockReturnValue({
        left: 970,
        right: 978,
        top,
        bottom: top + 20,
      });
      vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
      vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
      const dom = document.createElement("div");
      dom.textContent = "function findUser(id: number): User";
      vi.spyOn(dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
      act(() =>
        view.dispatch({
          effects: StateEffect.appendConfig.of(
            showTooltip.of({ pos: 0, above: true, create: () => ({ dom }) }),
          ),
        }),
      );
      await waitFor(() =>
        expect(dom).toHaveClass(top === 136 ? "cm-tooltip-below" : "cm-tooltip-above"),
      );
      const absolute = dom.style.position === "absolute";
      const tooltipTop = parseFloat(dom.style.top) + (absolute ? viewport.top : 0);
      const tooltipLeft = parseFloat(dom.style.left) + (absolute ? viewport.left : 0);
      expect(tooltipTop).toBeGreaterThanOrEqual(viewport.top);
      expect(tooltipTop + 100).toBeLessThanOrEqual(viewport.bottom);
      expect(tooltipLeft).toBeGreaterThanOrEqual(viewport.left);
      expect(tooltipLeft + 200).toBeLessThanOrEqual(viewport.right);
    },
  );

  it.each(["Mac", "Windows"])(
    "jumps from a %s modifier-click using the clicked UTF-16 position",
    async (platform) => {
      const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
      try {
        const onGoToDefinition = vi.fn();
        const { ref, onDirtyChange } = renderReader({
          content: "/* 😀 */ findUser(1)",
          onGoToDefinition,
        });
        const content = await editorContent();
        const view = EditorView.findFromDOM(content)!;
        await waitFor(() => expect(syntaxTree(view.state).toString()).toContain("VariableName"));
        vi.spyOn(view, "posAtCoords").mockReturnValue(11);
        const modifiers = { metaKey: platform === "Mac", ctrlKey: platform !== "Mac" };
        fireEvent.mouseMove(content.querySelector(".cm-line")!, modifiers);
        await waitFor(() =>
          expect(content.querySelector(".cm-definition-link")).toHaveTextContent("findUser"),
        );
        fireEvent.keyUp(window, { key: platform === "Mac" ? "Meta" : "Control" });
        expect(content.querySelector(".cm-definition-link")).toBeNull();
        // Pressing the modifier while the pointer is stationary also reveals the link.
        fireEvent.keyDown(window, { key: platform === "Mac" ? "Meta" : "Control", ...modifiers });
        await waitFor(() =>
          expect(content.querySelector(".cm-definition-link")).toHaveTextContent("findUser"),
        );
        fireEvent.mouseDown(content.querySelector(".cm-line")!, {
          button: 0,
          metaKey: platform === "Mac",
          ctrlKey: platform !== "Mac",
        });
        await waitFor(() =>
          expect(onGoToDefinition).toHaveBeenCalledWith(
            { line: 0, character: 11 },
            expect.objectContaining({ source: "lsp" }),
          ),
        );
        expect(ref.current!.getCursor()).toEqual({ line: 0, character: 11 });
        expect(onDirtyChange).not.toHaveBeenCalledWith(true);
      } finally {
        agent.mockRestore();
      }
    },
  );

  it("clears link feedback on leaving, blur and edits, and removes its key listeners on unmount", async () => {
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mac");
    try {
      const { unmount } = renderReader({ content: "findUser(1)", onGoToDefinition: vi.fn() });
      const content = await editorContent();
      const view = EditorView.findFromDOM(content)!;
      await waitFor(() => expect(syntaxTree(view.state).toString()).toContain("VariableName"));
      const position = vi.spyOn(view, "posAtCoords").mockReturnValue(3);
      const hover = () => fireEvent.mouseMove(content, { metaKey: true });
      hover();
      await waitFor(() =>
        expect(content.querySelector(".cm-definition-link")).toHaveTextContent("findUser"),
      );
      fireEvent.mouseLeave(content);
      expect(content.querySelector(".cm-definition-link")).toBeNull();
      hover();
      await waitFor(() => expect(content.querySelector(".cm-definition-link")).not.toBeNull());
      fireEvent.blur(window);
      expect(content.querySelector(".cm-definition-link")).toBeNull();
      hover();
      await waitFor(() => expect(content.querySelector(".cm-definition-link")).not.toBeNull());
      act(() => view.dispatch({ changes: { from: 0, insert: "x" } }));
      expect(content.querySelector(".cm-definition-link")).toBeNull();
      position.mockReturnValue(null);
      hover();
      expect(content.querySelector(".cm-definition-link")).toBeNull();
      position.mockReturnValue(3);
      hover();
      const dispatch = vi.spyOn(view, "dispatch");
      unmount();
      dispatch.mockClear();
      fireEvent.keyUp(window, { key: "Meta" });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      agent.mockRestore();
    }
  });

  it("reveals an external UTF-8 range after multibyte characters", async () => {
    const { ref } = renderReader({ content: "😀 定义" });
    const view = EditorView.findFromDOM(await editorContent())!;
    act(() =>
      ref.current!.reveal({
        line: 0,
        character: 5,
        endLine: 0,
        endCharacter: 11,
        encoding: "utf-8",
        nonce: 1,
      }),
    );
    const { from, to } = view.state.selection.main;
    expect(view.state.doc.sliceString(from, to)).toBe("定义");
  });

  it("ignores non-code targets and locked editors, and uses the latest navigation callback", async () => {
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows");
    try {
      const first = vi.fn(),
        second = vi.fn();
      const { ref, props, rerender } = renderReader({
        content: "findUser(1)",
        onGoToDefinition: first,
      });
      const content = await editorContent();
      const view = EditorView.findFromDOM(content)!;
      await waitFor(() => expect(syntaxTree(view.state).toString()).toContain("VariableName"));
      vi.spyOn(view, "posAtCoords").mockReturnValue(3);
      const click = (target: HTMLElement = content) =>
        fireEvent.mouseDown(target, { button: 0, ctrlKey: true });
      click(view.dom.querySelector<HTMLElement>(".cm-gutters")!);
      expect(first).not.toHaveBeenCalled();
      rerender(<CodeReader {...props} onGoToDefinition={second} />);
      click();
      expect(first).not.toHaveBeenCalled();
      await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
      expect(EditorView.findFromDOM(content)).toBe(view);
      fireEvent.mouseMove(content, { ctrlKey: true });
      await waitFor(() => expect(content.querySelector(".cm-definition-link")).not.toBeNull());
      await act(async () => {
        await ref.current!.prepareFileOperation();
      });
      expect(content.querySelector(".cm-definition-link")).toBeNull();
      click();
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      agent.mockRestore();
    }
  });

  it("accepts an LSP completion with Tab before the indentation binding", async () => {
    apiMock.completeCode.mockResolvedValue({
      items: [
        {
          label: "helloFromServer",
          detail: null,
          documentation: null,
          kind: 6,
          filterText: null,
          insertText: "helloFromServer",
          edit: null,
          additionalEdits: [],
        },
      ],
    });
    const { ref } = renderReader({
      content: "hel",
      filename: "a.py",
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false, indentWithTab: true },
    });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    act(() => {
      view.dispatch({ selection: { anchor: 3 } });
      view.focus();
      startCompletion(view);
    });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /helloFromServer/ })).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.keyDown(content, { key: "Tab", code: "Tab" });
    });
    expect(ref.current?.getText()).toBe("helloFromServer");
    expect(ref.current?.isDirty()).toBe(true);
  });

  it.each([true, false])("enables rainbow brackets when editable is %s", async (editable) => {
    renderReader({ content: "const data = call([1]);", editable });
    await waitFor(() => {
      expect(document.querySelectorAll('[class*="cm-rainbow-bracket-"]')).toHaveLength(4);
    });
  });

  it.each([
    ["ordinary statement", "function Demo() {\n  const first = 1;|", "\n  "],
    [
      "finished callback",
      "function Demo() {\n  useEffect(() => {\n    reset();\n  }, []);|",
      "\n  ",
    ],
    ["condition body", "function Demo() {\n  if (ready) {|", "\n    "],
    ["open parentheses", "function Demo() {\n  call(|", "\n    "],
    ["statement in a condition", "function Demo() {\n  if (ready) {\n    reset();|", "\n    "],
    ["finished condition", "function Demo() {\n  if (ready) {\n    reset();\n  }|", "\n  "],
    ["matching braces", "function Demo() {\n  if (ready) {|}", "\n    \n  "],
    ["tab-indented statement", "function Demo() {\n\tconst first = 1;|", "\n\t"],
  ])("indents Enter correctly after %s", async (_name, marked, inserted) => {
    const cursor = marked.indexOf("|");
    const doc = marked.replace("|", "");
    const { ref } = renderReader({
      content: doc,
      filename: "a.tsx",
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
    });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    await waitFor(() => expect(syntaxTree(view.state).length).toBe(doc.length));
    act(() => {
      view.dispatch({ selection: { anchor: cursor } });
      fireEvent.keyDown(content, { key: "Enter", code: "Enter" });
    });
    expect(ref.current!.getText()).toBe(doc.slice(0, cursor) + inserted + doc.slice(cursor));
    const secondBreak = inserted.indexOf("\n", 1);
    expect(view.state.selection.main.head).toBe(
      cursor + (secondBreak < 0 ? inserted.length : secondBreak),
    );
  });

  it.each([
    { editable: true, entry: "menu" },
    { editable: false, entry: "menu" },
    { editable: true, entry: "keyboard" },
    { editable: false, entry: "keyboard" },
  ])("focuses file search via $entry when editable is $editable", async ({ editable, entry }) => {
    const user = userEvent.setup();
    const { ref, container } = renderReader({ editable });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    const openSearch = () => {
      act(() => view.focus());
      if (entry === "menu") act(() => ref.current!.openFileSearch());
      else fireEvent.keyDown(content, { key: "f", code: "KeyF", metaKey: true });
    };
    openSearch();
    const search = screen.getByRole("textbox", { name: "查找" });
    expect(search).toHaveFocus();
    await user.type(search, "value");
    expect(search).toHaveValue("value");
    expect(ref.current!.getText()).toBe("const value = 1;\n");
    expect(screen.queryByRole("textbox", { name: "替换" }) !== null).toBe(editable);
    expect(screen.queryByRole("button", { name: "全部替换" }) !== null).toBe(editable);
    openSearch();
    expect(search).toHaveFocus();
    expect(container.querySelectorAll(".cm-search")).toHaveLength(1);
  });

  it("restores the initial selection and scroll position without focusing the editor", async () => {
    const { ref } = renderReader({
      content: "first\nsecond\nthird\n",
      initialView: { line: 1, character: 3, scrollTop: 42 },
    });
    const content = await editorContent();
    expect(ref.current!.getViewState()).toEqual({ line: 1, character: 3, scrollTop: 42 });
    expect(content).not.toHaveFocus();
  });

  it("loads Git base only while active and refreshes it on reactivation", async () => {
    const { props, rerender } = renderReader({ active: false });
    await editorContent();
    expect(gitApiMock.getFileBase).not.toHaveBeenCalled();
    expect(gitApiMock.onRepositoryChange).not.toHaveBeenCalled();

    rerender(<CodeReader {...props} active />);
    await waitFor(() => expect(gitApiMock.getFileBase).toHaveBeenCalledTimes(1));
    expect(gitApiMock.onRepositoryChange).toHaveBeenCalledTimes(1);
    rerender(<CodeReader {...props} active={false} />);
    rerender(<CodeReader {...props} active />);
    await waitFor(() => expect(gitApiMock.getFileBase).toHaveBeenCalledTimes(2));
  });

  it("only requests AI from the active editor and cancels on tab changes", async () => {
    const { props, rerender } = renderReader({
      active: false,
      content: "const value = ",
      preferences: { ...DEFAULT_PREFERENCES, aiCompletionEnabled: true },
    });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    const manual = () =>
      fireEvent.keyDown(content, { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true });
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      manual();
    });
    expect(apiMock.requestAiCompletion).not.toHaveBeenCalled();

    let respond!: (value: { type: "suggestion"; text: string }) => void;
    apiMock.requestAiCompletion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    rerender(<CodeReader {...props} active />);
    act(() => manual());
    // The request waits briefly for the document to reach the language server.
    await waitFor(() => expect(apiMock.requestAiCompletion).toHaveBeenCalledTimes(1));
    const request = apiMock.requestAiCompletion.mock.calls[0]![0];
    expect(request).toMatchObject({ manual: true, prefix: "const value = " });
    rerender(<CodeReader {...props} active={false} />);
    expect(apiMock.cancelAiCompletion).toHaveBeenCalledWith(request.id);
    await act(async () => respond({ type: "suggestion", text: "42" }));
    expect(view.dom.querySelector(".cm-gaze-ai-suggestion")).toBeNull();
    expect(view.state.doc.toString()).toBe("const value = ");
  });

  it("previews unsaved Markdown without rebuilding the editor or losing undo and selection", async () => {
    const user = userEvent.setup();
    const { ref } = renderReader({
      filename: "README.MD",
      content: "# Original\n",
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
    });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute("aria-pressed", "true");
    act(() =>
      view.dispatch({ changes: { from: 0, insert: "# Draft\n\n" }, selection: { anchor: 3 } }),
    );
    view.scrollDOM.scrollTop = 30;
    await user.click(screen.getByRole("button", { name: "预览" }));
    expect(
      await screen.findByRole("heading", { name: "Draft" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(content.closest(".editor-surface-wrap")).toHaveAttribute("hidden");
    expect(ref.current!.isDirty()).toBe(true);
    await user.click(screen.getByRole("button", { name: "源码" }));
    expect(EditorView.findFromDOM(content)).toBe(view);
    expect(view.state.selection.main.anchor).toBe(3);
    expect(view.scrollDOM.scrollTop).toBe(30);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(ref.current!.getText()).toBe("# Original\n");
    await user.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByRole("heading", { name: "Original" })).toBeInTheDocument();
    act(() => ref.current!.openFileSearch());
    expect(content.closest(".editor-surface-wrap")).not.toHaveAttribute("hidden");
    expect(document.querySelector(".cm-search")).not.toBeNull();
  });

  it("opens Markdown insert commands on slash and undoes a keyboard insertion independently", async () => {
    const { ref } = renderReader({ filename: "README.MD", content: "" });
    const view = await markdownEditor(0);
    await userEvent.setup().keyboard("/");
    const heading = await screen.findByRole("option", { name: /标题 2.*\/h2/ });
    expect(apiMock.completeCode).not.toHaveBeenCalled();
    fireEvent.keyDown(view.contentDOM, { key: "ArrowDown" });
    expect(heading).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    expect(ref.current!.getText()).toBe("## ");
    expect(view.state.selection.main.head).toBe(3);
    expect(ref.current!.isDirty()).toBe(true);
    act(() => expect(undo(view)).toBe(true));
    expect(ref.current!.getText()).toBe("/");
  });

  it("completes Markdown directories in sequence and preserves the link fragment", async () => {
    apiMock.completePaths
      .mockResolvedValueOnce([{ name: "config", isDirectory: true }])
      .mockResolvedValueOnce([{ name: "配置 #1(草稿).md", isDirectory: false }]);
    const { ref } = renderReader({
      filename: "docs/guide.md",
      content: "[配置](../#details)",
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
      withPlugins: true,
    });
    const view = await markdownEditor("[配置](../".length);
    typeInEditor(view, "conf");
    await screen.findByRole("option", { name: "config/" });
    expect(apiMock.completePaths).toHaveBeenNthCalledWith(
      1,
      "p1",
      "docs/guide.md",
      "../",
      "conf",
      false,
    );
    expect(apiMock.completeCode).not.toHaveBeenCalled();
    fireEvent.keyDown(view.contentDOM, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(ref.current!.getText()).toBe("[配置](../conf#details)");
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    await screen.findByRole("option", { name: "配置 #1(草稿).md" });
    expect(apiMock.completePaths).toHaveBeenNthCalledWith(
      2,
      "p1",
      "docs/guide.md",
      "../config/",
      "",
      false,
    );
    fireEvent.keyDown(view.contentDOM, { key: "Tab" });
    expect(ref.current!.getText()).toBe(
      "[配置](../config/%E9%85%8D%E7%BD%AE%20%231%28%E8%8D%89%E7%A8%BF%29.md#details)",
    );
    act(() => expect(undo(view)).toBe(true));
    expect(ref.current!.getText()).toBe("[配置](../config/#details)");
    act(() => expect(undo(view)).toBe(true));
    expect(ref.current!.getText()).toBe("[配置](../conf#details)");
  });

  it.each([
    ["notes.md", "![图](/ima", "Document", "/", "ima"],
    ["notes.md", "[图](", "Document", "", ""],
    ["notes.md", "[图](ima", "Document", "", "ima"],
    ["a.ts", 'const file = "./ima', "Script", "./", "ima"],
    ["config.json", '{"file": "./ima', "JsonText", "./", "ima"],
    ["config.yaml", 'file: "./ima', "Stream", "./", "ima"],
  ])(
    "finds paths in incomplete %s input %s",
    async (filename, content, syntax, directory, prefix) => {
      apiMock.completePaths.mockResolvedValue([{ name: "image.png", isDirectory: false }]);
      const { ref } = renderReader({ filename, content });
      const view = EditorView.findFromDOM(await editorContent())!;
      await waitFor(() => expect(syntaxTree(view.state).topNode.name).toBe(syntax));
      act(() => {
        view.dispatch({ selection: { anchor: content.length } });
        view.focus();
        startCompletion(view);
      });
      fireEvent.mouseDown(await screen.findByRole("option", { name: "image.png" }));
      expect(apiMock.completePaths).toHaveBeenCalledWith("p1", filename, directory, prefix, false);
      expect(ref.current!.getText()).toBe(
        content.slice(0, content.length - prefix.length) + "image.png",
      );
    },
  );

  it("drops pending path matches on cursor movement and disables completion without rebuilding", async () => {
    let respond!: (entries: { name: string; isDirectory: boolean }[]) => void;
    apiMock.completePaths.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const content = "[配置](../conf)";
    const { props, rerender } = renderReader({ filename: "guide.md", content });
    const view = await markdownEditor(content.length - 1);
    act(() => startCompletion(view));
    await waitFor(() => expect(apiMock.completePaths).toHaveBeenCalledOnce());
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    await act(async () => respond([{ name: "config", isDirectory: true }]));
    expect(currentCompletions(view.state)).toHaveLength(0);

    act(() => view.dispatch({ selection: { anchor: content.length - 1 } }));
    apiMock.completePaths.mockResolvedValue([{ name: "config", isDirectory: true }]);
    act(() => startCompletion(view));
    await screen.findByRole("option", { name: "config/" });
    rerender(
      <CodeReader
        {...props}
        preferences={{ ...DEFAULT_PREFERENCES, pathCompletionEnabled: false }}
      />,
    );
    expect(EditorView.findFromDOM(await editorContent())).toBe(view);
    expect(currentCompletions(view.state)).toHaveLength(0);
    act(() => startCompletion(view));
    await waitFor(() => expect(apiMock.completeCode).toHaveBeenCalled());
    expect(apiMock.completePaths).toHaveBeenCalledTimes(2);
  });

  it("only replaces the current directory segment in a quoted path", async () => {
    const content = 'const file = "./ass-typo/old.png";';
    apiMock.completePaths.mockResolvedValueOnce([{ name: "assets", isDirectory: true }]);
    const { ref } = renderReader({ content });
    const view = EditorView.findFromDOM(await editorContent())!;
    await waitFor(() => expect(syntaxTree(view.state).topNode.name).toBe("Script"));
    act(() => {
      view.dispatch({ selection: { anchor: content.indexOf("-typo") } });
      view.focus();
      startCompletion(view);
    });
    await screen.findByRole("option", { name: "assets/" });
    expect(apiMock.completePaths).toHaveBeenNthCalledWith(1, "p1", "src/a.ts", "./", "ass", true);
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    expect(ref.current!.getText()).toBe('const file = "./assets/old.png";');
    await waitFor(() => expect(apiMock.completePaths).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["a.ts", 'import "./assets|";', "Script"],
    ["a.ts", 'const url = "https://site.example/a|";', "Script"],
    ["notes.md", "`[text](./example|)`", "Document"],
  ])("keeps ordinary completions in %s at %s", async (filename, marked, syntax) => {
    renderReader({ filename, content: marked.replace("|", "") });
    const view = EditorView.findFromDOM(await editorContent())!;
    await waitFor(() => expect(syntaxTree(view.state).topNode.name).toBe(syntax));
    act(() => {
      view.dispatch({ selection: { anchor: marked.indexOf("|") } });
      view.focus();
      startCompletion(view);
    });
    await waitFor(() => expect(apiMock.completeCode).toHaveBeenCalled());
    expect(apiMock.completePaths).not.toHaveBeenCalled();
  });

  it("hot toggles Markdown quick insert without recreating the editor or losing undo", async () => {
    const { ref, props, rerender } = renderReader({ filename: "guide.md", content: "text" });
    const view = await markdownEditor(0);
    act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));
    pressMarkdownShortcut(view, "b");
    expect(ref.current!.getText()).toBe("**text**");

    rerender(
      <CodeReader
        {...props}
        preferences={{ ...DEFAULT_PREFERENCES, markdownInsertEnabled: false }}
      />,
    );
    expect(EditorView.findFromDOM(await editorContent())).toBe(view);
    pressMarkdownShortcut(view, "i");
    expect(ref.current!.getText()).toBe("**text**");
    act(() => expect(undo(view)).toBe(true));
    expect(ref.current!.getText()).toBe("text");

    rerender(<CodeReader {...props} />);
    act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));
    pressMarkdownShortcut(view, "i");
    expect(ref.current!.getText()).toBe("*text*");
  });

  it("filters in either language and limits commands after prose to inline templates", async () => {
    setLanguage("en");
    try {
      const { ref } = renderReader({ filename: "guide.md", content: "See  below" });
      const view = await markdownEditor(4);
      typeInEditor(view, "/");
      await screen.findByRole("option", { name: /Insert link.*\/link/ });
      expect(screen.getAllByRole("option")).toHaveLength(2);
      typeInEditor(view, "图片");
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
      fireEvent.mouseDown(screen.getByRole("option", { name: /Insert image.*\/image/ }));
      expect(ref.current!.getText()).toBe("See ![]() below");
      expect(view.state.selection.main.head).toBe("See ![](".length);

      act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
      typeInEditor(view, "\n");
      typeInEditor(view, "/table");
      await screen.findByRole("option", { name: /Table.*\/table/ });
      fireEvent.keyDown(view.contentDOM, { key: "Escape" });
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(ref.current!.getText()).toBe("See ![]() below\n/table");
    } finally {
      setLanguage("zh-CN");
    }
  });

  it("uses Markdown and preserves neighboring paragraphs when inserting previewable blocks", async () => {
    const user = userEvent.setup();
    const { ref, container } = renderReader({
      filename: "guide.md",
      content: "Before\n\nAfter",
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
    });
    const view = await markdownEditor("Before\n".length);
    typeInEditor(view, "/表格");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /表格.*\/table/ }));
    let { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe("A");
    expect(ref.current!.getText()).toBe("Before\n\n| A | B |\n| --- | --- |\n|  |  |\n\nAfter");

    for (const [command, label, field] of [
      ["/math", /块级公式/, "x^2"],
      ["/mermaid", /Mermaid 图表/, "A --> B"],
    ] as const) {
      act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
      typeInEditor(view, "\n");
      typeInEditor(view, command);
      await screen.findByRole("option", { name: label });
      fireEvent.keyDown(view.contentDOM, { key: "Enter" });
      ({ from, to } = view.state.selection.main);
      expect(view.state.sliceDoc(from, to)).toBe(field);
    }

    // jsdom does not measure SVG geometry.
    Object.assign(SVGElement.prototype, {
      getBBox: () => new DOMRect(0, 0, 100, 16),
      getComputedTextLength: () => 100,
    });
    try {
      await user.click(screen.getByRole("button", { name: "预览" }));
      expect(await screen.findByRole("table")).toBeInTheDocument();
      await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
      const preview = screen.getByRole("region", { name: "Markdown 预览" });
      expect(within(preview).getByText("After")).toBeInTheDocument();
      const diagram = await within(preview).findByRole(
        "figure",
        { name: "Mermaid 图表" },
        { timeout: 3000 },
      );
      expect(diagram.querySelector("svg")).not.toBeNull();
    } finally {
      Reflect.deleteProperty(SVGElement.prototype, "getBBox");
      Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
    }
  });

  it.each([
    ["https://example.test", "", "/image"],
    ["", "/bin", "/image"],
    ["`one ", " `", "/image"],
    ["```ts\n", "\n```", "/table"],
    ["    ", "", "/image"],
  ])("keeps a slash literal between %j and %j", async (before, after, command) => {
    const { ref } = renderReader({ filename: "guide.md", content: before + after });
    const view = await markdownEditor(before.length);
    typeInEditor(view, command);
    act(() => startCompletion(view));
    await waitFor(() => expect(completionStatus(view.state)).not.toBe("pending"));
    expect(currentCompletions(view.state).some((item) => item.detail === command)).toBe(false);
    expect(ref.current!.getText()).toBe(before + command + after);
  });

  it("lets the input method finish composing a slash query before showing candidates", async () => {
    const { ref } = renderReader({ filename: "guide.md", content: "" });
    const view = await markdownEditor(0);
    typeInEditor(view, "/");
    await screen.findByRole("option", { name: /表格/ });
    fireEvent.compositionStart(view.contentDOM);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    typeInEditor(view, "表格");
    expect(
      fireEvent.keyDown(view.contentDOM, { key: "Enter", keyCode: 229, isComposing: true }),
    ).toBe(true);
    pressMarkdownShortcut(view, "b");
    expect(ref.current!.getText()).toBe("/表格");
    fireEvent.compositionEnd(view.contentDOM, { data: "表格" });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /表格/ }));
    expect(ref.current!.getText()).toMatch(/^\| A \| B \|/);
  });

  it.each([
    ["b", true, "**word**", 2, 6],
    ["i", true, "*word*", 1, 5],
    ["k", true, "[word]()", 7, 7],
    ["b", false, "****word", 2, 2],
    ["i", false, "**word", 1, 1],
    ["k", false, "[]()word", 1, 1],
  ] as const)("accepts Mod-%s with selection=%s", async (key, selected, text, from, to) => {
    const { ref } = renderReader({ filename: "guide.md", content: "word" });
    const view = await markdownEditor(0);
    if (selected) act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));
    pressMarkdownShortcut(view, key);
    expect(ref.current!.getText()).toBe(text);
    expect(view.state.selection.main).toMatchObject({ from, to });
    act(() => expect(undo(view)).toBe(true));
    expect(ref.current!.getText()).toBe("word");
  });

  it.each([
    ["guide.md", false],
    ["script.ts", true],
  ] as const)(
    "does not offer Markdown insertion for %s with editable=%s",
    async (filename, editable) => {
      const { ref } = renderReader({ filename, editable, content: "/h2" });
      const view = EditorView.findFromDOM(await editorContent())!;
      act(() => {
        view.dispatch({ selection: { anchor: 3 } });
        view.focus();
        startCompletion(view);
      });
      await waitFor(() => expect(completionStatus(view.state)).not.toBe("pending"));
      expect(currentCompletions(view.state).some((item) => item.detail === "/h2")).toBe(false);
      pressMarkdownShortcut(view, "b");
      expect(ref.current!.getText()).toBe("/h2");
    },
  );

  it("closes Markdown insertion and blocks shortcuts when a file operation locks the editor", async () => {
    const { ref } = renderReader({ filename: "guide.md", content: "/h2" });
    const view = await markdownEditor(3);
    act(() => startCompletion(view));
    await screen.findByRole("option", { name: /标题 2/ });
    await act(() => ref.current!.prepareFileOperation({ save: false }));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    pressMarkdownShortcut(view, "k");
    expect(ref.current!.getText()).toBe("/h2");
  });

  it("updates editor preferences without losing edits and cancels pending auto-save", async () => {
    const { props, rerender, ref } = renderReader();
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    expect(screen.getByRole("slider", { name: "内容缩略图" })).toBeInTheDocument();
    vi.useFakeTimers();
    try {
      act(() =>
        view.dispatch({ changes: { from: 0, insert: "// draft\n" }, selection: { anchor: 3 } }),
      );
      rerender(
        <CodeReader
          {...props}
          preferences={{
            ...DEFAULT_PREFERENCES,
            autoSave: false,
            wordWrap: false,
            lineNumbers: false,
            showMinimap: false,
            tabSize: 2,
            editorFontSize: 17,
          }}
        />,
      );
      expect(EditorView.findFromDOM(content)).toBe(view);
      expect(view.state.selection.main.anchor).toBe(3);
      expect(view.state.facet(EditorState.tabSize)).toBe(2);
      expect(content).not.toHaveClass("cm-lineWrapping");
      expect(document.querySelector(".cm-lineNumbers")).toBeNull();
      expect(screen.queryByRole("slider", { name: "内容缩略图" })).not.toBeInTheDocument();
      expect(ref.current!.getText()).toContain("// draft");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(apiMock.writeFile).not.toHaveBeenCalled();
      rerender(
        <CodeReader {...props} preferences={{ ...DEFAULT_PREFERENCES, autoSaveDelay: 300 }} />,
      );
      expect(screen.getByRole("slider", { name: "内容缩略图" })).toBeInTheDocument();
      expect(EditorView.findFromDOM(content)).toBe(view);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(apiMock.writeFile).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(apiMock.writeFile).toHaveBeenCalledOnce();
      act(() => {
        expect(undo(view)).toBe(true);
      });
      expect(ref.current!.getText()).toBe("const value = 1;\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues auto-saving while Markdown preview is visible", async () => {
    const user = userEvent.setup();
    const { ref } = renderReader({ filename: "README.md", content: "# Guide\n" });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    act(() => view.dispatch({ changes: { from: 0, insert: "# Draft\n\n" } }));
    await user.click(screen.getByRole("button", { name: "预览" }));
    expect(
      await screen.findByRole("heading", { name: "Draft" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(apiMock.writeFile).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(apiMock.writeFile.mock.calls[0]?.[2]).toBe("# Draft\n\n# Guide\n");
    await waitFor(() => expect(ref.current!.isDirty()).toBe(false));
  });

  it("refreshes a preview from disk and switches to source for navigation", async () => {
    const user = userEvent.setup();
    const { props, rerender, ref } = renderReader({ filename: "README.md", content: "# First\n" });
    await editorContent();
    await user.click(screen.getByRole("button", { name: "预览" }));
    expect(await screen.findByRole("heading", { name: "First" })).toBeInTheDocument();
    apiMock.readFile.mockResolvedValue(textFile("# Updated\n"));
    rerender(<CodeReader {...props} reloadToken={1} />);
    expect(await screen.findByRole("heading", { name: "Updated" })).toBeInTheDocument();
    rerender(
      <CodeReader
        {...props}
        reloadToken={1}
        reveal={{ line: 0, character: 2, endLine: 0, endCharacter: 2, nonce: 1 }}
      />,
    );
    expect(screen.queryByRole("region", { name: "Markdown 预览" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "预览" }));
    act(() =>
      ref.current!.reveal({ line: 0, character: 0, endLine: 0, endCharacter: 0, nonce: 2 }),
    );
    expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens Markdown navigation requests in preview without overriding later mode choices", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderReader({ filename: "guide.md", content: "# Guide\n" });
    await editorContent();
    const request = { fragment: "guide", nonce: 1 };
    rerender(<CodeReader {...props} previewRequest={request} />);
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "源码" }));
    rerender(<CodeReader {...props} active={false} previewRequest={request} />);
    rerender(<CodeReader {...props} active previewRequest={request} />);
    expect(screen.getByRole("button", { name: "源码" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Markdown view modes independent and resets a closed file to source", async () => {
    const user = userEvent.setup();
    const first = renderReader({ filename: "one.md", content: "# One\n" });
    await waitFor(() => expect(first.container.querySelector(".cm-content")).not.toBeNull());
    await user.click(within(first.container).getByRole("button", { name: "预览" }));
    expect(
      await within(first.container).findByRole("heading", { name: "One" }),
    ).toBeInTheDocument();
    const second = renderReader({ filename: "two.md", content: "# Two\n" });
    expect(await within(second.container).findByRole("button", { name: "源码" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(first.container).getByRole("button", { name: "预览" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    first.unmount();
    const reopened = renderReader({ filename: "one.md", content: "# One\n" });
    expect(await within(reopened.container).findByRole("button", { name: "源码" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it.each(["large", "longLine"] as const)(
    "keeps %s Markdown in source mode without preview or indent guides",
    async (mode) => {
      renderReader({ filename: "large.md", mode, editable: false });
      const view = EditorView.findFromDOM(await editorContent())!;
      expect(view.dom.querySelector(".cm-indent-guides")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "预览" })).toBeDisabled();
      expect(screen.getByText("大文件或超长行文件仅支持源码阅读")).toBeInTheDocument();
    },
  );

  it("does not offer Markdown preview for other files", async () => {
    renderReader();
    await editorContent();
    expect(screen.queryByRole("button", { name: "预览" })).not.toBeInTheDocument();
  });

  it("centers graphic fold markers and keeps folding and unfolding available", async () => {
    renderReader({ content: "function example() {\n  return 1;\n}\n" });
    const view = EditorView.findFromDOM(await editorContent())!;
    const gutters = Array.from(view.dom.querySelectorAll(".cm-gutters-before > .cm-gutter"));
    const order = ["cm-lineNumbers", "cm-foldGutter", "cm-git-changes"].map((className) =>
      gutters.findIndex((gutter) => gutter.classList.contains(className)),
    );
    expect(order).toEqual([0, 1, 2]);
    const marker = await screen.findByLabelText("折叠代码");
    const style = window.getComputedStyle(marker);
    expect(style.display).toBe("inline-flex");
    expect(style.alignItems).toBe("center");
    expect(style.justifyContent).toBe("center");
    expect(parseFloat(style.height)).toBeCloseTo(parseFloat(style.fontSize) * 1.65);
    expect(marker.querySelector("svg")).toHaveAttribute("viewBox", "0 0 12 12");
    expect(marker.querySelector("path")).toHaveAttribute("d", "m3 4.5 3 3 3-3");

    fireEvent.click(marker);
    await waitFor(() => expect(document.querySelector(".cm-foldPlaceholder")).not.toBeNull());
    const closedMarker = screen
      .getAllByLabelText("展开代码")
      .find((element) => element.parentElement?.style.visibility !== "hidden")!;
    expect(closedMarker.querySelector("path")).toHaveAttribute("d", "m4.5 3 3 3-3 3");
    fireEvent.click(closedMarker);
    await waitFor(() => expect(document.querySelector(".cm-foldPlaceholder")).toBeNull());
    expect(await screen.findByLabelText("折叠代码")).toBeInTheDocument();
  });

  it("keeps unsaved text, selection and undo history when the font changes", async () => {
    apiMock.readFile.mockResolvedValue(textFile("const value = 1;\n"));
    const props = {
      tab,
      active: true,
      theme: "light" as const,
      reveal: null,
      reloadToken: 0,
      externalChangeToken: 0,
      onStatus: vi.fn(),
      onDirtyChange: vi.fn(),
      onSaved: vi.fn(),
    };
    const { rerender } = render(<CodeReader {...props} fontFamily='"Gaze Maple Mono"' />);
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    act(() =>
      view.dispatch({ changes: { from: 0, insert: "// 修改\n" }, selection: { anchor: 3 } }),
    );
    const edited = view.state.doc.toString();
    rerender(<CodeReader {...props} fontFamily="Consolas" />);
    expect(EditorView.findFromDOM(content)).toBe(view);
    expect(view.state.doc.toString()).toBe(edited);
    expect(view.state.selection.main.anchor).toBe(3);
    expect(window.getComputedStyle(view.scrollDOM).fontFamily).toContain("Consolas");
    expect(apiMock.readFile).toHaveBeenCalledTimes(1);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("const value = 1;\n");
  });

  it("marks edits dirty and auto-saves after the debounce", async () => {
    const { onDirtyChange, onSaved } = renderReader();
    const view = EditorView.findFromDOM(await editorContent())!;
    vi.useFakeTimers();
    try {
      act(() => view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }));
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      await act(() => vi.advanceTimersByTimeAsync(DEFAULT_PREFERENCES.autoSaveDelay - 1));
      expect(apiMock.writeFile).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));

      expect(apiMock.writeFile).toHaveBeenCalledExactlyOnceWith(
        "p1",
        "src/a.ts",
        expect.stringContaining("x"),
        { size: 17, modifiedNs: "1" },
        "utf8",
        "lf",
        false,
      );
      expect(onSaved).toHaveBeenCalledOnce();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses auto-save when the file changed on disk", async () => {
    apiMock.writeFile.mockRejectedValue({
      code: "conflict",
      message: "文件已在磁盘上被修改，保存已阻止。",
    });
    renderReader();
    const view = EditorView.findFromDOM(await editorContent())!;
    vi.useFakeTimers();
    try {
      act(() => view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }));
      await act(() => vi.advanceTimersByTimeAsync(DEFAULT_PREFERENCES.autoSaveDelay));
      expect(screen.getByText(/文件已在磁盘上被修改/)).toBeInTheDocument();
      expect(apiMock.writeFile).toHaveBeenCalledOnce();
      act(() => view.dispatch({ changes: { from: 0, insert: "y" }, userEvent: "input.type" }));
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(apiMock.writeFile).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("edits normalized LF content but saves with the original CRLF line ending", async () => {
    const user = userEvent.setup();
    const { ref } = renderReader({ content: "first\r\nsecond\r\n", lineEnding: "crlf" });
    const content = await editorContent();
    const lines = Array.from(content.querySelectorAll(".cm-line")).map((line) => line.textContent);
    expect(lines).toEqual(["first", "second", ""]);
    await user.click(content);
    await user.keyboard("x");

    await act(async () => {
      expect(await ref.current!.save()).toEqual({ status: "saved" });
    });
    expect(apiMock.writeFile).toHaveBeenCalledOnce();
    const args = apiMock.writeFile.mock.calls[0]!;
    expect(args[2]).not.toContain("\r");
    expect(args[5]).toBe("crlf");
  });

  it("explains why a large or lossy file remains read-only", async () => {
    renderReader({ editable: false, reason: "文件超过 2 MiB，仅支持阅读。" });
    expect(await screen.findByText("文件超过 2 MiB，仅支持阅读。")).toBeInTheDocument();
    const content = await editorContent();
    expect(content.getAttribute("contenteditable")).toBe("false");
  });

  it("locks input, drains an in-flight save and saves later edits before a file operation", async () => {
    const user = userEvent.setup();
    let resolveWrite!: (value: {
      fingerprint: { size: number; modifiedNs: string };
      size: number;
    }) => void;
    apiMock.writeFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const { ref } = renderReader();
    const content = await editorContent();
    await user.click(content);
    await user.keyboard("x");
    await waitFor(() => expect(apiMock.writeFile).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await user.keyboard("y");
    const text = ref.current!.getText();
    let preparation!: Promise<SaveResult>;
    act(() => {
      preparation = ref.current!.prepareFileOperation();
    });
    expect(content).toHaveAttribute("contenteditable", "false");
    const view = EditorView.findFromDOM(content)!;
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "blocked" } });
    });
    expect(ref.current!.getText()).toBe(text);
    await act(async () => {
      resolveWrite({ fingerprint: { size: 20, modifiedNs: "2" }, size: 20 });
      expect(await preparation).toEqual({ status: "saved" });
    });
    expect(apiMock.writeFile).toHaveBeenCalledTimes(2);
    expect(apiMock.writeFile.mock.calls[1]![2]).toBe(text);
    expect(ref.current!.isDirty()).toBe(false);
    act(() => ref.current!.finishFileOperation());
    expect(content).toHaveAttribute("contenteditable", "true");
  });

  it("locks dirty content without saving and reloads confirmed Git discard without writing the old buffer", async () => {
    const user = userEvent.setup();
    const { ref } = renderReader();
    const content = await editorContent();
    await user.click(content);
    await user.keyboard("unsaved");
    await act(async () => {
      expect(await ref.current!.prepareFileOperation({ save: false })).toEqual({ status: "clean" });
    });
    expect(apiMock.writeFile).not.toHaveBeenCalled();
    expect(content).toHaveAttribute("contenteditable", "false");
    apiMock.readFile.mockResolvedValueOnce(textFile("from Git\n"));
    act(() => ref.current!.finishFileOperation({ reload: true }));
    await waitFor(() => expect(ref.current!.getText()).toBe("from Git\n"));
    expect(ref.current!.isDirty()).toBe(false);
    expect(apiMock.writeFile).not.toHaveBeenCalled();
  });

  it("keeps newly opened Git-locked files read-only until the repository is released", async () => {
    const { ref, props, rerender } = renderReader();
    rerender(<CodeReader {...props} gitLocked />);
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    const text = ref.current!.getText();
    expect(content).toHaveAttribute("contenteditable", "false");
    act(() => view.dispatch({ changes: { from: 0, insert: "blocked" } }));
    expect(ref.current!.getText()).toBe(text);
    expect((await ref.current!.save()).status).toBe("error");
    await act(async () => {
      await ref.current!.prepareFileOperation({ save: false });
    });
    act(() => ref.current!.finishFileOperation());
    expect(content).toHaveAttribute("contenteditable", "false");
    rerender(<CodeReader {...props} />);
    expect(content).toHaveAttribute("contenteditable", "true");
    expect(apiMock.writeFile).not.toHaveBeenCalled();
  });

  it("highlights the entire hovered gutter block and clears it on leave", async () => {
    gitApiMock.getFileBase.mockResolvedValue({
      content: "start\nold a\nold b\nold c\ncontext\nold d\nold e\nend",
      exists: true,
    });
    renderReader({ content: "start\nnew a\nnew b\nnew c\ncontext\nnew d\nnew e\nend" });
    const view = EditorView.findFromDOM(await editorContent())!;
    const gutter = view.dom.querySelector<HTMLElement>(".cm-git-changes")!;
    const marks = () => Array.from(gutter.querySelectorAll<HTMLElement>(".cm-git-line-modified"));
    const hovered = () => Array.from(gutter.querySelectorAll(".cm-git-line-hovered"));
    await waitFor(() => expect(marks()).toHaveLength(5));

    const moveOver = (index: number, line: number) => {
      const marker = marks()[index]!;
      const block = view.lineBlockAt(view.state.doc.line(line).from);
      vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, view.documentTop + block.top, 11, block.height),
      );
      fireEvent.mouseMove(marker);
    };

    moveOver(1, 3);
    expect(hovered()).toEqual(marks().slice(0, 3));
    moveOver(4, 7);
    expect(hovered()).toEqual(marks().slice(3));
    fireEvent.mouseLeave(gutter);
    expect(hovered()).toHaveLength(0);
  });

  it("paints local changes in the gutter and reverts a block from the popover", async () => {
    gitApiMock.getFileBase.mockResolvedValue({
      content: "const value = 1;\n",
      exists: true,
    });
    renderReader({ content: "const value = 2;\n" });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    const marker = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".cm-git-line-modified");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(document.querySelector(".git-change-tick-modified")).not.toBeNull();

    await userEvent.click(marker);
    expect(await screen.findByText("修改 1 行（原 1 行）")).toBeInTheDocument();
    const diff = screen.getByRole("dialog", { name: "代码变更" });
    expect(diff).toHaveTextContent("const value = 1;");
    expect(diff).toHaveTextContent("const value = 2;");
    await waitFor(() =>
      expect([...diff.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
        "1",
        "2",
      ]),
    );

    await userEvent.click(screen.getByRole("button", { name: "撤销此更改" }));
    expect(view.state.doc.toString()).toBe("const value = 1;\n");
    await waitFor(() => expect(document.querySelector(".cm-git-line-modified")).toBeNull());
    await waitFor(() => expect(document.querySelector(".git-change-tick-modified")).toBeNull());
  });

  it("shows added lines, passes unsaved content to the full diff, and closes a stale popup", async () => {
    const base = "const anchor = true;";
    const added = '\nconst route = "/api/catalog?include=inventory,pricing,shipping,availability";';
    gitApiMock.getFileBase.mockResolvedValue({ content: base, exists: true });
    const onOpenComparison = vi.fn();
    renderReader({ content: base, onOpenComparison });
    const view = EditorView.findFromDOM(await editorContent())!;
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: added } }));
    await waitFor(() => expect(view.dom.querySelector(".cm-git-line-added")).not.toBeNull());
    act(() => view.dispatch({ selection: { anchor: view.state.doc.line(2).from } }));
    view.focus();
    fireEvent.keyDown(view.contentDOM, { key: "F10", shiftKey: true });
    await userEvent.click(screen.getByRole("menuitem", { name: "查看此处代码变更" }));
    const popup = await screen.findByRole("dialog", { name: "代码变更" });
    expect(popup).toHaveTextContent(added.trim());
    expect(popup).not.toHaveTextContent("修改前 · HEAD");
    const wrap = within(popup).getByRole("button", { name: "自动换行", pressed: true });
    await userEvent.click(wrap);
    expect(popup.querySelector(".git-change-lines")).toHaveClass("no-wrap");
    await userEvent.click(within(popup).getByRole("button", { name: "打开完整对比" }));
    expect(onOpenComparison).toHaveBeenCalledWith(
      expect.objectContaining({ doc: view.state.doc, selected: 0, wrap: false }),
    );
    expect(apiMock.writeFile).not.toHaveBeenCalled();

    await clickGitMarker(view, "added", 2);
    expect(await screen.findByRole("dialog", { name: "代码变更" })).toBeInTheDocument();
    act(() => view.dispatch({ changes: { from: 0, insert: "// unsaved\n" } }));
    expect(screen.queryByRole("dialog", { name: "代码变更" })).not.toBeInTheDocument();
    expect(view.state.doc.toString()).toBe(`// unsaved\n${base}${added}`);
  });

  it.each([
    ["a", "a\nextra", "新增 1 行", "added", 2],
    ["a\n", "a\nextra\n", "新增 1 行", "added", 2],
    ["a\nremoved", "a", "删除 1 行", "deleted", 1],
    ["a\n", "", "删除 1 行", "deleted", 1],
    ["a", "", "删除 1 行", "deleted", 1],
    ["", "added", "新增 1 行", "added", 1],
  ] as const)(
    "reverts a boundary change from %j to %j without introducing line breaks",
    async (base, current, label, kind, line) => {
      gitApiMock.getFileBase.mockResolvedValue({ content: base, exists: !!base });
      renderReader({ content: current });
      const view = EditorView.findFromDOM(await editorContent())!;
      await clickGitMarker(view, kind, line);
      expect(await screen.findByText(label)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "撤销此更改" }));
      expect(view.state.doc.toString()).toBe(base);
      act(() => {
        undo(view);
      });
      expect(view.state.doc.toString()).toBe(current);
    },
  );

  it("keeps dirty contents and restores editing when preparation fails", async () => {
    const user = userEvent.setup();
    const { ref } = renderReader();
    const content = await editorContent();
    await user.click(content);
    await user.keyboard("x");
    const text = ref.current!.getText();
    apiMock.writeFile.mockRejectedValueOnce({ code: "conflict", message: "磁盘冲突" });
    await act(async () => {
      expect(await ref.current!.prepareFileOperation()).toEqual({
        status: "conflict",
        message: "磁盘冲突",
      });
    });
    act(() => ref.current!.finishFileOperation());
    expect(content).toHaveAttribute("contenteditable", "true");
    expect(ref.current!.getText()).toBe(text);
    expect(ref.current!.isDirty()).toBe(true);
    await act(async () => {
      expect((await ref.current!.prepareFileOperation()).status).toBe("conflict");
    });
    expect(apiMock.writeFile).toHaveBeenCalledTimes(1);
    act(() => ref.current!.finishFileOperation());
  });

  it("debounces recovery writes and deletes the record when edits return to clean", async () => {
    const { ref } = renderReader({
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
    });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    vi.useFakeTimers();
    try {
      act(() => view.dispatch({ changes: { from: 0, insert: "// draft\n" } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(499);
      });
      expect(apiMock.writeRecovery).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(apiMock.writeRecovery).toHaveBeenCalledWith(
        "p1",
        "src/a.ts",
        "// draft\nconst value = 1;\n",
        { size: 17, modifiedNs: "1" },
      );
      await act(async () => {
        expect(undo(view)).toBe(true);
        await Promise.resolve();
      });
      expect(ref.current!.isDirty()).toBe(false);
      expect(apiMock.deleteRecovery).toHaveBeenCalledWith("p1", "src/a.ts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a pending recovery write after a successful save", async () => {
    const { ref } = renderReader({
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
    });
    const content = await editorContent();
    const view = EditorView.findFromDOM(content)!;
    vi.useFakeTimers();
    try {
      act(() => view.dispatch({ changes: { from: 0, insert: "// saved\n" } }));
      await act(async () => {
        expect(await ref.current!.save()).toEqual({ status: "saved" });
      });
      expect(apiMock.deleteRecovery).toHaveBeenCalledWith("p1", "src/a.ts");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(apiMock.writeRecovery).not.toHaveBeenCalled();
      expect(ref.current!.isDirty()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows disk content first and restores a crash draft as dirty with conflict protection", async () => {
    const originalFingerprint = { size: 999, modifiedNs: "0" };
    const { ref, onDirtyChange } = renderReader({
      preferences: { ...DEFAULT_PREFERENCES, autoSave: false },
      recovery: {
        projectId: "p1",
        path: "src/a.ts",
        content: "const recovered = true;\n",
        originalFingerprint,
        updatedAtMs: 1_700_000_000_000,
      },
    });
    await editorContent();
    expect(ref.current!.getText()).toBe("const value = 1;\n");
    expect(screen.getByRole("alert")).toHaveTextContent("当前显示磁盘内容");
    expect(ref.current!.isDirty()).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "恢复未保存修改" }));
    expect(ref.current!.getText()).toBe("const recovered = true;\n");
    expect(ref.current!.isDirty()).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("button", { name: "恢复未保存修改" })).not.toBeInTheDocument();

    apiMock.writeFile.mockRejectedValueOnce({ code: "conflict", message: "磁盘已变化" });
    await act(async () => {
      expect(await ref.current!.save()).toEqual({ status: "conflict", message: "磁盘已变化" });
    });
    expect(apiMock.writeFile.mock.calls[0]![3]).toEqual(originalFingerprint);
  });

  it("discards a recovery candidate without changing the disk buffer", async () => {
    const { ref } = renderReader({
      recovery: {
        projectId: "p1",
        path: "src/a.ts",
        content: "draft\n",
        originalFingerprint: { size: 17, modifiedNs: "1" },
        updatedAtMs: 1_700_000_000_000,
      },
    });
    await editorContent();
    await userEvent.click(screen.getByRole("button", { name: "放弃恢复" }));

    await waitFor(() => expect(apiMock.deleteRecovery).toHaveBeenCalledWith("p1", "src/a.ts"));
    expect(ref.current!.getText()).toBe("const value = 1;\n");
    expect(ref.current!.isDirty()).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cleans a recovery record when normalized disk content already matches it", async () => {
    const { ref } = renderReader({
      content: "first\r\nsecond\r\n",
      lineEnding: "crlf",
      recovery: {
        projectId: "p1",
        path: "src/a.ts",
        content: "first\nsecond\n",
        originalFingerprint: { size: 16, modifiedNs: "1" },
        updatedAtMs: 1_700_000_000_000,
      },
    });
    await editorContent();

    await waitFor(() => expect(apiMock.deleteRecovery).toHaveBeenCalledWith("p1", "src/a.ts"));
    expect(ref.current!.getText()).toBe("first\nsecond\n");
    expect(ref.current!.isDirty()).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("editor plugin commands", () => {
  it.each(["unchanged", "edit", "selection", "tab switch"])(
    "applies a single undoable transaction only when the editor snapshot stays unchanged (%s)",
    async (scenario) => {
      const installed = {
        manifest: {
          id: "example.text-tools",
          name: "Text Tools",
          version: "1",
          apiVersion: 1,
          runtime: "javaScript" as const,
          entry: "plugin.js",
          contributes: [{ kind: "command" as const, id: "upper", title: "Uppercase" }],
        },
        revision: "test-version",
        enabled: true,
      };
      const list = vi.spyOn(pluginApi, "list").mockResolvedValue([installed]);
      let finish!: (value: { kind: "replace"; text: string }) => void;
      const run = vi.spyOn(pluginApi, "run").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      try {
        const { rerender, props } = renderReader({ content: "abc def", withPlugins: true });
        const view = EditorView.findFromDOM(await editorContent())!;
        if (scenario === "unchanged") {
          act(() => view.dispatch({ changes: { from: 3, insert: "!" }, userEvent: "input.type" }));
        }
        act(() => view.dispatch({ selection: { anchor: 0, head: 3 } }));
        fireEvent.click(await screen.findByRole("combobox", { name: "插件命令" }));
        fireEvent.click(screen.getByRole("option", { name: "Uppercase, Text Tools" }));
        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[1]).toMatchObject({ kind: "command", id: "upper", text: "abc" });
        const signal = run.mock.calls[0]![2];
        if (scenario === "edit") {
          act(() => view.dispatch({ changes: { from: 7, insert: "!" } }));
        } else if (scenario === "selection") {
          act(() => view.dispatch({ selection: { anchor: 4, head: 7 } }));
        } else if (scenario === "tab switch") {
          rerender(
            <PluginProvider preferences={DEFAULT_PREFERENCES}>
              <CodeReader {...props} active={false} />
            </PluginProvider>,
          );
        }
        await act(async () => finish({ kind: "replace", text: "ABC" }));
        if (scenario === "unchanged") {
          expect(view.state.doc.toString()).toBe("ABC! def");
          act(() => {
            undo(view);
          });
          expect(view.state.doc.toString()).toBe("abc! def");
        } else {
          expect(signal.aborted).toBe(true);
          expect(view.state.doc.toString()).toBe(scenario === "edit" ? "abc def!" : "abc def");
        }
      } finally {
        list.mockRestore();
        run.mockRestore();
      }
    },
  );
});
