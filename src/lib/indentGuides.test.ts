import { codeFolding, foldEffect } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, type BlockInfo } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { indentGuides } from "./indentGuides";
import { matchLanguage } from "./language";

let view: EditorView;
afterEach(() => view?.destroy());

function editor(doc: string, extensions: Extension[] = [], wrappedLine = 0) {
  const requests: NonNullable<Parameters<EditorView["requestMeasure"]>[0]>[] = [];
  vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation((request) => {
    if (request) requests.push(request);
  });
  const getBlocks = Object.getOwnPropertyDescriptor(
    EditorView.prototype,
    "viewportLineBlocks",
  )!.get!;
  view = new EditorView({
    parent: document.body,
    doc,
    extensions: [
      indentGuides,
      EditorView.theme({ ".cm-line": { paddingLeft: "12px" } }),
      ...extensions,
    ],
  });
  vi.spyOn(view, "inView", "get").mockReturnValue(true);
  vi.spyOn(view, "defaultLineHeight", "get").mockReturnValue(20);
  vi.spyOn(view, "defaultCharacterWidth", "get").mockReturnValue(10);
  vi.spyOn(view, "documentPadding", "get").mockReturnValue({ top: 10, bottom: 0 });
  vi.spyOn(view.contentDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 0, 500, 200));
  vi.spyOn(view, "viewportLineBlocks", "get").mockImplementation(() => {
    let top = 0;
    return (getBlocks.call(view) as BlockInfo[]).map((block) => {
      const height = view.state.doc.lineAt(block.from).number === wrappedLine ? 40 : 20;
      const measured = {
        ...block,
        to: block.to,
        type: block.type,
        top,
        height,
        bottom: top + height,
      };
      top += height;
      return measured as BlockInfo;
    });
  });
  return () => {
    for (const request of new Set(requests.splice(0))) request.write?.(request.read(view), view);
    return Array.from(
      view.dom.querySelectorAll<HTMLElement>(".cm-indent-guides > div"),
      (guide): [number, number, number, boolean] => [
        parseFloat(guide.style.left),
        parseFloat(guide.style.top),
        parseFloat(guide.style.height),
        guide.classList.contains("cm-indent-guide-active"),
      ],
    ).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  };
}

function doubleClick(clientX: number, clientY: number, pos: number) {
  vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
  vi.spyOn(view, "posAndSideAtCoords").mockReturnValue({ pos, assoc: 1 });
  view.contentDOM.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 2, clientX, clientY }),
  );
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
  const { from, to } = view.state.selection.main;
  expect(view.state.selection.ranges).toHaveLength(1);
  return view.state.sliceDoc(from, to);
}

it("double-clicks either guide to select just that nested Python block", async () => {
  const python = await matchLanguage("demo.py").description!.load();
  const guides = editor(
    [
      "def run():",
      "    config = {",
      '        "enabled": True,',
      "    }",
      "    try:",
      "        if config:",
      "            use(config)",
      "        cleanup()",
      "    except Error:",
      "        recover()",
    ].join("\n"),
    [python],
  );
  guides();
  const line = view.state.doc.line(7);
  expect(doubleClick(132, 142, line.from + 8)).toBe(
    "        if config:\n            use(config)\n",
  );
  expect(doubleClick(92, 142, line.from + 4)).toBe(
    "    try:\n        if config:\n            use(config)\n        cleanup()\n",
  );
  expect(doubleClick(161, 142, line.from + 14)).toBe("use");
});

it("includes the matching closing delimiter on a guide double-click", async () => {
  const java = await matchLanguage("Demo.java").description!.load();
  const guides = editor(
    "class Demo {\n    void call() {\n        work();\n    }  \n    int sibling;\n}",
    [java],
  );
  guides();
  expect(doubleClick(92, 60, view.state.doc.line(3).from + 4)).toBe(
    "    void call() {\n        work();\n    }  \n",
  );
});

it("hits a guide inside a tab when the nearest text offset is after the tab", () => {
  const guides = editor("root\n  block\n\tchild", [EditorState.tabSize.of(4)]);
  guides();
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 92, right: 92, top: 50, bottom: 70 });
  expect(doubleClick(72, 60, view.state.doc.line(3).from + 1)).toBe("  block\n\tchild");
});

it("draws the Java block and continuation guides from their actual columns", async () => {
  const java = await matchLanguage("EditorTips.java").description!.load();
  const guides = editor(
    [
      "class EditorTips {",
      "    void examples() {",
      "// A comment stays inside the method.",
      '        String value = "a" +',
      '                "b" +',
      '                "c";',
      "",
      "        use(value);",
      "",
      "    }",
      "}",
    ].join("\n"),
    [java],
  );
  expect(guides()).toEqual([
    [91, 50, 140, false],
    [131, 90, 40, false],
  ]);
});

it("uses tab stops, crosses Python comments and refreshes when the document or tab width changes", async () => {
  const python = await matchLanguage("demo.py").description!.load();
  const tabs = new Compartment();
  const guides = editor(
    "def demo():\n\tif ready:\n \t\twork()\n# comment\n\t\twork()\n\n\tfinish()",
    [python, tabs.of(EditorState.tabSize.of(4))],
  );
  expect(guides()).toEqual([[91, 50, 60, false]]);

  view.dispatch({ effects: tabs.reconfigure(EditorState.tabSize.of(6)) });
  expect(guides()).toEqual([[111, 50, 60, false]]);

  view.dispatch({ changes: { from: view.state.doc.line(7).from, insert: "\t" } });
  expect(guides()).toEqual([[111, 50, 100, false]]);
});

it("highlights only the guide at the caret column and skips wrapped rows for other guides", () => {
  const guides = editor(
    "root\n    body\n        wrap here\n        more\nend",
    [EditorView.lineWrapping],
    3,
  );
  expect(guides()).toEqual([
    [91, 50, 20, false],
    [91, 90, 20, false],
  ]);

  const wrapped = view.state.doc.line(3);
  view.dispatch({ selection: { anchor: wrapped.from + 4 } });
  expect(guides()).toEqual([[91, 50, 60, true]]);

  view.dispatch({ selection: { anchor: wrapped.from + 5 } });
  expect(guides()).toEqual([
    [91, 50, 20, false],
    [91, 90, 20, false],
  ]);
});

it("stops painting folded lines and realigns after a theme geometry change", () => {
  const theme = new Compartment();
  const guides = editor("root\n    body\n        inner\n        more\nend", [
    codeFolding(),
    theme.of([]),
  ]);
  expect(guides()).toEqual([[91, 50, 40, false]]);

  vi.spyOn(view, "defaultCharacterWidth", "get").mockReturnValue(12);
  view.dispatch({ effects: theme.reconfigure(EditorView.theme({}, { dark: true })) });
  expect(guides()).toEqual([[99, 50, 40, false]]);

  view.dispatch({
    effects: foldEffect.of({ from: view.state.doc.line(2).to, to: view.state.doc.line(4).to }),
  });
  expect(guides()).toEqual([]);
});
