import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeMenu, type NativeMenuState } from "./nativeMenu";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke, isTauri: ipc.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: ipc.listen }));

const state: NativeMenuState = {
  ready: true,
  blocked: false,
  hasFile: false,
  canSave: false,
  canNavigate: false,
  canGoBack: false,
  canGoForward: false,
  splitOpen: false,
  terminalOpen: false,
  sidebarView: "files",
  theme: "system",
  autoSave: true,
  wordWrap: true,
  lineNumbers: true,
  showStatusBar: true,
};

describe("native menu bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.isTauri.mockReturnValue(true);
    ipc.invoke.mockResolvedValue(undefined);
    ipc.listen.mockResolvedValue(vi.fn());
  });

  it("does not register native menus in browser previews", () => {
    ipc.isTauri.mockReturnValue(false);
    renderHook(() => useNativeMenu(state, vi.fn(), vi.fn()));
    expect(ipc.listen).not.toHaveBeenCalled();
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it("enables items only after listening, synchronizes state, and disables on unmount", async () => {
    const release = vi.fn();
    let connected!: (value: () => void) => void;
    ipc.listen.mockReturnValueOnce(
      new Promise((resolve) => {
        connected = resolve;
      }),
    );
    const { rerender, unmount } = renderHook(({ menu }) => useNativeMenu(menu, vi.fn(), vi.fn()), {
      initialProps: { menu: state },
    });
    expect(ipc.listen).toHaveBeenCalledWith("gaze://menu-action", expect.any(Function));
    expect(ipc.invoke).not.toHaveBeenCalled();
    await act(async () => {
      connected(release);
    });
    await waitFor(() => expect(ipc.invoke).toHaveBeenLastCalledWith("sync_menu_state", { state }));
    const changed = { ...state, blocked: true, theme: "dark" as const, autoSave: false };
    rerender({ menu: changed });
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenLastCalledWith("sync_menu_state", { state: changed }),
    );
    unmount();
    expect(release).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenLastCalledWith("sync_menu_state", {
        state: { ...changed, ready: false },
      }),
    );
  });

  it("uses the current handler and restores checkmarks after failed actions", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const current = vi.fn().mockRejectedValue(new Error("磁盘不可写"));
    const onError = vi.fn();
    const { rerender } = renderHook(({ handler }) => useNativeMenu(state, handler, onError), {
      initialProps: { handler: first },
    });
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalled());
    rerender({ handler: current });
    await act(async () => {
      ipc.listen.mock.calls[0]![1]({ payload: "auto-save" });
    });
    expect(first).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith("auto-save");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "磁盘不可写" }));
    expect(ipc.invoke).toHaveBeenLastCalledWith("sync_menu_state", { state });
    expect(ipc.listen).toHaveBeenCalledOnce();
  });

  it("applies newer state after a slow or failed sync without reordering updates", async () => {
    let reject!: (error: Error) => void;
    ipc.invoke.mockReturnValueOnce(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    const { rerender } = renderHook(({ menu }) => useNativeMenu(menu, vi.fn(), vi.fn()), {
      initialProps: { menu: state },
    });
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce());
    const changed = { ...state, blocked: true, autoSave: false };
    rerender({ menu: changed });
    expect(ipc.invoke).toHaveBeenCalledOnce();
    await act(async () => {
      reject(new Error("旧状态同步失败"));
    });
    await waitFor(() =>
      expect(ipc.invoke).toHaveBeenLastCalledWith("sync_menu_state", { state: changed }),
    );
  });

  it("never intercepts keys: the webview is the only shortcut handler", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useNativeMenu(state, onAction, vi.fn()));
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalled());
    await act(async () => {});
    const domAction = vi.fn();
    window.addEventListener("keydown", domAction);
    try {
      for (const init of [
        { code: "KeyS", metaKey: true },
        { code: "KeyO", metaKey: true, shiftKey: true },
        { code: "Digit9", metaKey: true },
        { code: "KeyW", metaKey: true },
      ]) {
        expect(fireEvent.keyDown(window, init)).toBe(true);
      }
      expect(domAction).toHaveBeenCalledTimes(4);
      expect(onAction).not.toHaveBeenCalled();
      await act(async () => {
        ipc.listen.mock.calls[0]![1]({ payload: "save" });
      });
      expect(onAction).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", domAction);
    }
  });
});
