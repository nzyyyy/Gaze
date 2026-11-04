import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

afterEach(() => vi.restoreAllMocks());

it("fits its measured size inside the viewport and skips disabled items", async () => {
  const user = userEvent.setup();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 192,
    height: 360,
  } as DOMRect);
  const onClose = vi.fn();
  const { unmount } = render(
    <ContextMenu
      target={{ x: window.innerWidth, y: window.innerHeight, trigger }}
      label="测试菜单"
      onClose={onClose}
    >
      <button role="menuitem" disabled>
        禁用
      </button>
      <button role="menuitem">第一项</button>
      <button role="menuitem" disabled>
        跳过
      </button>
      <button role="menuitem">最后一项</button>
    </ContextMenu>,
  );
  const menu = screen.getByRole("menu");
  expect(menu.style.left).toBe(`${window.innerWidth - 200}px`);
  expect(menu.style.top).toBe(`${window.innerHeight - 368}px`);
  expect(screen.getByRole("menuitem", { name: "第一项" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "最后一项" })).toHaveFocus();
  await user.keyboard("{Home}");
  expect(screen.getByRole("menuitem", { name: "第一项" })).toHaveFocus();
  await user.keyboard("{ArrowUp}{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
  expect(trigger).toHaveFocus();
  trigger.remove();
});

it("dismisses on an outside pointer or window resize", () => {
  const onClose = vi.fn();
  render(
    <ContextMenu target={{ x: 0, y: 0, trigger: document.body }} label="测试菜单" onClose={onClose}>
      <button>操作</button>
    </ContextMenu>,
  );
  fireEvent.pointerDown(screen.getByRole("menu"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  fireEvent(window, new Event("resize"));
  expect(onClose).toHaveBeenCalledTimes(2);
});
