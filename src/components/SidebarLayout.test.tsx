import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readLayout, saveLayout } from "../lib/layout";
import { SidebarLayout, type SidebarLayoutHandle } from "./SidebarLayout";
import { Tooltip } from "./Tooltip";

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

function setup(collapsed = false) {
  saveLayout({ sidebarCollapsed: collapsed });
  const ref = createRef<SidebarLayoutHandle>();
  const onPreview = vi.fn();
  const { container, unmount } = render(
    <SidebarLayout
      ref={ref}
      onPreview={onPreview}
      rail={(expanded) => (
        <>
          <button
            data-sidebar-trigger=""
            data-tooltip="项目文件"
            aria-expanded={expanded}
            onClick={() => ref.current?.toggle()}
          >
            项目文件
          </button>
          <button onClick={() => ref.current?.open()}>搜索</button>
        </>
      )}
      panel={
        <>
          <input aria-label="文件筛选" defaultValue="保留目录状态" />
          <button onClick={() => ref.current?.hidePreview()}>打开文件</button>
        </>
      }
    >
      <main>
        <button>编辑区</button>
      </main>
    </SidebarLayout>,
  );
  const workspace = container.firstElementChild as HTMLElement;
  const panel = container.querySelector(".sidebar") as HTMLElement;
  const separator = container.querySelector(".sidebar-resizer") as HTMLElement;
  const trigger = screen.getByRole("button", { name: "项目文件" });
  separator.setPointerCapture = vi.fn();
  separator.hasPointerCapture = vi.fn(() => true);
  separator.releasePointerCapture = vi.fn();
  const pointer = (type: string, clientX: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(separator, event);
  };
  return { workspace, panel, separator, trigger, pointer, ref, onPreview, unmount };
}

describe("SidebarLayout", () => {
  it("does not focus the project icon or show its tooltip after dragging closed", () => {
    vi.useFakeTimers();
    render(<Tooltip />);
    const { workspace, trigger, pointer } = setup();
    pointer("pointerdown", 292);
    pointer("pointermove", 163);
    pointer("pointerup", 163);
    act(() => vi.advanceTimersByTime(600));
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();

    fireEvent.pointerOver(trigger);
    act(() => vi.advanceTimersByTime(450));
    expect(workspace).toHaveAttribute("data-sidebar", "floating");
    expect(screen.getByRole("tooltip")).toHaveTextContent("项目文件");
  });

  it("tracks narrow dragging, collapses below the threshold and remembers a usable width", () => {
    const { workspace, panel, separator, pointer } = setup();
    pointer("pointerdown", 292);
    pointer("pointermove", 164);
    expect(workspace).toHaveAttribute("data-sidebar", "docked");
    expect(workspace.style.getPropertyValue("--sidebar-width")).toBe("164px");
    pointer("pointermove", 163);
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    expect(panel).toHaveAttribute("inert");
    expect(separator).toHaveAttribute("aria-valuenow", "0");
    pointer("pointerup", 163);
    expect(readLayout()).toMatchObject({ sidebarWidth: 200, sidebarCollapsed: true });
    fireEvent.click(screen.getByRole("button", { name: "项目文件" }));
    expect(workspace).toHaveAttribute("data-sidebar", "docked");
    expect(panel).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("文件筛选")).toHaveValue("保留目录状态");
  });

  it("delays preview, bridges the icon-to-panel gap and hides after the pointer leaves", () => {
    vi.useFakeTimers();
    const { workspace, panel, trigger, onPreview } = setup(true);
    fireEvent.pointerOver(trigger);
    act(() => vi.advanceTimersByTime(159));
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    act(() => vi.advanceTimersByTime(1));
    expect(workspace).toHaveAttribute("data-sidebar", "floating");
    expect(onPreview).toHaveBeenCalledOnce();
    fireEvent.pointerOut(trigger);
    act(() => vi.advanceTimersByTime(80));
    fireEvent.pointerEnter(panel);
    act(() => vi.advanceTimersByTime(300));
    expect(workspace).toHaveAttribute("data-sidebar", "floating");
    act(() => screen.getByLabelText("文件筛选").focus());
    fireEvent.pointerLeave(panel);
    act(() => vi.advanceTimersByTime(260));
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    expect(trigger).toHaveFocus();
    act(() => vi.advanceTimersByTime(200));
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
  });

  it("pins preview and reopens the saved width when switching views", () => {
    vi.useFakeTimers();
    const { workspace, trigger } = setup(true);
    fireEvent.pointerOver(trigger);
    act(() => vi.advanceTimersByTime(160));
    fireEvent.click(screen.getByRole("button", { name: "固定项目栏" }));
    expect(workspace).toHaveAttribute("data-sidebar", "docked");
    expect(readLayout().sidebarCollapsed).toBe(false);
    fireEvent.click(trigger);
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(workspace).toHaveAttribute("data-sidebar", "docked");
    expect(readLayout().sidebarWidth).toBe(292);
  });

  it("supports keyboard preview and Escape, and closes on a file selection or outside click", () => {
    vi.useFakeTimers();
    const { workspace, trigger } = setup(true);
    act(() => trigger.focus());
    act(() => vi.advanceTimersByTime(160));
    expect(workspace).toHaveAttribute("data-sidebar", "floating");
    act(() => screen.getByLabelText("文件筛选").focus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    expect(trigger).toHaveFocus();
    act(() => vi.advanceTimersByTime(200));
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    fireEvent.pointerOver(trigger);
    act(() => vi.advanceTimersByTime(160));
    fireEvent.click(screen.getByRole("button", { name: "打开文件" }));
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    fireEvent.pointerOver(trigger);
    act(() => vi.advanceTimersByTime(160));
    fireEvent.pointerDown(screen.getByRole("button", { name: "编辑区" }));
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
  });

  it("collapses with the keyboard, restores settings changes and cancels pending hover on unmount", () => {
    vi.useFakeTimers();
    const { workspace, separator, trigger, onPreview, unmount } = setup();
    fireEvent.keyDown(separator, { key: "Home" });
    expect(workspace).toHaveAttribute("data-sidebar", "collapsed");
    expect(trigger).toHaveFocus();
    expect(readLayout().sidebarCollapsed).toBe(true);
    act(() => saveLayout({ sidebarCollapsed: false, sidebarWidth: 320 }));
    expect(workspace).toHaveAttribute("data-sidebar", "docked");
    expect(separator).toHaveAttribute("aria-valuenow", "320");
    fireEvent.click(trigger);
    fireEvent.pointerOver(trigger);
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(onPreview).not.toHaveBeenCalled();
  });
});
