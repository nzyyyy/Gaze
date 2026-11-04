import "@xterm/xterm/css/xterm.css";

import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { ChevronDown, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { api } from "../lib/api";
import type { ColorScheme } from "../lib/colorSchemes";
import { LAYOUT_CHANGE_EVENT, readLayout, saveLayout } from "../lib/layout";
import { DEFAULT_PREFERENCES, type Preferences } from "../lib/preferences";
import {
  nextTerminalTitle,
  removeTerminal,
  terminalTheme,
  type TerminalTab,
} from "../lib/terminalTabs";
import type { Project, ResolvedTheme, TerminalEvent, TerminalSessionInfo } from "../lib/types";
import { errorMessage } from "../lib/utils";

const MIN_HEIGHT = 120;

interface TerminalPanelProps {
  open: boolean;
  project: Project | null;
  theme: ResolvedTheme;
  colorScheme?: ColorScheme;
  preferences?: Preferences;
  fontFamily: string;
  onHide: () => void;
  onNotice: (message: string) => void;
}

export function TerminalPanel({
  open,
  project,
  theme,
  colorScheme = "original",
  preferences = DEFAULT_PREFERENCES,
  fontFamily,
  onHide,
  onNotice,
}: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [height, setHeight] = useState(() => readLayout().terminalHeight);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  const createTab = useCallback((target: Project | null) => {
    const id = crypto.randomUUID();
    const tab: TerminalTab = {
      id,
      projectId: target?.id ?? null,
      title: "终端",
      shell: "",
      exited: false,
      exitCode: null,
    };
    setTabs((current) => [...current, tab]);
    setSelectedId(id);
  }, []);

  // 只在打开面板时补建会话；切换项目或关闭最后一个标签不补建。
  useEffect(() => {
    if (!open) return;
    if (tabs.length === 0) createTab(project);
  }, [open]);

  const activeId = tabs.some((tab) => tab.id === selectedId) ? selectedId : (tabs[0]?.id ?? null);

  const closeTab = useCallback(
    (tab: TerminalTab) => {
      void api.closeTerminal(tab.id).catch(() => undefined);
      const result = removeTerminal(tabs, activeId, tab.id);
      setTabs(result.tabs);
      setSelectedId(result.activeId);
    },
    [tabs, activeId],
  );

  const handleReady = useCallback((id: string, info: TerminalSessionInfo) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              shell: info.shell,
              title: nextTerminalTitle(
                current.filter((item) => item.id !== id),
                info.shell,
              ),
            }
          : tab,
      ),
    );
  }, []);

  const handleExit = useCallback((id: string, exitCode: number | null) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? { ...tab, exited: true, exitCode } : tab)),
    );
  }, []);

  const handleError = useCallback(
    (id: string, message: string) => {
      setTabs((current) => current.filter((tab) => tab.id !== id));
      onNotice(message);
    },
    [onNotice],
  );

  const clampHeight = (value: number) => {
    const available = panelRef.current?.parentElement?.clientHeight || 600;
    return Math.min(Math.max(MIN_HEIGHT, Math.round(available * 0.7)), Math.max(MIN_HEIGHT, value));
  };

  // A stored height may exceed the current window; clamp it once the panel is laid out.
  useLayoutEffect(() => {
    if ((panelRef.current?.parentElement?.clientHeight ?? 0) > 0)
      setHeight((current) => clampHeight(current));
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (moveEvent: PointerEvent) => {
      setHeight(clampHeight(startHeight + (startY - moveEvent.clientY)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      saveLayout({ terminalHeight: heightRef.current });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  useEffect(() => {
    const restore = () => setHeight(clampHeight(readLayout().terminalHeight));
    window.addEventListener(LAYOUT_CHANGE_EVENT, restore);
    return () => window.removeEventListener(LAYOUT_CHANGE_EVENT, restore);
  }, []);

  const newTerminal = () => {
    createTab(project);
  };

  return (
    <div className="terminal-panel" hidden={!open} style={{ height }} ref={panelRef}>
      <div
        className="terminal-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整终端高度"
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          const delta = event.key === "ArrowUp" ? 20 : event.key === "ArrowDown" ? -20 : 0;
          if (delta === 0) return;
          event.preventDefault();
          const next = clampHeight(height + delta);
          setHeight(next);
          saveLayout({ terminalHeight: next });
        }}
      />
      <div className="terminal-header">
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${tab.id === activeId ? "is-active" : ""} ${
                tab.exited ? "is-exited" : ""
              }`}
            >
              <button
                className="terminal-tab-label"
                role="tab"
                aria-selected={tab.id === activeId}
                onClick={() => setSelectedId(tab.id)}
                data-tooltip={tab.exited ? `${tab.title}（进程已退出）` : tab.title}
              >
                <TerminalIcon size={14} />
                <span>{tab.title}</span>
                {tab.exited && (
                  <span className="terminal-exited">
                    {tab.exitCode === null ? "已退出" : `已退出 ${tab.exitCode}`}
                  </span>
                )}
              </button>
              <button
                className="terminal-tab-close"
                onClick={() => closeTab(tab)}
                aria-label={`关闭 ${tab.title}`}
                data-tooltip="关闭终端"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            className="terminal-new"
            onClick={newTerminal}
            aria-label="新建终端"
            data-tooltip="新建终端"
          >
            <Plus size={16} />
          </button>
        </div>
        <button
          className="terminal-hide"
          onClick={onHide}
          aria-label="隐藏终端"
          data-tooltip="隐藏终端"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="terminal-body">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            tab={tab}
            active={open && tab.id === activeId}
            theme={theme}
            colorScheme={colorScheme}
            preferences={preferences}
            fontFamily={fontFamily}
            onReady={handleReady}
            onExit={handleExit}
            onError={handleError}
          />
        ))}
        {tabs.length === 0 && (
          <div className="terminal-empty">
            <span>还没有终端。</span>
            <button className="button button-quiet" onClick={newTerminal}>
              <Plus size={13} />
              新建终端
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface TerminalViewProps {
  tab: TerminalTab;
  active: boolean;
  theme: ResolvedTheme;
  colorScheme: ColorScheme;
  preferences: Preferences;
  fontFamily: string;
  onReady: (id: string, info: TerminalSessionInfo) => void;
  onExit: (id: string, exitCode: number | null) => void;
  onError: (id: string, message: string) => void;
}

function TerminalView({
  tab,
  active,
  theme,
  colorScheme,
  preferences,
  fontFamily,
  onReady,
  onExit,
  onError,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const exitedRef = useRef(false);
  const callbacksRef = useRef({ onReady, onExit, onError });
  callbacksRef.current = { onReady, onExit, onError };
  const appearanceRef = useRef({ theme, fontFamily, colorScheme, preferences });
  appearanceRef.current = { theme, fontFamily, colorScheme, preferences };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let term: Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;
    let outputFrame: number | null = null;
    let pendingOutput: string[] = [];

    const flushOutput = () => {
      outputFrame = null;
      if (disposed || !term || pendingOutput.length === 0) return;
      const chunks = pendingOutput.map((data) => {
        const binary = atob(data);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
      });
      pendingOutput = [];
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      term.write(bytes);
    };

    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon: FitAddonCtor }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        document.fonts?.load('13px "Gaze Maple Mono"').catch(() => []),
      ]);
      if (disposed || !containerRef.current) return;

      const terminal = new Xterm({
        fontFamily: appearanceRef.current.fontFamily,
        ...terminalOptions(appearanceRef.current.preferences),
        theme: terminalTheme(
          appearanceRef.current.theme === "dark",
          appearanceRef.current.colorScheme,
        ),
      });
      const fitAddon = new FitAddonCtor();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      term = terminal;
      termRef.current = terminal;
      fitRef.current = fitAddon;

      terminal.onData((data) => {
        if (exitedRef.current) return;
        void api.writeTerminal(tab.id, data).catch(() => undefined);
      });
      terminal.onResize(({ cols, rows }) => {
        void api.resizeTerminal(tab.id, cols, rows).catch(() => undefined);
      });

      resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          if (disposed || !containerRef.current || containerRef.current.clientWidth === 0) return;
          fitAddon.fit();
        });
      });
      resizeObserver.observe(containerRef.current);

      // 先按当前布局确定行列数，再把同一个尺寸交给 PTY，避免 shell 停留在默认 80x24。
      if (containerRef.current.clientWidth > 0) {
        fitAddon.fit();
        terminal.focus();
      }

      // 先监听再创建会话，避免丢掉 shell 的第一屏输出。
      const stopListening = await api.onTerminalEvent((event: TerminalEvent) => {
        if (event.sessionId !== tab.id) return;
        if (event.kind === "data" && event.data) {
          pendingOutput.push(event.data);
          if (outputFrame === null) outputFrame = requestAnimationFrame(flushOutput);
        } else if (event.kind === "exit") {
          exitedRef.current = true;
          callbacksRef.current.onExit(tab.id, event.exitCode ?? null);
        }
      });
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;

      try {
        const info = await api.createTerminal(
          tab.id,
          tab.projectId,
          Math.max(terminal.cols, 2),
          Math.max(terminal.rows, 2),
        );
        if (disposed) {
          void api.closeTerminal(tab.id).catch(() => undefined);
          return;
        }
        callbacksRef.current.onReady(tab.id, info);
      } catch (error) {
        if (!disposed) callbacksRef.current.onError(tab.id, errorMessage(error));
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      if (outputFrame !== null) cancelAnimationFrame(outputFrame);
      pendingOutput = [];
      resizeObserver?.disconnect();
      unlisten?.();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      void api.closeTerminal(tab.id).catch(() => undefined);
    };
  }, [tab.id, tab.projectId]);

  useEffect(() => {
    if (termRef.current)
      termRef.current.options.theme = terminalTheme(theme === "dark", colorScheme);
  }, [theme, colorScheme]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontFamily = fontFamily;
    if (containerRef.current?.clientWidth) fitRef.current?.fit();
  }, [fontFamily]);

  useEffect(() => {
    if (!termRef.current) return;
    Object.assign(termRef.current.options, terminalOptions(preferences));
    if (containerRef.current?.clientWidth) fitRef.current?.fit();
  }, [preferences]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const terminal = termRef.current;
      const fitAddon = fitRef.current;
      const container = containerRef.current;
      if (!terminal || !fitAddon || !container || container.clientWidth === 0) return;
      fitAddon.fit();
      terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <div className="terminal-view" hidden={!active} ref={containerRef} />;
}

function terminalOptions(preferences: Preferences) {
  return {
    fontSize: preferences.terminalFontSize,
    lineHeight: preferences.terminalLineHeight,
    scrollback: preferences.terminalScrollback,
    cursorBlink: preferences.terminalCursorBlink,
    cursorStyle: preferences.terminalCursorStyle,
  };
}
