import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { fontStack } from "../lib/fonts";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
import { saveLayout } from "../lib/layout";
import type { TerminalEvent } from "../lib/types";
import { act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ shell: "/bin/zsh" }),
  close: vi.fn().mockResolvedValue(undefined),
  fit: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  onTerminalEvent: vi.fn().mockResolvedValue(() => undefined),
  options: {} as { fontFamily?: string; theme?: unknown },
}));

vi.mock("../lib/api", () => ({
  api: {
    createTerminal: mocks.create,
    closeTerminal: mocks.close,
    onTerminalEvent: mocks.onTerminalEvent,
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: typeof mocks.options;
    cols = 80;
    rows = 24;
    constructor(options: typeof mocks.options) {
      this.options = mocks.options = options;
    }
    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    focus() {}
    write = mocks.write;
    dispose = mocks.dispose;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));

import { TerminalPanel } from "./TerminalPanel";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onTerminalEvent.mockResolvedValue(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

it("updates fonts and colors without restarting its shell", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const project = { id: "p1", name: "Demo", root: "/demo" };
  const props = {
    open: true,
    project,
    theme: "light" as const,
    onHide: vi.fn(),
    onNotice: vi.fn(),
  };
  const { rerender } = render(
    <TerminalPanel {...props} fontFamily={fontStack("maple", "terminal")} />,
  );
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  expect(mocks.options.fontFamily).toBe(fontStack("maple", "terminal"));
  const fits = mocks.fit.mock.calls.length;
  rerender(<TerminalPanel {...props} fontFamily={fontStack("consolas", "terminal")} />);
  expect(mocks.options.fontFamily).toBe(fontStack("consolas", "terminal"));
  expect(mocks.fit.mock.calls.length).toBeGreaterThan(fits);
  rerender(
    <TerminalPanel
      {...props}
      theme="dark"
      colorScheme="catppuccin"
      preferences={{
        ...DEFAULT_PREFERENCES,
        terminalFontSize: 17,
        terminalLineHeight: 1.2,
        terminalScrollback: 9000,
        terminalCursorBlink: false,
        terminalCursorStyle: "bar",
      }}
      fontFamily={fontStack("consolas", "terminal")}
    />,
  );
  expect(mocks.options.theme).toMatchObject({ background: "#1e1e2e", foreground: "#cdd6f4" });
  expect(mocks.options).toMatchObject({
    fontSize: 17,
    lineHeight: 1.2,
    scrollback: 9000,
    cursorBlink: false,
    cursorStyle: "bar",
  });
  act(() => saveLayout({ terminalHeight: 310 }));
  expect(document.querySelector(".terminal-panel")).toHaveStyle({ height: "310px" });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.dispose).not.toHaveBeenCalled();
});

it("batches base64 decoding and byte writes in one animation frame", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  let onEvent: ((event: TerminalEvent) => void) | undefined;
  mocks.onTerminalEvent.mockImplementation(async (handler: (event: TerminalEvent) => void) => {
    onEvent = handler;
    return () => undefined;
  });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    frames.delete(frame);
  });
  mocks.write.mockClear();
  const project = { id: "p1", name: "Demo", root: "/demo" };
  const createCalls = mocks.create.mock.calls.length;
  render(
    <TerminalPanel
      open
      project={project}
      theme="dark"
      fontFamily="monospace"
      onHide={vi.fn()}
      onNotice={vi.fn()}
    />,
  );
  await waitFor(() => expect(mocks.create.mock.calls.length).toBeGreaterThan(createCalls));
  await waitFor(() => expect(onEvent).toBeTypeOf("function"));
  const sessionId = mocks.create.mock.calls.at(-1)![0] as string;
  const expected = new TextEncoder().encode("A😀中B");
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  act(() => {
    onEvent?.({ sessionId, kind: "data", data: encode(expected.slice(0, 4)) });
    onEvent?.({ sessionId, kind: "data", data: encode(expected.slice(4)) });
  });
  expect(mocks.write).not.toHaveBeenCalled();

  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((callback) => callback(0)));

  expect(mocks.write).toHaveBeenCalledTimes(1);
  const written = mocks.write.mock.calls[0]![0] as Uint8Array;
  expect(written).toBeInstanceOf(Uint8Array);
  expect(Array.from(written)).toEqual(Array.from(expected));
  expect(new TextDecoder().decode(written)).toBe("A😀中B");
});

