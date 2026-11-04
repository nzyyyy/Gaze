import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabBar } from "./TabBar";
import type { EditorTab } from "./CodeReader";

const nativeApi = vi.hoisted(() => ({ copyEntryPath: vi.fn(), revealEntry: vi.fn() }));
vi.mock("../lib/api", () => ({ api: nativeApi }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tabs: EditorTab[] = [
  {
    key: "p1\u0000a.ts",
    projectId: "p1",
    projectName: "One",
    path: "src/a.ts",
    name: "a.ts",
  },
  {
    key: "p2\u0000b.ts",
    projectId: "p2",
    projectName: "Two",
    path: "src/b.ts",
    name: "b.ts",
  },
];

function setupDrag() {
  const allTabs = [...tabs, { ...tabs[0]!, key: "third", name: "c.ts" }];
  const onReorder = vi.fn();
  const onActivate = vi.fn();
  const props = {
    tabs: allTabs,
    activeKey: tabs[0]!.key,
    dirtyKeys: new Set<string>(),
    onActivate,
    onClose: vi.fn(),
    onCloseTabs: vi.fn(),
    onNotice: vi.fn(),
    onReorder,
  };
  const { rerender } = render(<TabBar {...props} />);
  const strip = screen.getByRole("tablist");
  const buttons = screen.getAllByRole("tab");
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 600 },
    scrollWidth: { configurable: true, value: 540 },
  });
  for (const button of buttons) {
    const element = button.parentElement!;
    Object.defineProperties(element, {
      offsetLeft: { get: () => Array.from(strip.querySelectorAll(".tab")).indexOf(element) * 180 },
      offsetWidth: { value: 180 },
    });
  }
  let captured = false;
  strip.setPointerCapture = vi.fn(() => {
    captured = true;
  });
  strip.hasPointerCapture = vi.fn(() => captured);
  strip.releasePointerCapture = vi.fn(() => {
    captured = false;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const index = Array.from(strip.querySelectorAll(".tab")).indexOf(this);
    const shift = this.style.transform.includes("--tab-drag-offset")
      ? parseFloat(strip.style.getPropertyValue("--tab-drag-offset")) || 0
      : Number(this.style.transform.match(/translateX\(([-\d.]+)px\)/)?.[1] ?? 0);
    const left = index < 0 ? 0 : index * 180 - strip.scrollLeft + shift;
    const width = index < 0 ? 600 : 180;
    return {
      x: left,
      y: 0,
      left,
      right: left + width,
      width,
      height: 37,
      top: 0,
      bottom: 37,
      toJSON: () => ({}),
    };
  });
  const pointer = (type: string, clientX: number, target = strip, clientY = 18, button = 0) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(target, event);
  };
  return {
    allTabs,
    onReorder,
    onActivate,
    strip,
    buttons,
    pointer,
    rerenderTabs: (next: EditorTab[]) => rerender(<TabBar {...props} tabs={next} />),
  };
}

it("shows navigation for clipped tabs and scrolls to a whole tab boundary", async () => {
  const { strip } = setupDrag();
  Object.defineProperty(strip, "clientWidth", { value: 300 });
  strip.scrollLeft = 90;
  strip.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    const left = typeof options === "number" ? options : (options?.left ?? 0);
    strip.scrollLeft = Math.min(240, Math.max(0, left));
    fireEvent.scroll(strip);
  });
  fireEvent.scroll(strip);
  const left = screen.getByRole("button", { name: "向左滚动标签页" });
  const right = screen.getByRole("button", { name: "向右滚动标签页" });
  expect(strip.contains(left)).toBe(false);
  await userEvent.click(left);
  expect(strip.scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: "smooth" });
  expect(left).toBeDisabled();
  await userEvent.click(right);
  expect(strip.scrollTo).toHaveBeenLastCalledWith({ left: 180, behavior: "smooth" });
  strip.scrollLeft = 240;
  fireEvent.scroll(strip);
  expect(right).toBeDisabled();
});

