import {
  codeFolding,
  defaultHighlightStyle,
  foldEffect,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, type BlockInfo } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { afterEach, expect, it, vi } from "vitest";

import { changeBlocksField, setChangeBlocks } from "../git/editorChanges";
import { computeChangeBlocks } from "../git/lineDiff";
import { matchLanguage } from "./language";
import { minimap } from "./minimap";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function editor(
  doc = Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join("\n"),
  extensions: Extension[] = [],
) {
  const requests: NonNullable<Parameters<EditorView["requestMeasure"]>[0]>[] = [];
  vi.spyOn(EditorView.prototype, "requestMeasure").mockImplementation((request) => {
    if (request) requests.push(request);
  });
  const parent = document.createElement("div");
  document.body.append(parent);
  const compartment = new Compartment();
  const view = new EditorView({
    doc,
    extensions: [compartment.of(minimap), ...extensions],
    parent,
  });
  views.push(view);
  const map = parent.querySelector<HTMLElement>(".code-minimap")!;
  const height = vi.spyOn(map, "clientHeight", "get").mockReturnValue(208);
  vi.spyOn(map, "clientWidth", "get").mockReturnValue(110);
  vi.spyOn(view, "documentTop", "get").mockImplementation(() => -view.scrollDOM.scrollTop);
  vi.spyOn(view, "documentPadding", "get").mockReturnValue({ top: 0, bottom: 0 });
  vi.spyOn(view, "defaultLineHeight", "get").mockReturnValue(20);
  vi.spyOn(view, "contentHeight", "get").mockImplementation(() => view.state.doc.lines * 20);
  vi.spyOn(view.scrollDOM, "scrollHeight", "get").mockImplementation(
    () => view.state.doc.lines * 20,
  );
  vi.spyOn(view.scrollDOM, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 100));
  vi.spyOn(map, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 110, 208));
  vi.spyOn(view, "lineBlockAt").mockImplementation((position) => {
    const line = view.state.doc.lineAt(position);
    return {
      from: line.from,
      to: line.to,
      top: (line.number - 1) * 20,
      bottom: line.number * 20,
      height: 20,
    } as BlockInfo;
  });
  vi.spyOn(view, "lineBlockAtHeight").mockImplementation((y) => {
    const line = Math.max(1, Math.min(view.state.doc.lines, Math.floor(y / 20) + 1));
    return view.lineBlockAt(view.state.doc.line(line).from);
  });
  const measure = () => {
    const request = requests.at(-1)!;
    requests.length = 0;
    request.write?.(request.read(view), view);
  };
  const scroll = (top: number) => {
    view.scrollDOM.scrollTop = top;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    measure();
  };
  const pointer = (type: string, y: number) =>
    map.dispatchEvent(new MouseEvent(type, { clientY: y, button: 0, bubbles: true }));
  map.setPointerCapture = vi.fn();
  measure();
  return { view, map, measure, height, compartment, scroll, pointer };
}

it("uses proportional rows and keeps the viewport fully visible at both document ends", () => {
  const { view, map, scroll } = editor();
  expect(map.querySelector("path")!.getAttribute("d")).not.toBe("");
  expect(map).toHaveAttribute("aria-valuetext", "第 1–6 行，共 100 行");
  expect(map.querySelector(".code-minimap-viewport")).toHaveStyle({ top: "4px", height: "20px" });
  scroll(1900);
  expect(map).toHaveAttribute("aria-valuenow", "96");
  expect(map.querySelector(".code-minimap-viewport")).toHaveStyle({ top: "184px", height: "20px" });
  expect(map.querySelector("svg")).toHaveAttribute("viewBox", "0 0 102 200");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "   \n\t" } });
  scroll(0);
  expect(map.querySelector("path")).toBeNull();
  expect(map).toHaveAttribute("aria-valuemax", "2");
});

it("only moves the viewport when the full miniature already fits", () => {
  const { view, map, scroll } = editor("const value = 1;\n".repeat(19) + "last");
  const path = map.querySelector("path");
  const slice = vi.spyOn(view.state.doc, "sliceString");
  scroll(100);
  expect(map.querySelector("path")).toBe(path);
  expect(slice).not.toHaveBeenCalled();
});

it("uses the editor's syntax classes and refreshes when its highlighter changes", async () => {
  const language = await matchLanguage("test.ts").description!.load();
  const highlighter = new Compartment();
  const { view, map, measure } = editor('const greeting = "hello"; // comment', [
    language,
    highlighter.of(syntaxHighlighting(defaultHighlightStyle)),
  ]);
  const keyword = defaultHighlightStyle.style([tags.definitionKeyword])!;
  expect(Array.from(map.querySelectorAll("path"), (path) => path.getAttribute("class"))).toContain(
    keyword,
  );
  expect(map.querySelectorAll("path").length).toBeGreaterThan(2);
  const custom = HighlightStyle.define([{ tag: tags.keyword, color: "#ff0000" }]);
  view.dispatch({ effects: highlighter.reconfigure(syntaxHighlighting(custom)) });
  measure();
  expect(Array.from(map.querySelectorAll("path"), (path) => path.getAttribute("class"))).toContain(
    custom.style([tags.keyword]),
  );
});

it("bounds rendering work by the minimap window for large documents and long lines", () => {
  const { view, map, measure, height } = editor(("word ".repeat(100) + "\n").repeat(20_000));
  const slice = vi.spyOn(view.state.doc, "sliceString");
  height.mockReturnValue(108);
  view.scrollDOM.dispatchEvent(new Event("scroll"));
  measure();
  expect(slice).toHaveBeenCalledTimes(25);
  for (const [from, to] of slice.mock.calls) expect(to! - from).toBeLessThanOrEqual(204);
  expect(map.querySelector("path")!.getAttribute("d")!.length).toBeLessThan(150_000);
});

