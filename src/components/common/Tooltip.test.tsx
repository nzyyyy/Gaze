import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const advance = (ms = 450) => act(() => vi.advanceTimersByTime(ms));
const setup = () => {
  render(
    <>
      <Tooltip />
      <button data-tooltip="Gaze/docs/checklist.md">
        <span>checklist.md</span>
      </button>
    </>,
  );
  return screen.getByRole("button");
};

it("shows a themed tooltip after a delay without a native title or resetting on child movement", () => {
  const button = setup();
  expect(button).not.toHaveAttribute("title");
  fireEvent.pointerOver(button);
  advance(250);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.pointerOver(screen.getByText("checklist.md"));
  advance(200);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Gaze/docs/checklist.md");
  expect(screen.getByRole("tooltip")).toHaveClass("app-tooltip");
});

it("cancels a pending tooltip when the pointer leaves", () => {
  const button = setup();
  fireEvent.pointerOver(button);
  advance(200);
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  advance();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("replaces native titles on dynamically generated CodeMirror controls", () => {
  render(
    <>
      <Tooltip />
      <div className="cm-editor">
        <span title="unfold">…</span>
      </div>
    </>,
  );
  const marker = screen.getByText("…");
  fireEvent.pointerOver(marker);
  expect(marker).not.toHaveAttribute("title");
  expect(marker).toHaveAttribute("aria-description", "unfold");
  advance();
  expect(screen.getByRole("tooltip")).toHaveTextContent("unfold");
});

it("allows moving the pointer onto the tooltip and dismisses after leaving it", () => {
  const button = setup();
  fireEvent.pointerOver(button);
  advance();
  const tip = screen.getByRole("tooltip");
  fireEvent.pointerOut(button, { relatedTarget: tip });
  fireEvent.pointerOver(tip);
  advance(1000);
  expect(tip).toBeInTheDocument();
  fireEvent.pointerOut(tip, { relatedTarget: document.body });
  advance(100);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("supports keyboard focus and preserves an existing accessible description", () => {
  render(
    <>
      <Tooltip />
      <p id="description">Existing help</p>
      <button aria-describedby="description" data-tooltip="Close file">
        Close
      </button>
    </>,
  );
  const button = screen.getByRole("button");
  fireEvent.pointerOver(button);
  fireEvent.focusIn(button);
  advance(0);
  const tip = screen.getByRole("tooltip");
  expect(button.getAttribute("aria-describedby")?.split(" ")).toEqual(["description", tip.id]);
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(button).toHaveAttribute("aria-describedby", "description");
});

it("keeps an Escape-dismissed tooltip closed until the pointer leaves and re-enters", () => {
  const button = setup();
  fireEvent.pointerOver(button);
  advance();
  fireEvent.keyDown(button, { key: "Escape" });
  fireEvent.pointerOver(screen.getByText("checklist.md"));
  advance();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  fireEvent.pointerOver(button);
  advance();
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
});

it("keeps tooltips inside viewport edges and above modal content", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("app-tooltip")
      ? new DOMRect(0, 0, 260, 48)
      : new DOMRect(window.innerWidth - 20, window.innerHeight - 38, 20, 20);
  });
  render(
    <>
      <Tooltip />
      <dialog open>
        <button data-tooltip="Long path">File</button>
      </dialog>
    </>,
  );
  fireEvent.focusIn(screen.getByRole("button"));
  advance(0);
  const tip = screen.getByRole("tooltip");
  expect(tip.closest("dialog")).toBe(screen.getByRole("dialog"));
  expect(tip).toHaveAttribute("popover", "manual");
  expect(tip.style.left).toBe(`${window.innerWidth - 268}px`);
  expect(tip.style.top).toBe(`${window.innerHeight - 94}px`);
  fireEvent.scroll(window);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("closes a stale tooltip when a virtualized target changes", async () => {
  const { rerender } = render(
    <>
      <Tooltip />
      <button data-tooltip="Old path">File</button>
    </>,
  );
  fireEvent.pointerOver(screen.getByRole("button"));
  advance();
  rerender(
    <>
      <Tooltip />
      <button data-tooltip="New path">File</button>
    </>,
  );
  await act(async () => {});
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  const button = screen.getByRole("button");
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  fireEvent.pointerOver(button);
  advance();
  expect(screen.getByRole("tooltip")).toHaveTextContent("New path");
});

it("keeps a focused tooltip open when focus arrives during its pending dismissal", () => {
  const button = setup();
  fireEvent.pointerOver(button);
  advance();
  fireEvent.pointerOut(button, { relatedTarget: document.body });
  fireEvent.focusIn(button);
  advance(100);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
});

it("does not open a tooltip when a pointer press moves focus to its trigger", () => {
  const button = setup();
  fireEvent.pointerDown(button);
  fireEvent.focusIn(button);
  advance();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("does not open a pending tooltip after its target is removed", () => {
  const { rerender } = render(
    <>
      <Tooltip />
      <button data-tooltip="Old file">File</button>
    </>,
  );
  fireEvent.pointerOver(screen.getByRole("button"));
  rerender(<Tooltip />);
  advance();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
