import {
  nextSnippetField,
  CompletionContext,
  selectedCompletion,
  setSelectedCompletion,
  startCompletion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CodeCompletion } from "../platform/api";
import { codeCompletion, lspCompletionSource, snippetTemplate } from "./completion";
import { editorLanguageTools } from "./editorLanguageTools";
import { defaultShortcut } from "../shortcuts";

const contextShortcut = (id: string) => defaultShortcut(id);

vi.mock("../platform/api", () => ({ api: { completeCode: vi.fn(), resolveCompletion: vi.fn() } }));

const item: CodeCompletion = {
  label: "foo",
  detail: "method",
  documentation: "A method",
  kind: 2,
  filterText: null,
  insertText: "foo",
  edit: null,
  additionalEdits: [],
};

function editor(doc = "obj.fo", readonly = false) {
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [EditorState.readOnly.of(readonly), history()],
  });
  return {
    get state() {
      return state;
    },
    dom: { isConnected: true },
    hasFocus: true,
    dispatch(spec: TransactionSpec | Transaction) {
      state = spec instanceof Transaction ? spec.state : state.update(spec).state;
    },
  } as EditorView;
}

function apply(result: CompletionResult | null, view: EditorView) {
  const option = result!.options[0]!;
  if (typeof option.apply !== "function") throw new Error("Missing completion apply");
  option.apply(view, option, result!.from, view.state.doc.length);
}

beforeEach(() => {
  vi.mocked(api.resolveCompletion).mockReset();
  vi.mocked(api.completeCode)
    .mockReset()
    .mockResolvedValue({ items: [item] });
});

