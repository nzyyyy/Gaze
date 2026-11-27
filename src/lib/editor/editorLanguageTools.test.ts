import {
  autocompletion,
  closeCompletion,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { activateHover, EditorView, runScopeHandlers } from "@codemirror/view";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "../platform/api";
import { defaultShortcut } from "../shortcuts";
import { applyEditorEdits } from "./editorEdits";
import {
  dismissEditorLanguageTooltip,
  editorLanguageTools,
  runEditorLanguageAction,
  signatureParts,
} from "./editorLanguageTools";

vi.mock("../platform/api", () => ({
  api: {
    lspEditorRevisionMatches: vi.fn(),
    lspFormat: vi.fn(),
    lspCodeActions: vi.fn(),
    lspResolveCodeAction: vi.fn(),
    lspSignatureHelp: vi.fn(),
    hoverCode: vi.fn(),
  },
}));

const target = { projectId: "test", path: "main.ts", revision: { session: "s", version: 3 } };
const context = {
  ...target,
  wanted: () => true,
  notify: vi.fn(),
  shortcut: (id: string) => defaultShortcut(id),
};

function press(view: EditorView, key: string) {
  return runScopeHandlers(view, new KeyboardEvent("keydown", { key }), "editor");
}

it("keeps organize imports and manual parameter info reachable by keyboard", () => {
  const view = new EditorView({
    doc: "import { widget } from './utils';\nwidget()",
    extensions: editorLanguageTools(context),
  });
  try {
    vi.mocked(api.lspCodeActions).mockResolvedValueOnce({
      actions: [],
      source: "lsp",
      message: null,
    });
    vi.mocked(api.lspSignatureHelp).mockResolvedValueOnce(null);
    const press = (init: KeyboardEventInit) =>
      runScopeHandlers(view, new KeyboardEvent("keydown", init), "editor");
    expect(press({ key: "o", altKey: true, ctrlKey: true, metaKey: true })).toBe(true);
    expect(api.lspCodeActions).toHaveBeenLastCalledWith(
      "test",
      "main.ts",
      view.state.doc.toString(),
      expect.any(Object),
      ["source.organizeImports"],
    );
    expect(press({ key: "p", metaKey: true })).toBe(true);
    expect(api.lspSignatureHelp).toHaveBeenLastCalledWith(
      "test",
      "main.ts",
      view.state.doc.toString(),
      { line: 0, character: 0 },
    );
  } finally {
    view.destroy();
  }
});

it("rejects overlap, split surrogate offsets and stale replies without partial edits", async () => {
  const view = new EditorView({ doc: "x😀y" });
  try {
    const { doc } = view.state;
    expect(
      await applyEditorEdits(view, doc, [{ from: 2, to: 2, insert: "!" }], target, () => true),
    ).toBe("invalid");
    expect(
      await applyEditorEdits(
        view,
        doc,
        [
          { from: 0, to: 3, insert: "" },
          { from: 1, to: 4, insert: "!" },
        ],
        target,
        () => true,
      ),
    ).toBe("invalid");
    vi.mocked(api.lspEditorRevisionMatches).mockResolvedValueOnce(false);
    expect(
      await applyEditorEdits(view, doc, [{ from: 0, to: 1, insert: "" }], target, () => true),
    ).toBe("stale");
    vi.mocked(api.lspEditorRevisionMatches).mockImplementationOnce(async () => {
      view.dispatch({ changes: { from: 4, insert: "!" } });
      return true;
    });
    expect(
      await applyEditorEdits(view, doc, [{ from: 0, to: 1, insert: "" }], target, () => true),
    ).toBe("stale");
    expect(view.state.doc.toString()).toBe("x😀y!");
  } finally {
    view.destroy();
  }
});

it("formats the selected unsaved text and undoes just that action in one step", async () => {
  const view = new EditorView({
    doc: "const a=1;",
    extensions: [history(), editorLanguageTools(context)],
  });
  try {
    view.dispatch({
      changes: { from: 10, insert: " " },
      selection: { anchor: 7, head: 9 },
      userEvent: "input.type",
    });
    vi.mocked(api.lspFormat).mockResolvedValueOnce({
      edits: [{ from: 7, to: 9, insert: " = 1" }],
      revision: target.revision,
    });
    vi.mocked(api.lspEditorRevisionMatches).mockResolvedValueOnce(true);
    await runEditorLanguageAction(view, "format-code");
    expect(api.lspFormat).toHaveBeenLastCalledWith(
      "test",
      "main.ts",
      "const a=1; ",
      { start: { line: 0, character: 7 }, end: { line: 0, character: 9 } },
      { tabSize: 2, insertSpaces: true },
    );
    expect(view.state.doc.toString()).toBe("const a = 1; ");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("const a=1; ");
  } finally {
    view.destroy();
  }
});

it("uses the active overload and its UTF-16 parameter offsets", () => {
  expect(
    signatureParts({
      activeSignature: 1,
      activeParameter: 0,
      signatures: [
        { label: "f()", parameters: [], activeParameter: null },
        {
          label: "f(😀, param)",
          parameters: [{ label: [2, 4] }, { label: [6, 11] }],
          activeParameter: 1,
        },
      ],
    }),
  ).toEqual({ before: "f(😀, ", current: "param", after: ")" });
});

it("delays the signature for a real call, hides it during completion and cancels on escape", async () => {
  const typescript = await languages.find(({ name }) => name === "TypeScript")!.load();
  vi.useFakeTimers();
  const signatureHelp = vi
    .mocked(api.lspSignatureHelp)
    .mockReset()
    .mockResolvedValue({
      activeSignature: 0,
      activeParameter: 0,
      signatures: [{ label: "widget(arg)", parameters: [{ label: "arg" }], activeParameter: null }],
    });
  const view = new EditorView({
    parent: document.body,
    doc: "widget",
    selection: { anchor: 6 },
    extensions: [
      typescript,
      editorLanguageTools(context),
      autocompletion({
        activateOnTyping: false,
        override: [(context) => ({ from: context.pos, options: [{ label: "argument" }] })],
      }),
    ],
  });
  try {
    view.focus();
    view.dispatch({
      changes: { from: 6, insert: "()" },
      selection: { anchor: 7 },
      userEvent: "input.type",
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(signatureHelp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(view.dom.querySelector(".cm-signature-help strong")).toHaveTextContent("arg");

    startCompletion(view);
    await vi.advanceTimersByTimeAsync(150);
    expect(completionStatus(view.state)).toBe("active");
    expect(view.dom.querySelector(".cm-signature-help")).toBeNull();
    closeCompletion(view);
    await vi.advanceTimersByTimeAsync(120);
    expect(view.dom.querySelector(".cm-signature-help")).toBeInTheDocument();

    startCompletion(view);
    await vi.advanceTimersByTimeAsync(150);
    expect(press(view, "Escape")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(completionStatus(view.state)).toBeNull();
    expect(view.dom.querySelector(".cm-signature-help")).toBeNull();
    expect(signatureHelp).toHaveBeenCalledTimes(2);

    const reply = await signatureHelp.mock.results[0]!.value;
    let finish!: (help: typeof reply) => void;
    signatureHelp.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    view.dispatch({
      changes: { from: 8, insert: "\nwidget()" },
      selection: { anchor: 16 },
      userEvent: "input.type",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(signatureHelp).toHaveBeenCalledTimes(3);
    view.dispatch({ selection: { anchor: 0 } });
    finish(reply);
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.dom.querySelector(".cm-signature-help")).toBeNull();
  } finally {
    view.destroy();
    view.dom.remove();
    vi.useRealTimers();
  }
});

it("starts from completion inside an argument list but skips declarations and standalone commas", async () => {
  const python = await languages.find(({ name }) => name === "Python")!.load();
  const signatureHelp = vi.mocked(api.lspSignatureHelp).mockReset().mockResolvedValue(null);
  vi.useFakeTimers();
  const view = new EditorView({
    parent: document.body,
    extensions: [python, editorLanguageTools(context)],
  });
  try {
    view.focus();
    const edit = (text: string, anchor: number, userEvent: string) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor },
        userEvent,
      });
    edit("def widget():\n  pass", 11, "input.type");
    await vi.advanceTimersByTimeAsync(1000);
    edit("widget(arg,)", 11, "input.type");
    await vi.advanceTimersByTimeAsync(1000);
    expect(signatureHelp).not.toHaveBeenCalled();
    edit("widget(arg)", 10, "input.complete");
    await vi.advanceTimersByTimeAsync(1000);
    expect(signatureHelp).toHaveBeenCalledOnce();
    expect(signatureHelp).toHaveBeenLastCalledWith("test", "main.ts", "widget(arg)", {
      line: 0,
      character: 10,
    });
  } finally {
    view.destroy();
    view.dom.remove();
    vi.useRealTimers();
  }
});

it("only shows manual documentation for the current editor context", async () => {
  const hover = vi.mocked(api.hoverCode).mockReset();
  let finish!: (contents: Awaited<ReturnType<typeof api.hoverCode>>) => void;
  hover.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = new EditorView({
    parent: document.body,
    doc: "widget",
    selection: { anchor: 6 },
    extensions: editorLanguageTools(context),
  });
  try {
    view.focus();
    activateHover(view, 3, 1);
    expect(hover).not.toHaveBeenCalled();
    // F1 is the configured quick documentation key (see defaultShortcut).
    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "F1" }), "editor")).toBe(
      true,
    );
    expect(hover).toHaveBeenCalledWith("test", "main.ts", "widget", { line: 0, character: 5 });
    dismissEditorLanguageTooltip(view);
    const contents = [{ value: "Widget docs", kind: "plaintext" as const, language: null }];
    finish(contents);
    await Promise.resolve();
    expect(view.dom.querySelector(".code-hover")).toBeNull();

    hover.mockResolvedValueOnce(contents);
    await runEditorLanguageAction(view, "quick-documentation");
    expect(view.dom.querySelector(".code-hover")).toHaveTextContent("Widget docs");
    expect(press(view, "Escape")).toBe(true);
    expect(view.dom.querySelector(".code-hover")).toBeNull();
  } finally {
    view.destroy();
    view.dom.remove();
  }
});