it.each([false, true])(
  "previews neighboring tabs and settles the dropped tab, reduced motion: %s",
  (reduced) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reduced })),
    );
    const { strip, allTabs, buttons, pointer, onReorder, rerenderTabs } = setupDrag();
    const source = buttons[0]!.parentElement!;
    source.animate = vi.fn();
    onReorder.mockImplementation(() => rerenderTabs([allTabs[1]!, allTabs[0]!, allTabs[2]!]));
    pointer("pointerdown", 80, buttons[0]);
    pointer("pointermove", 430);
    expect(strip.style.getPropertyValue("--tab-drag-offset")).toBe("350px");
    expect(buttons[1]!.parentElement!.style.transform).toBe("translateX(-180px)");
    expect(buttons[2]!.parentElement!.style.transform).toBe("");
    expect(onReorder).not.toHaveBeenCalled();
    pointer("pointerup", 430);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "b.ts",
      "a.ts",
      "c.ts",
    ]);
    expect(source.style.transform).toBe("");
    if (reduced) expect(source.animate).not.toHaveBeenCalled();
    else
      expect(source.animate).toHaveBeenCalledWith(
        [{ transform: "translateX(170px)" }, { transform: "translateX(0)" }],
        expect.objectContaining({ duration: 160 }),
      );
  },
);

it("drags tabs to either end with a drop indicator and keeps clicks working afterwards", async () => {
  const { allTabs, onReorder, onActivate, strip, buttons, pointer } = setupDrag();
  pointer("pointerdown", 80, buttons[0]);
  pointer("pointermove", 550);
  expect(strip.setPointerCapture).toHaveBeenCalledWith(1);
  expect(strip.style.getPropertyValue("--tab-drag-offset")).toBe("360px");
  expect(buttons[2]!.parentElement).toHaveAttribute("data-drop", "after");
  pointer("pointerup", 550);
  expect(onReorder).toHaveBeenLastCalledWith(allTabs[0]!.key, allTabs[2]!.key, true);
  expect(strip.releasePointerCapture).toHaveBeenCalledWith(1);
  fireEvent.click(buttons[0]!, { detail: 1 });
  expect(onActivate).not.toHaveBeenCalled();
  await userEvent.click(buttons[0]!);
  expect(onActivate).toHaveBeenCalledWith(allTabs[0]);
  pointer("pointerdown", 450, buttons[2]);
  pointer("pointermove", 10);
  expect(buttons[0]!.parentElement).toHaveAttribute("data-drop", "before");
  pointer("pointerup", 10);
  expect(onReorder).toHaveBeenLastCalledWith(allTabs[2]!.key, allTabs[0]!.key, false);
});

it("cancels the preview if its dragged tab is closed", () => {
  const { allTabs, strip, buttons, pointer, onReorder, rerenderTabs } = setupDrag();
  pointer("pointerdown", 80, buttons[0]);
  pointer("pointermove", 430);
  rerenderTabs(allTabs.slice(1));
  expect(strip).not.toHaveClass("is-dragging");
  pointer("pointerup", 430);
  expect(onReorder).not.toHaveBeenCalled();
  rerenderTabs([]);
  fireEvent(window, new Event("blur"));
  expect(screen.queryByRole("tablist")).toBeNull();
});

it.each(["pointercancel", "lostpointercapture", "blur", "outside"])(
  "cancels tab reordering on %s",
  (type) => {
    const { onReorder, strip, buttons, pointer } = setupDrag();
    pointer("pointerdown", 80, buttons[0]);
    pointer("pointermove", 450);
    if (type === "outside") pointer("pointerup", 450, strip, 100);
    else {
      if (type === "blur") fireEvent(window, new Event("blur"));
      else pointer(type, 450);
      pointer("pointerup", 450);
    }
    expect(onReorder).not.toHaveBeenCalled();
    expect(strip).not.toHaveClass("is-dragging");
    expect(strip.querySelector("[data-drop]")).toBeNull();
  },
);