it("navigates by keyboard, click, wheel and stable dragging without changing text or selection", () => {
  const { view, map, measure, pointer } = editor();
  const doc = view.state.doc;
  const scrollIntoView = vi.spyOn(EditorView, "scrollIntoView");
  map.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(scrollIntoView).toHaveBeenLastCalledWith(doc.line(2).from, { y: "start", yMargin: 0 });
  map.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  expect(scrollIntoView).toHaveBeenLastCalledWith(doc.line(100).from, { y: "start", yMargin: 0 });
  map.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
  expect(scrollIntoView).toHaveBeenLastCalledWith(doc.line(6).from, { y: "start", yMargin: 0 });
  pointer("pointerdown", 108);
  expect(view.scrollDOM.scrollTop).toBe(470);
  pointer("pointerup", 108);
  measure();
  const thumbY =
    parseFloat((map.querySelector(".code-minimap-viewport") as HTMLElement).style.top) + 2;
  pointer("pointerdown", thumbY);
  expect(view.scrollDOM.scrollTop).toBe(470);
  pointer("pointermove", thumbY + 100);
  expect(view.scrollDOM.scrollTop).toBeGreaterThan(1000);
  measure();
  pointer("pointermove", thumbY + 100);
  expect(view.scrollDOM.scrollTop).toBeCloseTo(470 + (100 * 1900) / 180);
  pointer("pointermove", 10_000);
  expect(view.scrollDOM.scrollTop).toBe(1900);
  pointer("pointercancel", 10_000);
  pointer("pointermove", 0);
  expect(view.scrollDOM.scrollTop).toBe(1900);
  const wheel = new WheelEvent("wheel", { deltaY: -2, deltaMode: 1, cancelable: true });
  map.dispatchEvent(wheel);
  expect(view.scrollDOM.scrollTop).toBe(1860);
  expect(wheel.defaultPrevented).toBe(true);
  expect(view.state.doc).toBe(doc);
  expect(view.state.selection.main.anchor).toBe(0);
});

it("shows a delayed hover preview and cancels it on leaving, editing or disabling", () => {
  vi.useFakeTimers();
  const { view, map, pointer, compartment, measure } = editor();
  const preview = view.dom.querySelector<HTMLElement>(".code-minimap-preview")!;
  pointer("pointermove", 44);
  vi.advanceTimersByTime(299);
  expect(preview.hidden).toBe(true);
  vi.advanceTimersByTime(1);
  expect(preview.hidden).toBe(false);
  expect(preview.querySelector(".code-minimap-preview-header")).toHaveTextContent("第 11 行");
  expect(preview.querySelector(".is-target")).toHaveTextContent("const line10 = 10;");
  pointer("pointerleave", 44);
  expect(preview.hidden).toBe(true);
  pointer("pointermove", 84);
  view.dispatch({ changes: { from: 0, insert: "// draft\n" } });
  vi.advanceTimersByTime(300);
  expect(preview.hidden).toBe(true);
  pointer("pointermove", 84);
  view.dispatch({ effects: compartment.reconfigure([]) });
  vi.advanceTimersByTime(300);
  expect(map).not.toBeInTheDocument();
  expect(preview).not.toBeInTheDocument();
  expect(() => measure()).not.toThrow();
});

it("shows the caret, selection and Git marks in the miniature", () => {
  const { view, map, measure } = editor(undefined, [changeBlocksField]);
  const doc = view.state.doc;
  const blocks = computeChangeBlocks(
    doc.toString(),
    doc.toString().replace("line4 = 4", "line4 = 5"),
  );
  view.dispatch({
    selection: { anchor: doc.line(5).from, head: doc.line(8).from },
    effects: setChangeBlocks.of(blocks),
  });
  measure();
  expect(map.querySelector(".code-minimap-caret")).toHaveStyle({ top: "32px" });
  expect(map.querySelector(".code-minimap-selection")).toHaveStyle({ top: "20px", height: "16px" });
  expect(map.querySelector(".code-minimap-git-modified")).toHaveAttribute("y", "16");
});

it("shows source markup literally in the hover preview", () => {
  vi.useFakeTimers();
  const { view, pointer } = editor('<img src=x onerror="alert(1)">\n<script>alert(1)</script>');
  pointer("pointermove", 5);
  vi.advanceTimersByTime(300);
  const preview = view.dom.querySelector(".code-minimap-preview")!;
  expect(preview).toHaveTextContent('<img src=x onerror="alert(1)">');
  expect(preview.querySelector("img, script")).toBeNull();
});

it("uses visual rows for wrapped lines and skips folded source", () => {
  const { view, measure } = editor("abcdefghijklmno", [codeFolding()]);
  const block = { from: 0, to: 15, top: 0, bottom: 60, height: 60 } as BlockInfo;
  vi.spyOn(view, "contentHeight", "get").mockReturnValue(60);
  vi.spyOn(view, "lineWrapping", "get").mockReturnValue(true);
  vi.mocked(view.lineBlockAt).mockReturnValue(block);
  vi.mocked(view.lineBlockAtHeight).mockReturnValue(block);
  vi.spyOn(view, "posAtCoords").mockImplementation((coords) =>
    Math.min(15, Math.floor(coords.y / 20) * 5),
  );
  const slice = vi.spyOn(view.state.doc, "sliceString");
  view.dispatch({ effects: foldEffect.of({ from: 5, to: 10 }) });
  measure();
  expect(slice).toHaveBeenCalledWith(0, 5);
  expect(slice).toHaveBeenCalledWith(10, 15);
  expect(slice).not.toHaveBeenCalledWith(5, 10);
});
