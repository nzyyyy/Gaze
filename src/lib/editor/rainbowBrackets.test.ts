import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import { matchLanguage } from "./language";
import { rainbowBrackets } from "./rainbowBrackets";

let view: EditorView;
afterEach(() => view?.destroy());

async function editor(doc: string, filename = "test.ts") {
  const support = await matchLanguage(filename).description!.load();
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [support, rainbowBrackets, codeFolding()] }),
  });
}

function colors() {
  return Array.from(view.dom.querySelectorAll('[class*="cm-rainbow-bracket-"]'), (element) => ({
    text: element.textContent,
    level: Number(element.className.match(/cm-rainbow-bracket-(\d)/)![1]),
  }));
}

it.each([
  ["test.ts", "const data = call([{ value: 1 }]);", "([{}])"],
  ["test.json", '{"data": [{"value": 1}]}', "{[{}]}"],
  ["test.py", 'data = call([{"value": 1}])', "([{}])"],
  ["test.rs", "let data = call([Thing { value: 1 }]);", "([{}])"],
  ["test.cpp", "auto data = call((values[0]));", "(([]))"],
])("colors matching brackets by nesting in %s", async (filename, doc, brackets) => {
  await editor(doc, filename);
  expect(
    colors()
      .map((mark) => mark.text)
      .join(""),
  ).toBe(brackets);
  expect(colors().map((mark) => mark.level)).toEqual([0, 1, 2, 2, 1, 0]);
});

it("ignores brackets inside strings, comments, regular expressions and template text", async () => {
  await editor('const value = ["({})", /[(){}]/, `text ([])`]; // ({[]})\n/* ({[]}) */');
  expect(colors()).toEqual([
    { text: "[", level: 0 },
    { text: "]", level: 0 },
  ]);
});

it("updates nesting after edits and colors template interpolation", async () => {
  await editor("const value = `text ${call([])}`;");
  expect(colors().map((mark) => mark.level)).toEqual([0, 1, 2, 2, 1, 0]);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "call([])" } });
  expect(colors().map((mark) => mark.level)).toEqual([0, 1, 1, 0]);
});

it("keeps colors stable when there is an unfinished inner bracket", async () => {
  await editor("call([value");
  expect(colors()).toEqual([
    { text: "(", level: 0 },
    { text: "[", level: 1 },
  ]);
});

it("preserves nesting across folded ranges", async () => {
  await editor("call([1, 2], [3])");
  view.dispatch({ effects: foldEffect.of({ from: 5, to: 12 }) });
  expect(colors()).toEqual([
    { text: "(", level: 0 },
    { text: "[", level: 1 },
    { text: "]", level: 1 },
    { text: ")", level: 0 },
  ]);
});
