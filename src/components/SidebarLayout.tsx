import { PanelLeftClose, Pin } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { LAYOUT_CHANGE_EVENT, readLayout, saveLayout } from "../lib/layout";
import { SidebarResizer } from "./SidebarResizer";

export interface SidebarLayoutHandle {
  open: () => void;
  toggle: () => void;
  hidePreview: () => void;
}

interface SidebarLayoutProps {
  rail: (expanded: boolean) => ReactNode;
  panel: ReactNode;
  onPreview?: () => void;
  children: ReactNode;
}

export const SidebarLayout = forwardRef<SidebarLayoutHandle, SidebarLayoutProps>(
  function SidebarLayout({ rail, panel, onPreview, children }, ref) {
    const workspaceRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLElement>(null);
    const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [collapsed, setCollapsed] = useState(() => readLayout().sidebarCollapsed);
    const [preview, setPreview] = useState(false);
    const previewRef = useRef(preview);
    previewRef.current = preview;
    const closed = collapsed && !preview;

    const clearTimers = useCallback(() => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    }, []);

    const focusTrigger = useCallback(() => {
      workspaceRef.current?.querySelector<HTMLElement>("[data-sidebar-trigger]")?.focus();
      clearTimers();
    }, [clearTimers]);

    const hidePreview = useCallback(() => {
      clearTimers();
      setPreview(false);
      if (previewRef.current && panelRef.current?.contains(document.activeElement)) focusTrigger();
    }, [clearTimers, focusTrigger]);

    const changeCollapsed = useCallback(
      (value: boolean, persist = true) => {
        hidePreview();
        setCollapsed(value);
        if (value && !workspaceRef.current?.classList.contains("is-resizing-sidebar")) {
          focusTrigger();
        }
        if (persist) saveLayout({ sidebarCollapsed: value });
      },
      [hidePreview, focusTrigger],
    );

    useImperativeHandle(ref, () => ({
      open: () => changeCollapsed(false),
      toggle: () => changeCollapsed(!collapsed),
      hidePreview,
    }));

    useEffect(() => {
      const restore = () => {
        const value = readLayout().sidebarCollapsed;
        setCollapsed(value);
        hidePreview();
      };
      window.addEventListener(LAYOUT_CHANGE_EVENT, restore);
      return () => {
        window.removeEventListener(LAYOUT_CHANGE_EVENT, restore);
        clearTimers();
      };
    }, [clearTimers, hidePreview]);

    useEffect(() => {
      if (!preview) return;
      const outside = (event: PointerEvent) => {
        const target = event.target;
        if (
          target instanceof Element &&
          !panelRef.current?.contains(target) &&
          !target.closest('[data-sidebar-trigger], [role="menu"], [role="dialog"]')
        )
          hidePreview();
      };
      document.addEventListener("pointerdown", outside);
      window.addEventListener("blur", hidePreview);
      return () => {
        document.removeEventListener("pointerdown", outside);
        window.removeEventListener("blur", hidePreview);
      };
    }, [preview, hidePreview]);

    const showPreview = () => {
      clearTimers();
      if (collapsed && !workspaceRef.current?.classList.contains("is-resizing-sidebar")) {
        openTimer.current = setTimeout(() => {
          onPreview?.();
          setPreview(true);
        }, 160);
      }
    };

    const leavePreview = (keepFocus = false) => {
      clearTimers();
      closeTimer.current = setTimeout(() => {
        if (
          (keepFocus && panelRef.current?.contains(document.activeElement)) ||
          document.querySelector('[role="menu"], [role="dialog"]')
        )
          return;
        hidePreview();
      }, 260);
    };

    return (
      <div
        className="workspace"
        ref={workspaceRef}
        data-sidebar={collapsed ? (preview ? "floating" : "collapsed") : "docked"}
        onKeyDown={(event) => {
          if (event.key === "Escape" && preview && !event.defaultPrevented) {
            event.preventDefault();
            hidePreview();
          }
        }}
      >
        <nav
          className="sidebar-rail"
          aria-label="侧栏视图"
          onPointerOver={(event) => {
            if (event.target instanceof Element && event.target.closest("[data-sidebar-trigger]")) {
              showPreview();
            }
          }}
          onPointerOut={() => leavePreview()}
          onFocus={(event) => {
            if (event.target.closest("[data-sidebar-trigger]")) showPreview();
          }}
          onBlur={() => leavePreview(true)}
        >
          {rail(!closed)}
        </nav>
        <div className="sidebar-space" aria-hidden="true" />
        <aside
          className="sidebar"
          id="workspace-sidebar"
          aria-label="工作区侧栏"
          ref={panelRef}
          inert={closed}
          aria-hidden={closed}
          onPointerEnter={clearTimers}
          onPointerLeave={() => leavePreview()}
          onFocus={clearTimers}
          onBlur={() => leavePreview(true)}
        >
          <button
            className="icon-button sidebar-toggle"
            aria-label={collapsed ? "固定项目栏" : "收起项目栏"}
            data-tooltip={collapsed ? "固定项目栏" : "收起项目栏"}
            onClick={() => changeCollapsed(!collapsed)}
          >
            {collapsed ? <Pin size={15} /> : <PanelLeftClose size={15} />}
          </button>
          {panel}
        </aside>
        <SidebarResizer
          collapsed={collapsed}
          onCollapsedChange={(value) => changeCollapsed(value, false)}
        />
        {children}
      </div>
    );
  },
);
