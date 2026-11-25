import { history, undo } from "@codemirror/commands";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "./api";
import { applyEditorEdits } from "./editorEdits";
import {
  editorLanguageTools,
  runEditorLanguageAction,
  signatureParts,
} from "./editorLanguageTools";

vi.mock("./api", () => ({
  api: {
    lspEditorRevisionMatches: vi.fn(),
    lspFormat: vi.fn(),
    lspCodeActions: vi.fn(),
    lspResolveCodeAction: vi.fn(),
    lspSignatureHelp: vi.fn(),
  },
}));

const target = { projectId: "test", path: "main.ts", revision: { session: "s", version: 3 } };

it("keeps organize imports and manual parameter info reachable by keyboard", () => {
  const view = new EditorView({
    doc: "import { widget } from './utils';\nwidget()",
    extensions: editorLanguageTools({ ...target, wanted: () => true, notify: vi.fn() }),
  });
  try {
    vi.mocked(api.lspCodeActions).mockResolvedValueOnce({
      actions: [],
      source: "lsp",
      message: null,
    });
    vi.mocked(api.lspSignatureHelp).mockResolvedValueOnce(null);
    const mac = /Mac/.test(navigator.platform);
    const press = (init: KeyboardEventInit) =>
      runScopeHandlers(view, new KeyboardEvent("keydown", init), "editor");
    expect(press({ key: "o", altKey: true, ctrlKey: !mac, metaKey: mac })).toBe(true);
    expect(api.lspCodeActions).toHaveBeenLastCalledWith(
      "test",
      "main.ts",
      view.state.doc.toString(),
      expect.any(Object),
      ["source.organizeImports"],
    );
    expect(press({ key: " ", ctrlKey: true, shiftKey: true })).toBe(true);
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
    extensions: [
      history(),
      editorLanguageTools({ ...target, wanted: () => true, notify: vi.fn() }),
    ],
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

it("opens quick fixes at the caret and resolves the selected candidate before applying it", async () => {
  const view = new EditorView({
    parent: document.body,
    doc: "widget()",
    extensions: [
      history(),
      editorLanguageTools({ ...target, wanted: () => true, notify: vi.fn() }),
    ],
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
