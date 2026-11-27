import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { useAutoHideScrollbars } from "./useAutoHideScrollbars";

afterEach(() => vi.useRealTimers());

it.each([100, 1200])(
  "refreshes the scrollbar's host style after repeated tab switches (%s ms away)",
  (away) => {
    vi.useFakeTimers();
    function Pages() {
      useAutoHideScrollbars();
      const [page, setPage] = useState("A");
      return (
        <>
          <button onClick={() => setPage("A")}>Open A</button>
          <button onClick={() => setPage("B")}>Open B</button>
          <section hidden={page !== "A"}>
            <div data-testid="a" style={{ overflowY: "auto" }}>
              <span>A content</span>
            </div>
          </section>
          <section hidden={page !== "B"}>
            <div data-testid="b" style={{ overflowY: "auto" }}>
              <span>B content</span>
            </div>
          </section>
        </>
      );
    }
    const { getByTestId, getByRole, unmount } = render(<Pages />);
    const a = getByTestId("a");
    const b = getByTestId("b");
    for (const pane of [a, b])
      Object.defineProperties(pane, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 1000 },
      });
    for (let visit = 0; visit < 3; visit++) {
      fireEvent.wheel(a.firstElementChild!, { deltaY: 50 });
      expect(a.style.getPropertyValue("--gaze-scrollbar-thumb")).toBe("var(--text-faint)");
      fireEvent.click(getByRole("button", { name: "Open B" }));
      act(() => vi.advanceTimersByTime(away));
      fireEvent.scroll(b);
      fireEvent.click(getByRole("button", { name: "Open A" }));
      expect(getByTestId("a")).toBe(a);
      fireEvent.scroll(a);
      expect(a.style.getPropertyValue("--gaze-scrollbar-thumb")).toBe("var(--text-faint)");
      act(() => vi.advanceTimersByTime(899));
      expect(a.style.getPropertyValue("--gaze-scrollbar-thumb")).toBe("var(--text-faint)");
      act(() => vi.advanceTimersByTime(1));
      expect(a.style.getPropertyValue("--gaze-scrollbar-thumb")).toBe("");
    }
    fireEvent.scroll(a);
    unmount();
    expect(a.style.getPropertyValue("--gaze-scrollbar-thumb")).toBe("");
  },
);

function scrollPane(horizontal = false) {
  const { getByTestId } = render(
    <div
      data-testid="pane"
      style={{
        overflowY: horizontal ? "hidden" : "auto",
        overflowX: horizontal ? "auto" : "hidden",
      }}
    >
      <span data-testid="content">content</span>
    </div>,
  );
  const pane = getByTestId("pane");
  const content = getByTestId("content");
  Object.defineProperties(pane, {
    clientHeight: { value: 100 },
    scrollHeight: { value: horizontal ? 100 : 1000 },
    clientWidth: { value: 200 },
    scrollWidth: { value: horizontal ? 800 : 200 },
  });
  pane.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 210,
    bottom: 120,
    width: 200,
    height: 100,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  });
  const pointer = (
    type: string,
    x = horizontal ? 100 : 205,
    y = horizontal ? 115 : 50,
    button = 0,
  ) => {
    fireEvent(content, new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }));
  };
  return { pane, content, pointer };
}

it.each([0, 900])(
  "reveals the scrollbar on wheel input even at scroll boundary %s",
  (scrollTop) => {
    vi.useFakeTimers();
    renderHook(useAutoHideScrollbars);
    const { pane, content } = scrollPane();
    pane.scrollTop = scrollTop;
    fireEvent.wheel(content, { deltaY: scrollTop === 0 ? -50 : 50 });
    expect(pane.scrollTop).toBe(scrollTop);
    expect(pane).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
    act(() => vi.advanceTimersByTime(900));
    expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
    pane.style.overflowY = "hidden";
    fireEvent.wheel(content, { deltaY: 50 });
    expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  },
);

it.each([false, true])("reveals the scrollbar near its edge, horizontal: %s", (horizontal) => {
  vi.useFakeTimers();
  renderHook(useAutoHideScrollbars);
  const { pane, pointer } = scrollPane(horizontal);
  pointer("pointermove", 100, 50);
  expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  pointer("pointermove");
  expect(pane).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  act(() => vi.advanceTimersByTime(900));
  expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  pointer("pointermove", 300, 200);
  expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
});

it.each(["pointerup", "pointercancel", "blur"])(
  "keeps the scrollbar visible during a paused drag until %s",
  (release) => {
    vi.useFakeTimers();
    renderHook(useAutoHideScrollbars);
    const { pane, pointer } = scrollPane();
    pointer("pointerdown");
    act(() => vi.advanceTimersByTime(2000));
    expect(pane).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
    fireEvent(window, new Event(release));
    act(() => vi.advanceTimersByTime(899));
    expect(pane).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
    act(() => vi.advanceTimersByTime(1));
    expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  },
);

it("cleans up an active scrollbar drag and its input listeners on unmount", () => {
  vi.useFakeTimers();
  const { unmount } = renderHook(useAutoHideScrollbars);
  const { pane, content, pointer } = scrollPane();
  pointer("pointerdown");
  act(() => vi.advanceTimersByTime(2000));
  unmount();
  expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.wheel(content, { deltaY: 50 });
  pointer("pointermove");
  expect(pane).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
});

it("shows a scrollbar only while its own pane is scrolling, including nested scroll events", () => {
  vi.useFakeTimers();
  renderHook(useAutoHideScrollbars);
  const { getByTestId } = render(
    <div>
      <div data-testid="left" />
      <div data-testid="right" />
    </div>,
  );
  const left = getByTestId("left");
  const right = getByTestId("right");
  expect(left).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  fireEvent.scroll(left);
  expect(left).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  expect(right).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  act(() => vi.advanceTimersByTime(500));
  fireEvent.scroll(right);
  act(() => vi.advanceTimersByTime(400));
  expect(left).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  expect(right).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  fireEvent.scroll(right);
  act(() => vi.advanceTimersByTime(899));
  expect(right).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  act(() => vi.advanceTimersByTime(1));
  expect(right).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
});

it("clears timers, visibility and the scroll listener on unmount", () => {
  vi.useFakeTimers();
  const { unmount } = renderHook(useAutoHideScrollbars);
  const { container } = render(<div />);
  const element = container.firstElementChild!;
  fireEvent.scroll(element);
  expect(element).toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  unmount();
  expect(element).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
  expect(vi.getTimerCount()).toBe(0);
  fireEvent.scroll(element);
  expect(element).not.toHaveStyle("--gaze-scrollbar-thumb: var(--text-faint)");
});
