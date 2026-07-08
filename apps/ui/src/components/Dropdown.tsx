/**
 * Custom dropdown used across the app instead of native <select> — supports
 * groups, hints, selected checkmark, opening upward (composer controls), and
 * an optional search bar for long lists (e.g. the model selector).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { SearchBar } from "./SearchBar.js";

export interface DropdownOption {
  value: string;
  label: ReactNode;
  /** Plain text used for filtering when label is rendered markup. */
  searchText?: string;
  /** Dim right-aligned text (e.g. provider name, "configured"). */
  hint?: string;
  /** Optional group header (options are rendered grouped, in first-seen order). */
  group?: string;
}

export function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled,
  title,
  up,
  className,
  searchable,
}: {
  options: DropdownOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  /** Open the menu above the trigger (for controls near the bottom edge). */
  up?: boolean;
  className?: string;
  /** Show a filter field at the top of the menu (for long lists). */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Keyboard-highlighted option value (arrow keys / hover). */
  const [active, setActive] = useState<string>();
  const selected = options.find((o) => o.value === value);

  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Item DOM nodes, keyed by value, for scroll-into-view on keyboard nav. */
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  // Close on any click/tap outside the dropdown. A document listener works even
  // inside dialogs/modals, where the fixed overlay sits below the dialog and
  // never receives the click.
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onOutside, true);
    return () => document.removeEventListener("mousedown", onOutside, true);
  }, [open]);

  /** Match against string labels, hints, and values. */
  const needle = query.trim().toLowerCase();
  const visible =
    searchable && needle
      ? options.filter((o) =>
          [
            o.searchText ?? (typeof o.label === "string" ? o.label : ""),
            o.hint ?? "",
            o.value,
            o.group ?? "",
          ].some((s) => s.toLowerCase().includes(needle)),
        )
      : options;

  const groups: (string | undefined)[] = [];
  for (const option of visible) {
    if (!groups.includes(option.group)) groups.push(option.group);
  }

  /** Options in the order they're actually rendered (grouped) — this is the
   *  order arrow keys walk through. */
  const ordered = groups.flatMap((group) => visible.filter((o) => o.group === group));

  const pick = (v: string) => {
    close();
    onChange(v);
  };

  // On open (and whenever the filter changes the list), highlight the selected
  // option, or the first one.
  useEffect(() => {
    if (!open) return;
    setActive(ordered.some((o) => o.value === value) ? value : ordered[0]?.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  // Focus the menu itself when there's no search field, so it receives keys.
  useEffect(() => {
    if (open && !searchable) menuRef.current?.focus();
  }, [open, searchable]);

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (open && active) itemRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const move = (delta: number) => {
    if (ordered.length === 0) return;
    const i = ordered.findIndex((o) => o.value === active);
    const next = Math.min(ordered.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
    setActive(ordered[next]?.value);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setActive(ordered[0]?.value);
        break;
      case "End":
        e.preventDefault();
        setActive(ordered[ordered.length - 1]?.value);
        break;
      case "Enter":
        if (active !== undefined) {
          e.preventDefault();
          pick(active);
        }
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
    }
  };

  return (
    <div ref={rootRef} className={`dd ${className ?? ""}`}>
      <button
        type="button"
        className={`dd-trigger ${open ? "open" : ""}`}
        disabled={disabled}
        title={title}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="dd-label">{selected?.label ?? placeholder}</span>
        <span className="dd-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="dd-overlay" onClick={close} />
          <div
            ref={menuRef}
            className={`dd-menu ${up ? "up" : ""}`}
            role="listbox"
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            {searchable && (
              <div className="dd-search">
                <SearchBar value={query} onChange={setQuery} placeholder="Filter…" autoFocus />
              </div>
            )}
            {groups.map((group) => (
              <div key={group ?? "_"} className="dd-group">
                {group && <div className="dd-group-title">{group}</div>}
                {visible
                  .filter((o) => o.group === group)
                  .map((o) => (
                    <button
                      type="button"
                      key={o.value}
                      ref={(el) => {
                        itemRefs.current[o.value] = el;
                      }}
                      role="option"
                      aria-selected={o.value === value}
                      className={`dd-item ${o.value === value ? "selected" : ""} ${
                        o.value === active ? "active" : ""
                      }`}
                      onClick={() => pick(o.value)}
                      onMouseMove={() => setActive(o.value)}
                    >
                      <span className="dd-item-label">{o.label}</span>
                      {o.hint && <span className="dd-item-hint">{o.hint}</span>}
                      {o.value === value && <span className="dd-check">✓</span>}
                    </button>
                  ))}
              </div>
            ))}
            {visible.length === 0 && (
              <div className="dd-empty">{needle ? `No match for “${query}”` : "No options"}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
