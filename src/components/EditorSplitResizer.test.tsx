import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { saveLayout } from "../lib/layout";
import { EditorSplitResizer } from "./EditorSplitResizer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function setup(props: Parameters<typeof EditorSplitResizer>[0] = {}) {
  let width = 1006;
  let observeResize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observeResize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0,
    y: 0,
    left: 0,
    right: width,
    top: 0,
    bottom: 600,
    width,
    height: 600,
    toJSON: () => ({}),
  }));
  const { container, unmount } = render(
    <div className="editor-panes">
      <EditorSplitResizer {...props} />
    </div>,
  );
  const panes = container.firstElementChild as HTMLElement;
  const separator = screen.getByRole("separator", { name: props.label ?? "调整左右编辑区宽度" });
  let captured = false;
  separator.setPointerCapture = vi.fn(() => {
    captured = true;
  });
  separator.hasPointerCapture = vi.fn(() => captured);
  separator.releasePointerCapture = vi.fn(() => {
    captured = false;
  });
  const pointer = (type: string, clientX: number, button = 0) => {
    const event = new MouseEvent(type, { bubbles: true, clientX, button });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(separator, event);
  };
  return {
    panes,
    separator,
    pointer,
    unmount,
    disconnect,
    setWidth: (next: number) => {
      width = next;
      act(observeResize);
    },
  };
}

it("resizes both columns and persists the ratio on release", () => {
  const { panes, separator, pointer } = setup();
  pointer("pointerdown", 500);
  expect(separator).toHaveFocus();
  pointer("pointermove", 700);
  expect(separator).toHaveAttribute("aria-valuenow", "70");
  expect(panes.style.getPropertyValue("--editor-primary-size")).toBe("0.7fr");
  expect(parseFloat(panes.style.getPropertyValue("--editor-secondary-size"))).toBeCloseTo(0.3);
  pointer("pointerup", 700);
  expect(separator).not.toHaveFocus();
  expect(JSON.parse(localStorage.getItem("gaze:layout")!).editorSplitRatio).toBeCloseTo(0.7);
  expect(panes).not.toHaveClass("is-resizing-editor");
  expect(separator.releasePointerCapture).toHaveBeenCalledWith(1);
  pointer("pointermove", 800);
  expect(separator).toHaveAttribute("aria-valuenow", "70");
});

it("restores layout, enforces pane widths and supports keyboard resizing", () => {
  saveLayout({ editorSplitRatio: 0.65 });
  const { separator, pointer, setWidth } = setup();
  expect(separator).toHaveAttribute("aria-valuenow", "65");
  pointer("pointerdown", 650);
  pointer("pointermove", -1000);
  expect(separator).toHaveAttribute("aria-valuenow", "24");
  pointer("pointermove", 2000);
  expect(separator).toHaveAttribute("aria-valuenow", "76");
  pointer("pointerup", 2000);
  separator.focus();
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator).toHaveFocus();
  expect(separator).toHaveAttribute("aria-valuenow", "71");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator).toHaveAttribute("aria-valuenow", "76");
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator).toHaveAttribute("aria-valuenow", "24");
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator).toHaveAttribute("aria-valuenow", "76");
  setWidth(606);
  expect(separator).toHaveAttribute("aria-valuenow", "60");
  expect(separator).toHaveAttribute("aria-valuemin", "40");
  setWidth(406);
  expect(separator).toHaveAttribute("aria-valuenow", "50");
  act(() => saveLayout({ editorSplitRatio: 0.5 }));
  expect(separator).toHaveAttribute("aria-valuenow", "50");
});

it("resizes and restores the history panels without changing the editor split", () => {
  saveLayout({ editorSplitRatio: 0.65, gitHistorySplitRatio: 0.3 });
  const { separator, pointer } = setup({
    layoutKey: "gitHistorySplitRatio",
    label: "调整提交列表与仓库图宽度",
  });
  expect(separator).toHaveAttribute("aria-valuenow", "30");
  pointer("pointerdown", 300);
  pointer("pointermove", 500);
  pointer("pointerup", 500);
  expect(separator).toHaveAttribute("aria-valuenow", "50");
  expect(JSON.parse(localStorage.getItem("gaze:layout")!)).toMatchObject({
    editorSplitRatio: 0.65,
    gitHistorySplitRatio: 0.5,
  });
  act(() => saveLayout({ gitHistorySplitRatio: 0.4 }));
  expect(separator).toHaveAttribute("aria-valuenow", "40");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(JSON.parse(localStorage.getItem("gaze:layout")!).gitHistorySplitRatio).toBeCloseTo(0.45);
});

it.each(["pointercancel", "lostpointercapture", "blur", "unmount"])(
  "cleans up a drag after %s",
  (type) => {
    const { panes, pointer, unmount, disconnect } = setup();
    pointer("pointerdown", 500, 2);
    expect(panes).not.toHaveClass("is-resizing-editor");
    pointer("pointerdown", 500);
    expect(panes).toHaveClass("is-resizing-editor");
    if (type === "unmount") {
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } else if (type === "blur") fireEvent(window, new Event("blur"));
    else pointer(type, 500);
    expect(panes).not.toHaveClass("is-resizing-editor");
  },
);
