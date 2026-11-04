import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarResizer } from "./SidebarResizer";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function setup(initialWidth = 292) {
  let available = 1024;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const width =
      this.className === "workspace"
        ? available
        : this.tagName === "ASIDE"
          ? Number.parseFloat(this.parentElement!.style.getPropertyValue("--sidebar-width")) ||
            initialWidth
          : 0;
    return {
      width,
      height: 600,
      x: 0,
      y: 0,
      top: 0,
      bottom: 600,
      left: 0,
      right: width,
      toJSON: () => ({}),
    };
  });
  const { container, unmount } = render(
    <div className="workspace">
      <aside id="workspace-sidebar" />
      <SidebarResizer />
      <main />
    </div>,
  );
  const separator = screen.getByRole("separator", { name: "调整项目栏宽度" });
  const workspace = container.firstElementChild as HTMLElement;
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
    separator,
    workspace,
    pointer,
    unmount,
    setAvailable: (width: number) => {
      available = width;
    },
  };
}

describe("SidebarResizer", () => {
  it("drags the divider and stops resizing when the pointer is released", () => {
    const { separator, workspace, pointer } = setup();
    pointer("pointerdown", 292);
    expect(separator).toHaveFocus();
    expect(separator.setPointerCapture).toHaveBeenCalledWith(1);
    expect(workspace).toHaveClass("is-resizing-sidebar");
    pointer("pointermove", 420);
    expect(workspace.style.getPropertyValue("--sidebar-width")).toBe("420px");
    expect(separator).toHaveAttribute("aria-valuenow", "420");
    pointer("pointerup", 420);
    expect(separator).not.toHaveFocus();
    expect(JSON.parse(localStorage.getItem("gaze:layout")!).sidebarWidth).toBe(420);
    pointer("pointermove", 500);
    expect(separator).toHaveAttribute("aria-valuenow", "420");
    expect(workspace).not.toHaveClass("is-resizing-sidebar");
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("bounds dragging, supports the keyboard and leaves room for the reader after window resizing", () => {
    const { separator, pointer, setAvailable } = setup(248);
    expect(separator).toHaveAttribute("aria-valuenow", "248");
    pointer("pointerdown", 248);
    pointer("pointermove", -500);
    expect(separator).toHaveAttribute("aria-valuenow", "200");
    pointer("pointermove", 2000);
    expect(separator).toHaveAttribute("aria-valuenow", "600");
    pointer("pointerup", 2000);
    setAvailable(700);
    fireEvent(window, new Event("resize"));
    expect(separator).toHaveAttribute("aria-valuemax", "380");
    expect(separator).toHaveAttribute("aria-valuenow", "380");
    separator.focus();
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveFocus();
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "200");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "220");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "380");
  });

  it("ignores secondary clicks and cleans up cancelled, interrupted and unmounted drags", () => {
    const { separator, workspace, pointer, unmount } = setup();
    pointer("pointerdown", 292, 2);
    expect(separator.setPointerCapture).not.toHaveBeenCalled();
    for (const event of ["pointercancel", "lostpointercapture"]) {
      pointer("pointerdown", 292);
      pointer(event, 292);
      pointer("pointermove", 400);
      expect(separator).toHaveAttribute("aria-valuenow", "292");
      expect(workspace).not.toHaveClass("is-resizing-sidebar");
    }
    pointer("pointerdown", 292);
    fireEvent(window, new Event("blur"));
    expect(workspace).not.toHaveClass("is-resizing-sidebar");
    pointer("pointerdown", 292);
    unmount();
    expect(workspace).not.toHaveClass("is-resizing-sidebar");
  });
});
