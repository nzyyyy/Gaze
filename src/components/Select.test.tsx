import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Select } from "./Select";

afterEach(() => vi.restoreAllMocks());

function Example() {
  const [value, setValue] = useState("light");
  return (
    <dialog open>
      <label id="mode-label" htmlFor="mode">
        模式
      </label>
      <div className="scroll-container">
        <Select
          id="mode"
          value={value}
          onChange={setValue}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </div>
      <button type="button">外部</button>
    </dialog>
  );
}

it("keeps the themed menu inside the dialog but outside scrolling containers", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole("combobox", { name: "模式" });
  vi.spyOn(trigger.parentElement!, "getBoundingClientRect").mockReturnValue({
    x: 40,
    y: window.innerHeight - 45,
    left: 40,
    right: 240,
    top: window.innerHeight - 45,
    bottom: window.innerHeight - 15,
    width: 200,
    height: 30,
    toJSON() {},
  });
  await user.click(trigger);
  const menu = screen.getByRole("listbox");
  expect(menu.parentElement).toBe(screen.getByRole("dialog"));
  expect(menu).toHaveStyle({ position: "fixed", bottom: "51px", minWidth: "200px" });
  fireEvent.scroll(menu);
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Dark" }));
  expect(trigger).toHaveTextContent("Dark");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("supports keyboard selection and dismisses on Escape, outside clicks and container scroll", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole("combobox", { name: "模式" });
  await user.click(trigger);
  await user.keyboard("{End}{Escape}");
  expect(trigger).toHaveTextContent("Light");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.keyboard("d{Enter}");
  expect(trigger).toHaveTextContent("Dark");
  await user.click(trigger);
  fireEvent.scroll(trigger.parentElement!.parentElement!);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.click(trigger);
  fireEvent.resize(window);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "外部" }));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
