import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { expect, it } from "vitest";
import { useModalFocus } from "./useModalFocus";

function TestDialog({
  customInitial = true,
  secondDisabled = false,
}: {
  customInitial?: boolean;
  secondDisabled?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLButtonElement>(null);
  useModalFocus(dialogRef, customInitial ? secondRef : undefined);

  return (
    <div role="dialog" aria-label="测试对话框" tabIndex={-1} ref={dialogRef}>
      <button>First</button>
      <button ref={secondRef} disabled={secondDisabled}>
        Second
      </button>
      <button>Third</button>
    </div>
  );
}

it("cycles focus, skips newly disabled controls and restores the previous focus", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const { rerender, unmount } = render(<TestDialog />);
  const first = screen.getByRole("button", { name: "First" });
  const second = screen.getByRole("button", { name: "Second" });
  const third = screen.getByRole("button", { name: "Third" });

  expect(second).toHaveFocus();
  fireEvent.keyDown(second, { key: "Tab" });
  expect(third).toHaveFocus();
  fireEvent.keyDown(third, { key: "Tab" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(third).toHaveFocus();

  first.focus();
  rerender(<TestDialog secondDisabled />);
  fireEvent.keyDown(first, { key: "Tab" });
  expect(third).toHaveFocus();
  fireEvent.keyDown(third, { key: "Tab", shiftKey: true });
  expect(first).toHaveFocus();

  unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});

it("focuses the dialog container by default", () => {
  render(<TestDialog customInitial={false} />);
  expect(screen.getByRole("dialog", { name: "测试对话框" })).toHaveFocus();
});
