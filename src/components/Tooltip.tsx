import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Tooltip() {
  const id = useId();
  const tipRef = useRef<HTMLDivElement>(null);
  const ownerRef = useRef<HTMLElement | null>(null);
  const [current, setCurrent] = useState<{ target: HTMLElement; text: string } | null>(null);

  useEffect(() => {
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    let shown = false;
    let dismissed: HTMLElement | null = null;
    let timer: number | undefined;
    const clearTimer = () => window.clearTimeout(timer);
    const hide = () => {
      clearTimer();
      ownerRef.current = null;
      shown = false;
      setCurrent(null);
    };
    const show = (target: HTMLElement, delay: number) => {
      clearTimer();
      if (target === dismissed || (target === ownerRef.current && shown)) return;
      ownerRef.current = target;
      shown = false;
      setCurrent(null);
      timer = window.setTimeout(() => {
        const text = target.dataset.tooltip;
        if (target.isConnected && !target.closest("[hidden], dialog:not([open])") && text) {
          shown = true;
          setCurrent({ target, text });
        } else hide();
      }, delay);
    };
    const trigger = (target: EventTarget | null) => {
      const element =
        target instanceof Element
          ? target.closest<HTMLElement>("[data-tooltip], .cm-editor [title]")
          : null;
      // CodeMirror owns these DOM nodes and can create new native titles after folding.
      if (element?.hasAttribute("title") && element.closest(".cm-editor")) {
        element.dataset.tooltip = element.getAttribute("title") ?? "";
        element.setAttribute("aria-description", element.dataset.tooltip);
        element.removeAttribute("title");
      }
      return element;
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (tipRef.current?.contains(event.target as Node)) {
        clearTimer();
        return;
      }
      const next = trigger(event.target);
      if (next === hovered) return;
      hovered = next;
      if (next) show(next, 450);
    };
    const out = (event: PointerEvent) => {
      const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (related && (hovered?.contains(related) || tipRef.current?.contains(related))) return;
      if (
        hovered?.contains(event.target as Node) ||
        tipRef.current?.contains(event.target as Node)
      ) {
        if (dismissed === hovered && focused !== hovered) dismissed = null;
        hovered = null;
        if (focused) show(focused, 0);
        else {
          clearTimer();
          timer = window.setTimeout(hide, 100);
        }
      }
    };
    const focus = (event: FocusEvent) => {
      focused = trigger(event.target);
      if (focused) show(focused, 0);
      else hide();
    };
    const blur = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && focused?.contains(event.relatedTarget)) return;
      if (dismissed === focused && hovered !== focused) dismissed = null;
      focused = null;
      if (hovered) show(hovered, 0);
      else hide();
    };
    const dismiss = (event?: Event) => {
      dismissed = ownerRef.current ?? trigger(event?.target ?? null);
      hide();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && tipRef.current?.contains(event.target)) return;
      dismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      clearTimer();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!current || !tip) return;
    const { target, text } = current;
    if (!target.isConnected || target.closest("[hidden], dialog:not([open])")) {
      ownerRef.current = null;
      setCurrent(null);
      return;
    }
    // The top layer keeps tooltips above dialogs and clipped, scrolling panels.
    if (tip.showPopover) tip.showPopover();
    else tip.style.display = "block";
    const anchor = target.getBoundingClientRect();
    const bounds = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8));
    const below = anchor.bottom + 8;
    const top =
      below + bounds.height <= window.innerHeight - 8
        ? below
        : Math.max(8, anchor.top - bounds.height - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
    const descriptions = (target.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    target.setAttribute("aria-describedby", [...descriptions, id].join(" "));
    const observer = new MutationObserver(() => {
      if (
        !target.isConnected ||
        target.dataset.tooltip !== text ||
        target.closest("[hidden], dialog:not([open])")
      ) {
        ownerRef.current = null;
        setCurrent(null);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-tooltip", "hidden", "open"],
    });
    return () => {
      observer.disconnect();
      const remaining = (target.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((value) => value && value !== id);
      if (remaining.length) target.setAttribute("aria-describedby", remaining.join(" "));
      else target.removeAttribute("aria-describedby");
    };
  }, [current, id]);

  if (!current) return null;
  return createPortal(
    <div
      id={id}
      ref={tipRef}
      className="app-tooltip"
      role="tooltip"
      popover="manual"
      style={{ visibility: "hidden" }}
    >
      {current.text}
    </div>,
    current.target.closest("dialog[open], [popover]") ?? document.body,
  );
}