it("keeps quick documentation available in read-only files", async () => {
  const hover = vi.mocked(api.hoverCode).mockReset();
  hover.mockResolvedValueOnce([{ value: "Widget docs", kind: "plaintext", language: null }]);
  const view = new EditorView({
    parent: document.body,
    doc: "widget",
    selection: { anchor: 6 },
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      editorLanguageTools(context),
    ],
  });
  try {
    view.focus();
    expect(runScopeHandlers(view, new KeyboardEvent("keydown", { key: "F1" }), "editor")).toBe(
      true,
    );
    expect(hover).toHaveBeenCalledWith("test", "main.ts", "widget", { line: 0, character: 5 });
  } finally {
    view.destroy();
    view.dom.remove();
  }
});

it("dismisses opt-in hover for navigation and drops its pending response", async () => {
  const hover = vi.mocked(api.hoverCode).mockReset();
  const contents = [{ value: "Widget docs", kind: "plaintext" as const, language: null }];
  hover.mockResolvedValueOnce(contents);
  const view = new EditorView({
    parent: document.body,
    doc: "widget",
    extensions: editorLanguageTools({ ...context, hoverEnabled: true }),
  });
  try {
    view.focus();
    activateHover(view, 3, 1);
    await vi.waitFor(() => expect(view.dom.querySelector(".code-hover")).toBeInTheDocument());
    dismissEditorLanguageTooltip(view);
    expect(view.dom.querySelector(".code-hover")).toBeNull();

    let finish!: (items: typeof contents) => void;
    hover.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.mouseMove(view.contentDOM);
    activateHover(view, 3, 1);
    expect(hover).toHaveBeenCalledTimes(2);
    dismissEditorLanguageTooltip(view);
    finish(contents);
    await Promise.resolve();
    expect(view.dom.querySelector(".code-hover")).toBeNull();
  } finally {
    view.destroy();
    view.dom.remove();
  }
});

