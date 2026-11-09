import { t, useLanguage } from "../lib/i18n";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { LAYOUT_CHANGE_EVENT, readLayout, saveLayout } from "../lib/layout";

const HANDLE_WIDTH = 6;
const MIN_PANE_WIDTH = 240;

export function EditorSplitResizer({
  layoutKey = "editorSplitRatio",
  label = t("调整左右编辑区宽度"),
}: {
  layoutKey?: "editorSplitRatio" | "gitHistorySplitRatio";
  label?: string;
} = {}) {
  useLanguage();
  const separatorRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; ratio: number; width: number } | null>(
    null,
  );
  const [ratio, setRatio] = useState(() => readLayout()[layoutKey]);
  const [minRatio, setMinRatio] = useState(0);
  const ratioRef = useRef(ratio);

  const resize = useCallback((value: number) => {
    const panes = separatorRef.current?.parentElement;
    if (!panes) return;
    const width = Math.max(
      1,
      (panes.getBoundingClientRect().width || window.innerWidth) - HANDLE_WIDTH,
    );
    const min = Math.min(0.5, MIN_PANE_WIDTH / width);
    const next = Math.max(min, Math.min(1 - min, value));
    panes.style.setProperty("--editor-primary-size", `${next}fr`);
    panes.style.setProperty("--editor-secondary-size", `${1 - next}fr`);
    ratioRef.current = next;
    setRatio(next);
    setMinRatio(min);
  }, []);

  const stop = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const separator = separatorRef.current;
    separator?.parentElement?.classList.remove("is-resizing-editor");
    separator?.blur();
    if (separator?.hasPointerCapture(drag.pointerId))
      separator.releasePointerCapture(drag.pointerId);
    saveLayout({ [layoutKey]: ratioRef.current });
  }, [layoutKey]);

  useLayoutEffect(() => {
    const panes = separatorRef.current!.parentElement!;
    resize(readLayout()[layoutKey]);
    const fit = () => {
      if (!panes.hidden) resize(ratioRef.current);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(panes);
    const restore = () => resize(readLayout()[layoutKey]);
    window.addEventListener("resize", fit);
    window.addEventListener(LAYOUT_CHANGE_EVENT, restore);
    window.addEventListener("blur", stop);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener(LAYOUT_CHANGE_EVENT, restore);
      window.removeEventListener("blur", stop);
      stop();
    };
  }, [layoutKey, resize, stop]);

  return (
    <div
      ref={separatorRef}
      className="editor-split-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(minRatio * 100)}
      aria-valuemax={Math.round((1 - minRatio) * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        const width =
          event.currentTarget.parentElement!.getBoundingClientRect().width || window.innerWidth;
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          ratio,
          width: Math.max(1, width - HANDLE_WIDTH),
        };
        event.currentTarget.parentElement!.classList.add("is-resizing-editor");
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag?.pointerId === event.pointerId)
          resize(drag.ratio + (event.clientX - drag.x) / drag.width);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) stop();
      }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? ratio - 0.05
            : event.key === "ArrowRight"
              ? ratio + 0.05
              : event.key === "Home"
                ? minRatio
                : event.key === "End"
                  ? 1 - minRatio
                  : null;
        if (next === null) return;
        event.preventDefault();
        resize(next);
        saveLayout({ [layoutKey]: ratioRef.current });
      }}
    />
  );
}
