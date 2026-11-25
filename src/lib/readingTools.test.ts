import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { expect, it, vi } from "vitest";
import { Prec } from "@codemirror/state";
import {
  extendSyntaxSelection,
  shrinkSyntaxSelection,
  stickyHeaders,
  stickyScroll,
  syntaxSelection,
} from "./readingTools";
import { resolveShortcuts, shortcutKeymap } from "./shortcuts";
import { matchLanguage } from "./language";

it("pins nested headers for the visible code line in JavaScript and Python", async () => {
  const javascript = await matchLanguage("main.js").description!.load();
  const state = EditorState.create({
    doc: "class Example {\n  run() {\n    if (ready) {\n      work();\n    }\n  }\n}",
    extensions: [javascript],
  });
  expect(stickyHeaders(state, 4)).toEqual([1, 2, 3]);
  expect(stickyHeaders(state, 1)).toEqual([]);
  const python = await matchLanguage("main.py").description!.load();
  const py = EditorState.create({
    doc: "class Example:\n    def run(self):\n        if ready:\n            work()\n        return True\n",
    extensions: [python],
  });
  expect(stickyHeaders(py, 4)).toEqual([1, 2, 3]);
  expect(stickyHeaders(py, 5)).toEqual([1, 2]);
});

it("paints pinned Python keywords and strings and updates them when the theme changes", async () => {
  const python = await matchLanguage("main.py").description!.load();
  const requests: NonNullable<Parameters<EditorView["requestMeasure"]>[0]>[] = [];
  const measure = vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation((request) => {
    if (request) requests.push(request);
  });
  const colors = new Compartment();
  const style = (name: string) =>
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.keyword, class: `keyword-${name}` },
        { tag: tags.string, class: `string-${name}` },
      ]),
    );
  const header = '    if data.get("vault_key_version"):';
  const view = new EditorView({
    parent: document.body,
    doc: `def check(data):\n${header}\n        return True\n`,
    extensions: [python, colors.of(style("dark")), stickyScroll],
  });
  try {
    vi.spyOn(view, "inView", "get").mockReturnValue(true);
    const block = view.lineBlockAt(view.state.doc.line(3).from);
    vi.spyOn(view, "lineBlockAtHeight").mockReturnValue(block);
    const flush = () => {
      for (const request of new Set(requests.splice(0))) request.write?.(request.read(view), view);
    };
    flush();
    let button = view.dom.querySelector(".cm-sticky-headers button:last-child");
    expect(button?.textContent).toBe(header);
    expect(button?.querySelector(".keyword-dark")?.textContent).toBe("if");
    expect(button?.querySelector(".string-dark")?.textContent).toBe('"vault_key_version"');

    view.dispatch({ effects: colors.reconfigure(style("light")) });
    flush();
    button = view.dom.querySelector(".cm-sticky-headers button:last-child");
    expect(button?.querySelector(".keyword-light")?.textContent).toBe("if");
    expect(button?.querySelector(".string-light")?.textContent).toBe('"vault_key_version"');
    expect(button?.querySelector(".keyword-dark")).toBeNull();
  } finally {
    view.destroy();
    measure.mockRestore();
  }
});

it("shrinks through the actual selection history and clears it after a manual move", async () => {
  const javascript = await matchLanguage("main.js").description!.load();
  const keys = resolveShortcuts({});
  const view = new EditorView({
    doc: "const result = call(value, other);",
    extensions: [
      javascript,
      syntaxSelection,
      Prec.high(
        shortcutKeymap(keys, {
          "extend-selection": extendSyntaxSelection,
          "shrink-selection": shrinkSyntaxSelection,
        }),
      ),
    ],
  });
  try {
    const press = (action: "extend-selection" | "shrink-selection") => {
      const parts = (keys[action] ?? "").split("+");
      return runScopeHandlers(
        view,
        new KeyboardEvent("keydown", {
          code: parts.at(-1)!,
          key: parts.at(-1)!,
          altKey: parts.includes("Alt"),
          ctrlKey: parts.includes("Ctrl"),
          metaKey: parts.includes("Mod"),
          shiftKey: parts.includes("Shift"),
        }),
        "editor",
      );
    };
    view.dispatch({ selection: { anchor: 21 } });
    const initial = view.state.selection;
    expect(press("extend-selection")).toBe(true);
    const expanded = view.state.selection;
    expect(view.state.sliceDoc(expanded.main.from, expanded.main.to)).toBe("value");
    expect(press("extend-selection")).toBe(true);
    expect(press("shrink-selection")).toBe(true);
    expect(view.state.selection.eq(expanded)).toBe(true);
    expect(press("shrink-selection")).toBe(true);
    expect(view.state.selection.eq(initial)).toBe(true);
    expect(press("extend-selection")).toBe(true);
    view.dispatch({ selection: { anchor: 0 } });
    expect(press("shrink-selection")).toBe(false);
  } finally {
    view.destroy();
  }
});
