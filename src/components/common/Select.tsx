import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

type SelectOption<T> = { value: T; label: string; description?: string };

export function Select<T extends string>({
  id,
  value,
  options: entries,
  label,
  describedBy,
  disabled = false,
  autoFocus = false,
  commitOnTab = true,
  triggerLabel,
  menuMaxWidth,
  onOpen,
  onChange,
}: {
  id: string;
  value: T;
  options: readonly (SelectOption<T> | { label: string; options: readonly SelectOption<T>[] })[];
  label?: string;
  describedBy?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  commitOnTab?: boolean;
  triggerLabel?: string;
  menuMaxWidth?: number;
  onOpen?: () => void;
  onChange: (value: T) => void;
}) {
  const options = entries.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
  const selected = options.findIndex((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [activeValue, setActive] = useState(value);
  const focused = options.findIndex((option) => option.value === activeValue);
  const active = focused >= 0 ? focused : Math.max(0, selected);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const portalTarget = containerRef.current?.closest("dialog") ?? document.body;

  const show = () => {
    const rect = containerRef.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upwards = below < Math.min(240, options.length * 34 + 10) && above > below;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
    const maxWidth = Math.min(menuMaxWidth ?? Infinity, window.innerWidth - left - 8);
    setPosition({
      position: "fixed",
      left,
      top: upwards ? undefined : rect.bottom + 6,
      bottom: upwards ? window.innerHeight - rect.top + 6 : undefined,
      minWidth: Math.min(rect.width, maxWidth),
      maxWidth,
      maxHeight: Math.max(34, Math.min(240, upwards ? above : below)),
    });
    setActive(options[Math.max(0, selected)]?.value ?? value);
    setOpen(true);
    onOpen?.();
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
    if (open) activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, activeValue]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  };

  let optionIndex = 0;
  const renderOption = (option: SelectOption<T>) => {
    const index = optionIndex++;
    return (
      <li
        id={`${id}-option-${index}`}
        key={option.value}
        role="option"
        ref={active === index ? activeRef : undefined}
        data-tooltip={option.description ?? option.label}
        aria-label={option.description ? `${option.label}, ${option.description}` : undefined}
        aria-selected={value === option.value}
        className={active === index ? "is-active" : undefined}
        onMouseEnter={() => setActive(option.value)}
        onClick={() => choose(index)}
      >
        <Check size={13} aria-hidden className={value === option.value ? "" : "is-hidden"} />
        <span className="app-select-option-text">
          <span>{option.label}</span>
          {option.description && (
            <span className="app-select-option-description">{option.description}</span>
          )}
        </span>
      </li>
    );
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
            if (open && commitOnTab) choose(active);
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
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : open
                    ? (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
                      options.length
                    : Math.max(0, selected);
            setActive(options[index]?.value ?? value);
            setOpen(true);
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const match = options.findIndex((option) =>
              option.label.toLowerCase().startsWith(event.key.toLowerCase()),
            );
            if (match >= 0) {
              event.preventDefault();
              if (!open) show();
              setActive(options[match]?.value ?? value);
              setOpen(true);
            }
          }
        }}
      >
        <span>{triggerLabel ?? options[selected]?.label ?? "—"}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={position}
            id={`${id}-options`}
            className="app-select-options"
            role="listbox"
            aria-label={label}
            aria-labelledby={label ? undefined : `${id}-label`}
            onMouseDown={(event) => event.preventDefault()}
          >
            <ul className="app-select-items" role="presentation">
              {entries.map((entry) =>
                "options" in entry ? (
                  <li key={entry.label} role="presentation" className="app-select-group">
                    <div className="app-select-group-label" aria-hidden="true">
                      {entry.label}
                    </div>
                    <ul role="group" aria-label={entry.label}>
                      {entry.options.map(renderOption)}
                    </ul>
                  </li>
                ) : (
                  renderOption(entry)
                ),
              )}
            </ul>
          </div>,
          portalTarget,
        )}
    </div>
  );
}
