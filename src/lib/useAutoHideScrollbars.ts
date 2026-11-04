import { useEffect } from "react";

export function useAutoHideScrollbars() {
  useEffect(() => {
    const timers = new Map<HTMLElement, number>();
    let dragged: HTMLElement | null = null;
    const show = (element: HTMLElement) => {
      window.clearTimeout(timers.get(element));
      element.style.setProperty("--gaze-scrollbar-thumb", "var(--text-faint)");
      timers.set(
        element,
        window.setTimeout(() => {
          if (dragged === element) return;
          element.style.removeProperty("--gaze-scrollbar-thumb");
          timers.delete(element);
        }, 900),
      );
    };
    const onScroll = (event: Event) => {
      const element = event.target === document ? document.scrollingElement : event.target;
      if (element instanceof HTMLElement) show(element);
    };
    const onIntent = (event: WheelEvent | PointerEvent) => {
      for (
        let element = event.target instanceof Element ? event.target : null;
        element;
        element = element.parentElement
      ) {
        if (!(element instanceof HTMLElement)) continue;
        const vertical = element.scrollHeight > element.clientHeight;
        const horizontal = element.scrollWidth > element.clientWidth;
        if (!vertical && !horizontal) continue;
        const style = getComputedStyle(element);
        const scrollY = vertical && /auto|scroll/.test(style.overflowY || style.overflow);
        const scrollX = horizontal && /auto|scroll/.test(style.overflowX || style.overflow);
        if (!scrollY && !scrollX) continue;
        if (event.type !== "wheel") {
          const pointer = event as PointerEvent;
          const rect = element.getBoundingClientRect();
          if (
            pointer.clientX < rect.left ||
            pointer.clientX > rect.right ||
            pointer.clientY < rect.top ||
            pointer.clientY > rect.bottom
          )
            continue;
          if (
            !(scrollY && pointer.clientX >= rect.right - 18) &&
            !(scrollX && pointer.clientY >= rect.bottom - 18)
          )
            continue;
          if (event.type === "pointerdown" && pointer.button === 0) dragged = element;
        }
        show(element);
        if (event.type !== "wheel") return;
      }
    };
    const release = () => {
      const element = dragged;
      dragged = null;
      if (element) show(element);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("wheel", onIntent, { capture: true, passive: true });
    document.addEventListener("pointermove", onIntent, { capture: true, passive: true });
    document.addEventListener("pointerdown", onIntent, { capture: true, passive: true });
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("wheel", onIntent, true);
      document.removeEventListener("pointermove", onIntent, true);
      document.removeEventListener("pointerdown", onIntent, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      for (const [element, timer] of timers) {
        window.clearTimeout(timer);
        element.style.removeProperty("--gaze-scrollbar-thumb");
      }
    };
  }, []);
}
