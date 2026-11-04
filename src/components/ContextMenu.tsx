import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuTarget {
  x: number;
  y: number;
  trigger: HTMLElement;
}

export function ContextMenu({
  target,
  label,
  onClose,
  children,
}: {
  target: MenuTarget;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      if (target.trigger.isConnected) target.trigger.focus();
    };
  }, [target]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - height - 8))}px`;
  });
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      className="file-tree-menu"
      role="menu"
      aria-label={label}
      ref={menuRef}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          onClose();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