it("ignores small movements and secondary clicks and offers keyboard reordering", () => {
  const { allTabs, onReorder, onActivate, strip, buttons, pointer } = setupDrag();
  pointer("pointerdown", 80, buttons[0]);
  pointer("pointermove", 83);
  pointer("pointerup", 83);
  expect(strip.setPointerCapture).not.toHaveBeenCalled();
  fireEvent.click(buttons[0]!, { detail: 1 });
  expect(onActivate).toHaveBeenCalledWith(allTabs[0]);
  pointer("pointerdown", 80, buttons[0], 18, 2);
  pointer("pointermove", 450);
  pointer("pointerup", 450);
  expect(onReorder).not.toHaveBeenCalled();
  fireEvent.keyDown(buttons[0]!, { key: "ArrowLeft", altKey: true, shiftKey: true });
  expect(onReorder).not.toHaveBeenCalled();
  fireEvent.keyDown(buttons[0]!, { key: "ArrowRight", altKey: true, shiftKey: true });
  expect(onReorder).toHaveBeenLastCalledWith(allTabs[0]!.key, allTabs[1]!.key, true);
  fireEvent.keyDown(buttons[2]!, { key: "ArrowLeft", altKey: true, shiftKey: true });
  expect(onReorder).toHaveBeenLastCalledWith(allTabs[2]!.key, allTabs[1]!.key, false);
  expect(fireEvent.dragStart(buttons[0]!)).toBe(false);
});

