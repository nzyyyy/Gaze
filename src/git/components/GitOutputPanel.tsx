import { t as tr, useLanguage } from "../../lib/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { LAYOUT_CHANGE_EVENT, readLayout, saveLayout } from "../../lib/layout";
import type { SessionLogLine } from "../models";

const MIN_HEIGHT = 96;

interface Props {
  open: boolean;
  logs: SessionLogLine[];
  status: string;
  onClear: () => void;
  onExport: () => void;
  onClose: () => void;
}

const time = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour12: false });
};

export function GitOutputPanel({ open, logs, status, onClear, onExport, onClose }: Props) {
  useLanguage();
  const [height, setHeight] = useState(() => readLayout().outputHeight);
  const panelRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs.length, open]);

  const clampHeight = (value: number) => {
    const available = panelRef.current?.parentElement?.clientHeight || 600;
    const max = Math.max(MIN_HEIGHT, Math.round(available * 0.7));
    return Math.min(max, Math.max(MIN_HEIGHT, value));
  };

  // A stored height may exceed the current window; clamp it once the panel is laid out.
  useLayoutEffect(() => {
    if ((panelRef.current?.parentElement?.clientHeight ?? 0) > 0)
      setHeight((current) => clampHeight(current));
  }, []);

  useEffect(() => {
    const restore = () => setHeight(clampHeight(readLayout().outputHeight));
    window.addEventListener(LAYOUT_CHANGE_EVENT, restore);
    return () => window.removeEventListener(LAYOUT_CHANGE_EVENT, restore);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const move = (moveEvent: PointerEvent) =>
      setHeight(clampHeight(startHeight + (startY - moveEvent.clientY)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      saveLayout({ outputHeight: heightRef.current });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <section
      className="git-output-panel"
      style={{ height }}
      ref={panelRef}
      hidden={!open}
      aria-label={tr("Git 输出")}
    >
      <div
        className="git-output-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={tr("调整 Git 输出高度")}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          const delta = event.key === "ArrowUp" ? 20 : event.key === "ArrowDown" ? -20 : 0;
          if (!delta) return;
          event.preventDefault();
          const next = clampHeight(height + delta);
          setHeight(next);
          saveLayout({ outputHeight: next });
        }}
      />
      <header className="git-output-header">
        <span role="status">{status || tr("最近一次操作的结果会显示在这里。")}</span>
        <div>
          <button disabled={!logs.length} onClick={onClear}>
            {tr("清空")}
          </button>
          <button disabled={!logs.length} onClick={onExport}>
            {tr("导出日志")}
          </button>
          <button className="git-output-close" aria-label={tr("关闭 Git 输出")} onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      <div className="git-output-lines" role="log" ref={logRef}>
        {logs.length === 0 ? (
          <p className="git-output-empty">
            {tr("执行 Fetch、Pull、Push 等操作后，输出会显示在这里。")}
          </p>
        ) : (
          logs.map((line, index) => (
            <div
              key={index}
              className={line.kind === "error" ? "git-output-line is-error" : "git-output-line"}
            >
              <time>{time(line.timestamp)}</time>
              <span>{line.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
