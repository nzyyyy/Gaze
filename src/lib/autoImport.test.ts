import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { autoImportExtension, unambiguousImport, editTouchesLineInDoc } from "./autoImport";
import { synchronizedLspVersion } from "./diagnostics";
import type { CodeAction } from "./types";

vi.mock("./api", () => ({
  api: {
    onDiagnostics: vi.fn(),
    lspCodeActions: vi.fn(),
    lspEditorRevisionMatches: vi.fn(),
    lspResolveCodeAction: vi.fn(),
  },
}));

vi.mock("./diagnostics", async (original) => ({
  ...(await original<typeof import("./diagnostics")>()),
  synchronizedLspVersion: vi.fn(),
}));

let view: EditorView | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.mocked(api.onDiagnostics).mockResolvedValue(() => {});
  vi.mocked(synchronizedLspVersion).mockReturnValue({ session: "s", version: 1 });
});

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function editor(doc: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [autoImportExtension("p", "src/main.ts")],
    }),
  });
  // jsdom: hasFocus is false by default; stub it.
  vi.spyOn(view, "hasFocus", "get").mockReturnValue(true);
  vi.spyOn(view.dom, "isConnected", "get").mockReturnValue(true);
  return view;
}

const importAction: CodeAction = {
  title: "Import 'foo' from './foo'",
  kind: "quickfix",
  disabledReason: null,
  isPreferred: true,
  edit: {
    files: [
      {
        path: "src/main.ts",
        edits: [{ from: 0, to: 0, insert: "import { foo } from './foo';\n" }],
      },
    ],
  },
  resolve: null,
};

it("unambiguousImport picks the single import quickfix", () => {
  expect(unambiguousImport([importAction])).toBe(importAction);
  expect(unambiguousImport([])).toBeNull();
  expect(unambiguousImport([importAction, { ...importAction, title: "Import 'bar'" }])).toBeNull();
  expect(unambiguousImport([{ ...importAction, kind: "refactor.extract" }])).toBeNull();
  expect(unambiguousImport([{ ...importAction, disabledReason: "not applicable" }])).toBeNull();
});

it("editTouchesLineInDoc detects edits on the caret line", () => {
  const doc = EditorState.create({ doc: "line0\nline1\nline2\n" }).doc;
  // line 1 spans offsets 6..11 ("line1").
  expect(editTouchesLineInDoc(importAction, "src/main.ts", 0, doc)).toBe(true);
  expect(editTouchesLineInDoc(importAction, "src/main.ts", 1, doc)).toBe(false);
  expect(editTouchesLineInDoc(importAction, "src/main.ts", 2, doc)).toBe(false);
});

it("skips an error on the caret line", async () => {
  const doc = "foo();\n";
  const view = editor(doc);
  vi.mocked(api.lspCodeActions).mockResolvedValue({
    actions: [importAction],
    source: "lsp",
    message: null,
  });

  // Simulate a diagnostic arriving for line 0 (not the caret line).
  const handler = vi.mocked(api.onDiagnostics).mock.calls[0]?.[0];
  expect(handler).toBeDefined();
  // Move caret to line 0 end so the diagnostic is on the caret line → skipped.
  view.dispatch({ selection: { anchor: 0 } });
  handler!({
    projectId: "p",
    path: "src/main.ts",
    session: "s",
    version: 1,
    items: [
      {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
        severity: 1,
        message: "Cannot find name 'foo'.",
        source: "ts",
      },
    ],
  });

  // The diagnostic is on the caret line, so no auto-import should fire.
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.lspCodeActions).not.toHaveBeenCalled();
});

it.each([false, true])(
  "protects edits made while a fix is pending (changed = %s)",
  async (changed) => {
    const view = editor("foo();\n");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const revision = { session: "s", version: 1 };
    vi.mocked(api.lspEditorRevisionMatches).mockResolvedValue(true);
    vi.mocked(api.lspCodeActions).mockImplementationOnce(async () => {
      if (changed)
        view.dispatch({ changes: { from: view.state.doc.length, insert: "// keep this" } });
      return { actions: [importAction], source: "lsp", message: null, revision };
    });
    const handler = vi.mocked(api.onDiagnostics).mock.calls[0]?.[0];
    handler!({
      projectId: "p",
      path: "src/main.ts",
      ...revision,
      items: [
        {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
          severity: 1,
          message: "Cannot find name 'foo'.",
          source: "ts",
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.lspCodeActions).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe(
      changed ? "foo();\n// keep this" : "import { foo } from './foo';\nfoo();\n",
    );
  },
);

it("does not fire when the server is unavailable", async () => {
  editor("foo();\n");
  vi.mocked(api.lspCodeActions).mockRejectedValue({ code: "unsupported", message: "no server" });
  const handler = vi.mocked(api.onDiagnostics).mock.calls[0]?.[0];
  handler!({
    projectId: "p",
    path: "src/main.ts",
    session: "s",
    version: 1,
    items: [
      {
        start: { line: 5, character: 0 },
        end: { line: 5, character: 3 },
        severity: 1,
        message: "Cannot find name 'foo'.",
        source: "ts",
      },
    ],
  });
  await vi.advanceTimersByTimeAsync(2000);
  // After the first failure the plugin marks itself unavailable and stops.
  // A second schedule should not call the API again.
  const calls = vi.mocked(api.lspCodeActions).mock.calls.length;
  handler!({
    projectId: "p",
    path: "src/main.ts",
    session: "s",
    version: 2,
    items: [
      {
        start: { line: 6, character: 0 },
        end: { line: 6, character: 3 },
        severity: 1,
        message: "Cannot find name 'bar'.",
        source: "ts",
      },
    ],
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(vi.mocked(api.lspCodeActions).mock.calls.length).toBe(calls);
});