describe("TabBar", () => {
  it("reveals the active tab on mount, activation, insertion and closure", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const props = {
      dirtyKeys: new Set<string>(),
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onCloseTabs: vi.fn(),
      onNotice: vi.fn(),
    };
    const third = { ...tabs[0]!, key: "third", name: "c.ts" };
    const { rerender } = render(<TabBar {...props} tabs={tabs} activeKey={tabs[0]!.key} />);
    const expectRevealed = (name: string) => {
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        behavior: "instant",
        block: "nearest",
        inline: "nearest",
      });
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole("tab", { name }).parentElement);
      scrollIntoView.mockClear();
    };
    expectRevealed("a.ts");

    rerender(<TabBar {...props} tabs={[...tabs, third]} activeKey={third.key} />);
    expectRevealed("c.ts");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);

    rerender(<TabBar {...props} tabs={[...tabs, third]} activeKey={tabs[0]!.key} />);
    expectRevealed("a.ts");
    rerender(<TabBar {...props} tabs={tabs.slice(1)} activeKey={tabs[1]!.key} />);
    expectRevealed("b.ts");
    rerender(<TabBar {...props} tabs={tabs} activeKey={tabs[1]!.key} />);
    expectRevealed("b.ts");

    rerender(<TabBar {...props} tabs={[]} activeKey={null} />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("activates and closes the requested tab", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <TabBar
        tabs={tabs}
        activeKey={tabs[0]!.key}
        dirtyKeys={new Set()}
        onActivate={onActivate}
        onClose={onClose}
        onCloseTabs={vi.fn()}
        onNotice={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "b.ts" }));
    expect(onActivate).toHaveBeenCalledWith(tabs[1]);

    await user.click(screen.getByRole("button", { name: "关闭 a.ts" }));
    expect(onClose).toHaveBeenCalledWith(tabs[0]);
  });

  it("roves focus with keyboard activation and restores focus after tab removal", () => {
    const onActivate = vi.fn();
    const onReorder = vi.fn();
    const props = {
      tabs,
      dirtyKeys: new Set<string>(),
      onActivate,
      onClose: vi.fn(),
      onCloseTabs: vi.fn(),
      onNotice: vi.fn(),
      onReorder,
    };
    const { rerender } = render(<TabBar {...props} activeKey={tabs[0]!.key} />);
    const first = screen.getByRole("tab", { name: "a.ts" });
    const second = screen.getByRole("tab", { name: "b.ts" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenCalledWith(tabs[0]!.key, tabs[1]!.key, true);
    expect(onActivate).not.toHaveBeenCalled();
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith(tabs[1]);
    rerender(<TabBar {...props} activeKey={tabs[1]!.key} />);
    expect(first).toHaveAttribute("tabindex", "-1");
    expect(second).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(second, { key: "Home" });
    expect(first).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith(tabs[0]);
    rerender(<TabBar {...props} activeKey={tabs[0]!.key} />);
    fireEvent.keyDown(first, { key: "End" });
    expect(second).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith(tabs[1]);
    rerender(<TabBar {...props} activeKey={tabs[1]!.key} />);

    fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(first).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith(tabs[0]);
    rerender(<TabBar {...props} activeKey={tabs[0]!.key} />);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(second).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith(tabs[1]);

    rerender(<TabBar {...props} tabs={[tabs[0]!]} activeKey={tabs[0]!.key} />);
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("tabindex", "0");
  });

  it("adds the project name only when file names collide", () => {
    const duplicate = {
      ...tabs[1]!,
      key: "p2\u0000a.ts",
      name: "a.ts",
    };
    render(
      <TabBar
        tabs={[tabs[0]!, duplicate]}
        activeKey={tabs[0]!.key}
        dirtyKeys={new Set()}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseTabs={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: /One\s*a\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Two\s*a\.ts/ })).toBeInTheDocument();
  });

  it("marks dirty tabs without changing the close affordance", () => {
    render(
      <TabBar
        tabs={tabs}
        activeKey={tabs[0]!.key}
        dirtyKeys={new Set([tabs[0]!.key])}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseTabs={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    expect(screen.getByRole("tab", { name: "a.ts（未保存）" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭 a.ts" })).toBeInTheDocument();
  });
});

for (const [label, indices] of [
  ["关闭其他", [0, 2]],
  ["关闭右侧", [2]],
  ["关闭左侧", [0]],
  ["关闭所有", [0, 1, 2]],
] as const) {
  it(`targets the context tab for ${label} across projects`, async () => {
    const three = [...tabs, { ...tabs[0]!, key: "third", name: "c.ts" }];
    const onCloseTabs = vi.fn();
    const onActivate = vi.fn();
    const user = userEvent.setup();
    render(
      <TabBar
        tabs={three}
        activeKey={three[0]!.key}
        dirtyKeys={new Set()}
        onActivate={onActivate}
        onClose={vi.fn()}
        onCloseTabs={onCloseTabs}
        onNotice={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("tab", { name: "b.ts" }), { clientX: 100, clientY: 20 });
    expect(onActivate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: label }));
    expect(onCloseTabs).toHaveBeenCalledWith(indices.map((index) => three[index]));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
}

it("disables empty groups and closes the context tab", async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <TabBar
      tabs={[tabs[0]!]}
      activeKey={tabs[0]!.key}
      dirtyKeys={new Set()}
      onActivate={vi.fn()}
      onClose={onClose}
      onCloseTabs={vi.fn()}
      onNotice={vi.fn()}
    />,
  );
  fireEvent.contextMenu(screen.getByRole("tab"));
  for (const name of ["关闭其他", "关闭右侧", "关闭左侧"]) {
    expect(screen.getByRole("menuitem", { name })).toBeDisabled();
  }
  await user.click(screen.getByRole("menuitem", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledWith(tabs[0]);
});

it("copies or reveals the context tab and reports native failures", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  nativeApi.copyEntryPath.mockResolvedValue(undefined);
  nativeApi.revealEntry.mockRejectedValue(new Error("文件不存在"));
  const user = userEvent.setup();
  const onNotice = vi.fn();
  render(
    <TabBar
      tabs={tabs}
      activeKey={tabs[0]!.key}
      dirtyKeys={new Set()}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onCloseTabs={vi.fn()}
      onNotice={onNotice}
    />,
  );
  fireEvent.contextMenu(screen.getByRole("tab", { name: "b.ts" }));
  await user.click(screen.getByRole("menuitem", { name: "复制绝对路径" }));
  expect(nativeApi.copyEntryPath).toHaveBeenCalledWith("p2", "src/b.ts", false);
  expect(onNotice).toHaveBeenCalledWith("已复制绝对路径");
  fireEvent.contextMenu(screen.getByRole("tab", { name: "b.ts" }));
  await user.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
  expect(nativeApi.copyEntryPath).toHaveBeenLastCalledWith("p2", "src/b.ts", true);
  expect(onNotice).toHaveBeenCalledWith("已复制相对路径");
  fireEvent.contextMenu(screen.getByRole("tab", { name: "b.ts" }));
  await user.click(screen.getByRole("menuitem", { name: "在访达中打开" }));
  expect(nativeApi.revealEntry).toHaveBeenCalledWith("p2", "src/b.ts");
  expect(onNotice).toHaveBeenCalledWith("文件不存在");
});

it("disables native file actions outside macOS", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Linux");
  render(
    <TabBar
      tabs={tabs}
      activeKey={tabs[0]!.key}
      dirtyKeys={new Set()}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onCloseTabs={vi.fn()}
      onNotice={vi.fn()}
    />,
  );
  fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
  expect(screen.getByRole("menuitem", { name: "复制绝对路径" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "复制相对路径" })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: "在访达中打开" })).toBeDisabled();
});