describe("code completion", () => {
  it("opens candidate documentation on F1 and discards it after a selection change", async () => {
    vi.mocked(api.completeCode).mockResolvedValue({
      items: [
        { ...item, resolve: { session: "s", generation: 1, item: { label: "foo" } } },
        { ...item, label: "format", documentation: "Formatting docs" },
      ],
    });
    let finish!: (value: CodeCompletion) => void;
    vi.mocked(api.resolveCompletion).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = new EditorView({
      parent: document.body,
      doc: "fo",
      selection: { anchor: 2 },
      extensions: [
        codeCompletion("p", "a.ts"),
        editorLanguageTools({
          projectId: "p",
          path: "a.ts",
          wanted: () => true,
          notify: vi.fn(),
          shortcut: contextShortcut,
        }),
      ],
    });
    try {
      view.focus();
      startCompletion(view);
      await vi.waitFor(() => expect(selectedCompletion(view.state)?.label).toBe("foo"));
      expect(view.dom.querySelector(".completion-documentation")).toBeNull();
      expect(api.resolveCompletion).not.toHaveBeenCalled();

      const f1 = () =>
        runScopeHandlers(view, new KeyboardEvent("keydown", { key: "F1" }), "editor");
      expect(f1()).toBe(true);
      expect(api.resolveCompletion).toHaveBeenCalledOnce();
      view.dispatch({ effects: setSelectedCompletion(1) });
      expect(selectedCompletion(view.state)?.label).toBe("format");
      finish({ ...item, documentation: "Stale docs" });
      await Promise.resolve();
      expect(view.dom.querySelector(".completion-documentation")).toBeNull();

      expect(f1()).toBe(true);
      await vi.waitFor(() =>
        expect(view.dom.querySelector(".completion-documentation")).toHaveTextContent(
          "Formatting docs",
        ),
      );
      expect(view.dom.querySelector(".cm-tooltip-autocomplete")).toBeInTheDocument();
    } finally {
      view.destroy();
      view.dom.remove();
    }
  });

  it("sends the unsaved buffer and UTF-16 cursor, then replaces only the prefix", async () => {
    const view = editor("// 😀\nobj.fo");
    const source = lspCompletionSource("project", "hello.py");
    const result = await source(new CompletionContext(view.state, view.state.doc.length, true));
    expect(api.completeCode).toHaveBeenCalledWith(
      "project",
      "hello.py",
      "// 😀\nobj.fo",
      { line: 1, character: 6 },
      null,
    );
    apply(result, view);
    expect(view.state.doc.toString()).toBe("// 😀\nobj.foo");
  });

  it("applies server replacement and imports together with the correct cursor", async () => {
    const view = editor("obj.fo");
    vi.mocked(api.completeCode).mockResolvedValue({
      items: [
        {
          ...item,
          edit: { from: 4, to: 6, insert: "foo()" },
          additionalEdits: [{ from: 0, to: 0, insert: "import foo\n" }],
        },
      ],
    });
    const result = await lspCompletionSource(
      "p",
      "a.ts",
    )(new CompletionContext(view.state, 6, true));
    apply(result, view);
    expect(view.state.doc.toString()).toBe("import foo\nobj.foo()");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("resolves an import and snippet together and undoes them in one step", async () => {
    const view = editor("obj.fo");
    vi.mocked(api.completeCode).mockResolvedValue({
      items: [{ ...item, resolve: { session: "s", generation: 1, item: { label: "foo" } } }],
    });
    vi.mocked(api.resolveCompletion).mockResolvedValue({
      ...item,
      insertText: "foo(${1:arg}, $2)$0",
      snippet: true,
      additionalEdits: [{ from: 0, to: 0, insert: "import foo\n" }],
    });
    const result = await lspCompletionSource(
      "p",
      "a.ts",
    )(new CompletionContext(view.state, 6, true));
    apply(result, view);
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("import foo\nobj.foo(arg, )"));
    const { from, to } = view.state.selection.main;
    expect(view.state.doc.sliceString(from, to)).toBe("arg");
    expect(nextSnippetField(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.length - 1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("obj.fo");
    expect(snippetTemplate("${1|a,b|}")).toBeNull();
  });

  it("does not apply additional edits that finish resolving after more typing", async () => {
    const view = editor();
    vi.mocked(api.completeCode).mockResolvedValue({
      items: [{ ...item, resolve: { session: "s", generation: 1, item: { label: "foo" } } }],
    });
    let finish!: (completion: CodeCompletion) => void;
    vi.mocked(api.resolveCompletion).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = await lspCompletionSource(
      "p",
      "a.ts",
    )(new CompletionContext(view.state, 6, true));
    apply(result, view);
    view.dispatch({ changes: { from: 6, insert: "x" } });
    finish({ ...item, additionalEdits: [{ from: 0, to: 0, insert: "import foo\n" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.state.doc.toString()).toBe("obj.fox");
  });

  it.each([
    [{ from: 4, to: 99, insert: "bad" }],
    [{ from: 3, to: 5, insert: "bad" }],
    [{ from: 4, to: 4, insert: "bad" }],
  ])("rejects invalid or overlapping edits: %j", async (...additionalEdits) => {
    const view = editor();
    vi.mocked(api.completeCode).mockResolvedValue({
      items: [{ ...item, additionalEdits: additionalEdits.flat() }],
    });
    const result = await lspCompletionSource(
      "p",
      "a.rs",
    )(new CompletionContext(view.state, 6, true));
    apply(result, view);
    expect(view.state.doc.toString()).toBe("obj.fo");
  });

  it("does not apply a stale completion after typing or while read-only", async () => {
    const view = editor();
    const result = await lspCompletionSource(
      "p",
      "a.go",
    )(new CompletionContext(view.state, 6, true));
    view.dispatch({ changes: { from: 6, insert: "x" } });
    apply(result, view);
    expect(view.state.doc.toString()).toBe("obj.fox");
    expect(
      await lspCompletionSource(
        "p",
        "a.go",
      )(new CompletionContext(editor("obj.fo", true).state, 6, true)),
    ).toBeNull();
    expect(api.completeCode).toHaveBeenCalledTimes(1);
  });

  it("places the cursor after a completion containing CRLF line endings", async () => {
    const view = editor();
    vi.mocked(api.completeCode).mockResolvedValue({
      items: [{ ...item, insertText: "foo\r\nbar" }],
    });
    const result = await lspCompletionSource(
      "p",
      "a.cs",
    )(new CompletionContext(view.state, 6, true));
    apply(result, view);
    expect(view.state.doc.toString()).toBe("obj.foo\nbar");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("passes punctuation as a trigger and ignores whitespace", async () => {
    const source = lspCompletionSource("p", "a.cpp");
    const state = editor("obj.").state;
    await source(new CompletionContext(state, 4, false));
    expect(api.completeCode).toHaveBeenLastCalledWith(
      "p",
      "a.cpp",
      "obj.",
      { line: 0, character: 4 },
      ".",
    );
    expect(await source(new CompletionContext(editor("obj. ").state, 5, false))).toBeNull();
    expect(api.completeCode).toHaveBeenCalledTimes(1);
  });

  it("keeps word completion available when no server is installed", async () => {
    const state = EditorState.create({
      doc: "myVariable myV",
      selection: { anchor: 14 },
      extensions: codeCompletion("p", "a.kt"),
    });
    const sources = state.languageDataAt<
      (context: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>
    >("autocomplete", 14);
    expect(state.languageDataAt("autocomplete", 14)[0]).toBe(sources[0]);
    vi.mocked(api.completeCode).mockRejectedValue({ code: "toolMissing" });
    const context = new CompletionContext(state, 14, true);
    expect(await sources[0]!(context)).toBeNull();
    expect(await sources[0]!(context)).toBeNull();
    expect(api.completeCode).toHaveBeenCalledTimes(1);
    const words = await sources[1]!(context);
    expect(words?.options.some((option) => option.label === "myVariable")).toBe(true);
  });

  it("discards a response whose query was aborted", async () => {
    let resolve!: (value: { items: CodeCompletion[] }) => void;
    vi.mocked(api.completeCode).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const context = new CompletionContext(editor().state, 6, true);
    const pending = lspCompletionSource("p", "a.ts")(context);
    Object.defineProperty(context, "aborted", { value: true });
    resolve({ items: [item] });
    expect(await pending).toBeNull();
  });
});
