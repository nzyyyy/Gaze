import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { LAYOUT_CHANGE_EVENT, readLayout, saveLayout } from "../lib/layout";

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const MIN_READER_WIDTH = 320;
const COLLAPSE_WIDTH = 164;

export function SidebarResizer({
  collapsed = false,
  onCollapsedChange,
}: {
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
} = {}) {
  const separatorRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [width, setWidth] = useState(() => readLayout().sidebarWidth);
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  const widthRef = useRef(width);
  widthRef.current = width;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const onCollapsedChangeRef = useRef(onCollapsedChange);
  onCollapsedChangeRef.current = onCollapsedChange;

  const resize = useCallback((value: number, dragging = false) => {
    const workspace = separatorRef.current?.parentElement;
    if (!workspace) return undefined;
    const available = workspace.getBoundingClientRect().width || window.innerWidth;
    const railWidth = workspace.querySelector<HTMLElement>(".sidebar-rail")?.offsetWidth || 0;
    const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - railWidth - MIN_READER_WIDTH));
    if (dragging && onCollapsedChangeRef.current) {
      const nextCollapsed = value < COLLAPSE_WIDTH;
      if (nextCollapsed !== collapsedRef.current) {
        collapsedRef.current = nextCollapsed;
        onCollapsedChangeRef.current(nextCollapsed);
      }
      if (nextCollapsed) return widthRef.current;
    }
    const min = dragging && onCollapsedChangeRef.current ? COLLAPSE_WIDTH : MIN_WIDTH;
    const next = Math.max(min, Math.min(max, Math.round(value)));
    workspace.style.setProperty("--sidebar-width", `${next}px`);
    widthRef.current = next;
    setWidth(next);
    setMaxWidth(max);
    return next;
  }, []);

  const stop = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    const separator = separatorRef.current;
    separator?.parentElement?.classList.remove("is-resizing-sidebar");
    if (drag) separator?.blur();
    if (drag && separator?.hasPointerCapture(drag.pointerId)) {
      separator.releasePointerCapture(drag.pointerId);
    }
    if (drag) {
      const applied = resize(widthRef.current);
      saveLayout({
        sidebarWidth: applied ?? widthRef.current,
        sidebarCollapsed: collapsedRef.current,
      });
    }
  }, [resize]);

  useLayoutEffect(() => {
    const separator = separatorRef.current;
    const workspace = separator?.parentElement;
    const rendered = separator?.previousElementSibling?.getBoundingClientRect().width || 292;
    resize(readLayout({ sidebarWidth: rendered }).sidebarWidth);
    const fit = () => resize(widthRef.current);
    window.addEventListener("resize", fit);
    const restore = () => {
      const layout = readLayout();
      resize(layout.sidebarWidth);
      collapsedRef.current = layout.sidebarCollapsed;
    };
    window.addEventListener(LAYOUT_CHANGE_EVENT, restore);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener(LAYOUT_CHANGE_EVENT, restore);
      window.removeEventListener("blur", stop);
      workspace?.classList.remove("is-resizing-sidebar");
    };
  }, [resize, stop]);

  return (
    <div
      ref={separatorRef}
      className="sidebar-resizer"
      role="separator"
      aria-label="调整项目栏宽度"
      aria-orientation="vertical"
      aria-controls="workspace-sidebar"
      aria-valuemin={onCollapsedChange ? 0 : MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={collapsed ? 0 : width}
      aria-hidden={collapsed}
      tabIndex={collapsed ? -1 : 0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, width };
        event.currentTarget.parentElement?.classList.add("is-resizing-sidebar");
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag?.pointerId === event.pointerId) resize(drag.width + event.clientX - drag.x, true);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        stop();
      }}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? onCollapsedChange && width <= MIN_WIDTH
              ? 0
              : width - 20
            : event.key === "ArrowRight"
              ? width + 20
              : event.key === "Home"
                ? onCollapsedChange
                  ? 0
                  : MIN_WIDTH
                : event.key === "End"
                  ? maxWidth
                  : null;
        if (next === null) return;
        event.preventDefault();
        if (onCollapsedChange && next < COLLAPSE_WIDTH) {
          collapsedRef.current = true;
          onCollapsedChange(true);
          saveLayout({ sidebarCollapsed: true });
          return;
        }
        const applied = resize(next);
        if (applied != null) saveLayout({ sidebarWidth: applied });
      }}
    />
  );
}
