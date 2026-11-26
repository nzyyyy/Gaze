import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuTarget {
  x: number;
  y: number;
  trigger: HTMLElement;
  focusFirstItem?: boolean;
}

export function ContextMenu({
  target,
  label,
  onClose,
  children,
  className,
}: {
  target: MenuTarget;
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const first =
      target.focusFirstItem === false ? null : menu.querySelector("button:not(:disabled)");
    (first instanceof HTMLElement ? first : menu).focus({ preventScroll: true });
    return () => {
      if (target.trigger.isConnected) target.trigger.focus();
    };
  }, [target]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    for (const button of menu.querySelectorAll("button")) {
      button.dataset.tooltip =
        button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "";
    }
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
      className={className ? `file-tree-menu ${className}` : "file-tree-menu"}
      role="menu"
      aria-label={label}
      tabIndex={-1}
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
          const down = event.key === "ArrowDown";
          const next =
            event.key === "Home" || (index < 0 && down)
              ? 0
              : event.key === "End" || index < 0
                ? buttons.length - 1
                : (index + (down ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