it("opens quick fixes at the caret and resolves the selected candidate before applying it", async () => {
  const view = new EditorView({
    parent: document.body,
    doc: "widget()",
    extensions: [history(), editorLanguageTools(context)],
  });
  try {
    const resolve = { path: target.path, revision: target.revision, action: { data: 1 } };
    const action = {
      title: "Add import",
      kind: "quickfix",
      disabledReason: null,
      isPreferred: true,
      edit: null,
      resolve,
    };
    vi.mocked(api.lspCodeActions).mockResolvedValueOnce({
      actions: [action],
      source: "lsp",
      message: null,
      revision: target.revision,
    });
    vi.mocked(api.lspResolveCodeAction).mockResolvedValueOnce({
      ...action,
      resolve: null,
      edit: {
        files: [
          {
            path: target.path,
            edits: [{ from: 0, to: 0, insert: "import { widget } from './utils';\n" }],
          },
        ],
      },
    });
    vi.mocked(api.lspEditorRevisionMatches).mockResolvedValueOnce(true);
    view.focus();
    await runEditorLanguageAction(view, "quick-fix");
    const fix = await screen.findByRole("menuitem", { name: "Add import" });
    fireEvent.click(fix);
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe("import { widget } from './utils';\nwidget()"),
    );
    expect(api.lspResolveCodeAction).toHaveBeenLastCalledWith(
      "test",
      "main.ts",
      "widget()",
      resolve,
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("widget()");
  } finally {
    view.dom.remove();
    view.destroy();
  }
});
