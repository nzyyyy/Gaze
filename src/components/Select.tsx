import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export function Select<T extends string>({
  id,
  value,
  options,
  label,
  describedBy,
  disabled = false,
  autoFocus = false,
  onChange,
}: {
  id: string;
  value: T;
  options: readonly { value: T; label: string }[];
  label?: string;
  describedBy?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: T) => void;
}) {
  const selected = options.findIndex((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(Math.max(0, selected));
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const portalTarget = containerRef.current?.closest("dialog") ?? document.body;

  const show = () => {
    const rect = containerRef.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upwards = below < Math.min(240, options.length * 34 + 10) && above > below;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
    setPosition({
      position: "fixed",
      left,
      top: upwards ? undefined : rect.bottom + 6,
      bottom: upwards ? window.innerHeight - rect.top + 6 : undefined,
      minWidth: Math.min(rect.width, window.innerWidth - 16),
      maxWidth: window.innerWidth - left - 8,
      maxHeight: Math.max(34, Math.min(240, upwards ? above : below)),
    });
    setActive(Math.max(0, selected));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const close = () => setOpen(false);
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  };

  return (
    <div className="app-select" ref={containerRef}>
      <button
        id={id}
        type="button"
        className="app-select-trigger"
        role="combobox"
        aria-label={label}
        aria-labelledby={label ? undefined : `${id}-label`}
        aria-describedby={describedBy}
        disabled={disabled || options.length === 0}
        autoFocus={autoFocus}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-options` : undefined}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        onClick={() => {
          if (open) setOpen(false);
          else show();
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            if (open) choose(active);
            return;
          }
          if (event.key === "Escape") {
            if (open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) choose(active);
            else {
              show();
            }
            return;
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            if (!open) show();
            setActive(
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : open
                    ? (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
                      options.length
                    : Math.max(0, selected),
            );
            setOpen(true);
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const match = options.findIndex((option) =>
              option.label.toLowerCase().startsWith(event.key.toLowerCase()),
            );
            if (match >= 0) {
              event.preventDefault();
              if (!open) show();
              setActive(match);
              setOpen(true);
            }
          }
        }}
      >
        <span>{options[selected]?.label ?? "—"}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            style={position}
            id={`${id}-options`}
            className="app-select-options"
            role="listbox"
            aria-label={label}
            aria-labelledby={label ? undefined : `${id}-label`}
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((option, index) => (
              <li
                id={`${id}-option-${index}`}
                key={option.value}
                role="option"
                data-tooltip={option.label}
                aria-selected={value === option.value}
                className={active === index ? "is-active" : undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <Check
                  size={13}
                  aria-hidden
                  className={value === option.value ? "" : "is-hidden"}
                />
                <span>{option.label}</span>
              </li>
            ))}
          </ul>,
          portalTarget,
        )}
    </div>
  );
}
