import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThemePreference } from "./types";

export type NativeMenuAction =
  | "settings"
  | "quit"
  | "open-file"
  | "import-project"
  | "save"
  | "close-tab"
  | "auto-save"
  | "find"
  | "search-workspace"
  | "files"
  | "search"
  | "symbols"
  | "git"
  | "terminal"
  | "word-wrap"
  | "line-numbers"
  | "status-bar"
  | "theme-system"
  | "theme-light"
  | "theme-dark"
  | "quick-open"
  | "back"
  | "forward"
  | "toggle-split"
  | "definition"
  | "references"
  | "implementation";

export interface NativeMenuState {
  language?: import("./i18n").Language;
  ready: boolean;
  blocked: boolean;
  hasFile: boolean;
  canSave: boolean;
  canNavigate: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  splitOpen: boolean;
  terminalOpen: boolean;
  sidebarView: "files" | "search" | "symbols" | "git";
  theme: ThemePreference;
  autoSave: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  showStatusBar: boolean;
}

export function isNativeMenuShortcut(event: KeyboardEvent) {
  if (event.altKey) {
    return (
      event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      ["ArrowLeft", "ArrowRight"].includes(event.code)
    );
  }
  if (event.metaKey && !event.ctrlKey) {
    return event.shiftKey
      ? ["KeyO", "KeyF", "KeyG"].includes(event.code)
      : ["Comma", "KeyO", "KeyS", "KeyW", "KeyQ", "KeyP", "Backslash"].includes(event.code);
  }
  return !event.metaKey && !event.ctrlKey && event.code === "F12";
}

export function useNativeMenu(
  state: NativeMenuState,
  onAction: (action: NativeMenuAction) => Promise<void>,
  onError: (error: unknown) => void,
) {
  const supported = isTauri() && /Mac/.test(navigator.userAgent);
  const [listening, setListening] = useState(false);
  const [active, setActive] = useState(false);
  const stateRef = useRef(state);
  const actionRef = useRef(onAction);
  const errorRef = useRef(onError);
  const queueRef = useRef(Promise.resolve());
  stateRef.current = state;
  actionRef.current = onAction;
  errorRef.current = onError;

  const sync = useCallback((next: NativeMenuState) => {
    const request = queueRef.current
      .catch(() => undefined)
      .then(() => invoke<void>("sync_menu_state", { state: next }));
    queueRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<NativeMenuAction>("gaze://menu-action", (event) => {
      if (disposed) return;
      void actionRef
        .current(event.payload)
        .catch((error: unknown) => errorRef.current(error))
        // Check items toggle natively even when an action is rejected or saving fails.
        .finally(() => sync({ ...stateRef.current, ready: !disposed && stateRef.current.ready }))
        .catch((error: unknown) => {
          if (!disposed) errorRef.current(error);
        });
    })
      .then((release) => {
        if (disposed) release();
        else {
          unlisten = release;
          setListening(true);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) errorRef.current(error);
      });
    return () => {
      disposed = true;
      unlisten?.();
      void sync({ ...stateRef.current, ready: false }).catch(() => undefined);
    };
  }, [supported, sync]);

  useEffect(() => {
    if (!listening) return;
    let disposed = false;
    void sync(state)
      .then(() => {
        if (!disposed) setActive(true);
      })
      .catch((error: unknown) => {
        if (!disposed) errorRef.current(error);
      });
    return () => {
      disposed = true;
    };
  }, [listening, state, sync]);

  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isNativeMenuShortcut(event)) return;
      // The OS accelerator dispatches the menu action; don't also run DOM keymaps.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active]);
}
