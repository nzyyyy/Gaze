import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThemePreference } from "../types";
import type { EditorLanguageAction } from "../editor/editorLanguageTools";

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
  | "implementation"
  | EditorLanguageAction;

export interface NativeMenuState {
  language?: import("../i18n").Language;
  ready: boolean;
  blocked: boolean;
  hasFile: boolean;
  canSave: boolean;
  canNavigate: boolean;
  canUseEditorActions?: boolean;
  canShowQuickDocumentation?: boolean;
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

export function useNativeMenu(
  state: NativeMenuState,
  onAction: (action: NativeMenuAction) => Promise<void>,
  onError: (error: unknown) => void,
) {
  const supported = isTauri();
  const [listening, setListening] = useState(false);
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
    void sync(state).catch((error: unknown) => {
      if (!disposed) errorRef.current(error);
    });
    return () => {
      disposed = true;
    };
  }, [listening, state, sync]);
}
