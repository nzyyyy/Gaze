import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function useModalFocus<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  initialFocusRef?: RefObject<HTMLElement | null>,
  active = true,
) {
  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    (initialFocusRef?.current ?? dialog).focus();
    if (!dialog.contains(document.activeElement)) dialog.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) =>
          !element.matches(":disabled") &&
          element.tabIndex >= 0 &&
          !element.closest("[hidden], [inert]"),
      );
      event.preventDefault();
      if (controls.length === 0) {
        dialog.focus();
        return;
      }
      const current = controls.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (event.shiftKey) {
        next = current <= 0 ? controls.length - 1 : current - 1;
      } else {
        next = current < 0 || current === controls.length - 1 ? 0 : current + 1;
      }
      controls[next]?.focus();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [active, dialogRef, initialFocusRef]);
}