it("shares tabs and selection across projects while new shells use the selected project", async () => {
  const first = { id: "p1", name: "First", root: "/first" };
  const second = { id: "p2", name: "Second", root: "/second" };
  const props = {
    open: true,
    theme: "dark" as const,
    fontFamily: "monospace",
    onHide: vi.fn(),
    onNotice: vi.fn(),
  };
  const { rerender, container } = render(<TerminalPanel {...props} project={first} />);
  const firstTab = await screen.findByRole("tab", { name: "zsh" });
  const firstView = container.querySelector(".terminal-view");
  expect(mocks.create).toHaveBeenCalledWith(expect.any(String), "p1", 80, 24);

  rerender(<TerminalPanel {...props} project={second} />);
  expect(firstTab).toHaveAttribute("aria-selected", "true");
  expect(firstView).not.toHaveAttribute("hidden");
  expect(container.querySelector(".terminal-view")).toBe(firstView);
  expect(mocks.create).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
  const secondTab = await screen.findByRole("tab", { name: "zsh 2" });
  expect(mocks.create).toHaveBeenLastCalledWith(expect.any(String), "p2", 80, 24);
  expect(screen.getAllByRole("tab")).toEqual([firstTab, secondTab]);
  expect(secondTab).toHaveAttribute("aria-selected", "true");
  expect(firstView).toHaveAttribute("hidden");

  rerender(<TerminalPanel {...props} project={first} />);
  expect(secondTab).toHaveAttribute("aria-selected", "true");
  fireEvent.click(firstTab);
  expect(firstTab).toHaveAttribute("aria-selected", "true");
  expect(firstView).not.toHaveAttribute("hidden");
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.dispose).not.toHaveBeenCalled();
});

it("keeps the terminal usable after its project is removed and no project is selected", async () => {
  const props = {
    open: true,
    theme: "dark" as const,
    fontFamily: "monospace",
    onHide: vi.fn(),
    onNotice: vi.fn(),
  };
  const { rerender, container } = render(
    <TerminalPanel {...props} project={{ id: "p1", name: "Demo", root: "/demo" }} />,
  );
  const tab = await screen.findByRole("tab", { name: "zsh" });
  const view = container.querySelector(".terminal-view");

  rerender(<TerminalPanel {...props} project={null} />);
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(view).not.toHaveAttribute("hidden");
  rerender(<TerminalPanel {...props} project={null} open={false} />);
  expect(view).toHaveAttribute("hidden");
  rerender(<TerminalPanel {...props} project={null} />);
  expect(view).not.toHaveAttribute("hidden");
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.dispose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
  await screen.findByRole("tab", { name: "zsh 2" });
  expect(mocks.create).toHaveBeenLastCalledWith(expect.any(String), null, 80, 24);
  expect(props.onNotice).not.toHaveBeenCalled();
});

it("starts in the home directory without a selected project and uses the next selected project for new tabs", async () => {
  const props = {
    open: true,
    theme: "dark" as const,
    fontFamily: "monospace",
    onHide: vi.fn(),
    onNotice: vi.fn(),
  };
  const { rerender } = render(<TerminalPanel {...props} project={null} />);
  const homeTab = await screen.findByRole("tab", { name: "zsh" });
  expect(mocks.create).toHaveBeenCalledWith(expect.any(String), null, 80, 24);
  const project = { id: "p1", name: "Demo", root: "/demo" };
  rerender(<TerminalPanel {...props} project={project} />);
  expect(homeTab).toHaveAttribute("aria-selected", "true");
  expect(mocks.create).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
  await screen.findByRole("tab", { name: "zsh 2" });
  expect(mocks.create).toHaveBeenLastCalledWith(expect.any(String), "p1", 80, 24);
});

it("only fills an empty panel when it opens, not when the last tab closes or projects switch", async () => {
  const first = { id: "p1", name: "First", root: "/first" };
  const second = { id: "p2", name: "Second", root: "/second" };
  const props = {
    theme: "dark" as const,
    fontFamily: "monospace",
    onHide: vi.fn(),
    onNotice: vi.fn(),
  };
  const { rerender } = render(<TerminalPanel {...props} project={first} open={false} />);
  expect(mocks.create).not.toHaveBeenCalled();
  rerender(<TerminalPanel {...props} project={first} open />);
  await screen.findByRole("tab", { name: "zsh" });
  const sessionId = mocks.create.mock.calls[0]![0];
  fireEvent.click(screen.getByRole("button", { name: "关闭 zsh" }));
  expect(mocks.close).toHaveBeenCalledWith(sessionId);
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(screen.getByText("还没有终端。")).toBeInTheDocument();
  rerender(<TerminalPanel {...props} project={second} open />);
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(mocks.create).toHaveBeenCalledTimes(1);

  rerender(<TerminalPanel {...props} project={second} open={false} />);
  rerender(<TerminalPanel {...props} project={second} open />);
  await screen.findByRole("tab", { name: "zsh" });
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create).toHaveBeenLastCalledWith(expect.any(String), "p2", 80, 24);
});

it("keeps an existing shell active when starting another shell fails", async () => {
  const props = {
    open: true,
    project: { id: "p1", name: "Demo", root: "/demo" },
    theme: "dark" as const,
    fontFamily: "monospace",
    onHide: vi.fn(),
    onNotice: vi.fn(),
  };
  render(<TerminalPanel {...props} />);
  const tab = await screen.findByRole("tab", { name: "zsh" });
  mocks.create.mockRejectedValueOnce(new Error("无法启动 shell"));
  fireEvent.click(screen.getByRole("button", { name: "新建终端" }));
  await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("无法启动 shell"));
  expect(screen.getAllByRole("tab")).toEqual([tab]);
  expect(tab).toHaveAttribute("aria-selected", "true");
});
