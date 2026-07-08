/**
 * App-wide custom hover tooltip. Instead of wrapping every element, a single
 * <TooltipLayer/> (mounted once in App) intercepts any DOM `title` attribute —
 * however it got there, including `title` props passed through Dropdown, Toggle,
 * etc. — suppresses the native OS tooltip, and renders our own styled hover in a
 * portal. This replaces every native hover text app-wide with zero per-site
 * changes and no layout impact.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TipState {
  text: string;
  x: number;
  y: number;
  placement: "top" | "bottom" | "left" | "right";
}

/** Hover dwell before the tooltip appears (ms) — instant, like .ctx-tooltip. */
const SHOW_DELAY = 0;
/** Space above the trigger below which we flip the tooltip underneath. */
const FLIP_THRESHOLD = 48;
/** Tooltip-to-trigger gap. */
const GAP = 10;
/** Minimum viewport inset for clamped tooltips. */
const EDGE_PADDING = 6;

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState>();
  const elRef = useRef<HTMLElement | null>(null);
  const timer = useRef<number>();
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    /** Move a native `title` into `data-tip` so the OS tooltip never fires,
     *  then return the text to show. */
    const readAndStrip = (el: HTMLElement): string => {
      const title = el.getAttribute("title");
      if (title !== null) {
        el.setAttribute("data-tip", title);
        el.removeAttribute("title");
      }
      return el.getAttribute("data-tip") ?? "";
    };

    const place = (el: HTMLElement, text: string) => {
      const r = el.getBoundingClientRect();
      const preferred = el.getAttribute("data-tip-placement");

      if (preferred === "right" || preferred === "left") {
        const rightSpace = window.innerWidth - r.right;
        const leftSpace = r.left;
        const placement =
          preferred === "right"
            ? rightSpace >= leftSpace
              ? "right"
              : "left"
            : leftSpace >= rightSpace
              ? "left"
              : "right";
        setTip({
          text,
          x: Math.round(placement === "right" ? r.right + GAP : r.left - GAP),
          y: Math.round(r.top + r.height / 2),
          placement,
        });
        return;
      }

      const placement =
        preferred === "top" || preferred === "bottom"
          ? preferred
          : r.top > FLIP_THRESHOLD
            ? "top"
            : "bottom";
      setTip({
        text,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(placement === "top" ? r.top - GAP : r.bottom + GAP),
        placement,
      });
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        "[title], [data-tip]",
      ) as HTMLElement | null;
      if (!el) return;
      const text = readAndStrip(el);
      if (el === elRef.current) return; // already tracking this element
      elRef.current = el;
      window.clearTimeout(timer.current);
      setTip(undefined);
      if (!text) return;
      timer.current = window.setTimeout(() => place(el, text), SHOW_DELAY);
    };

    // React may re-apply `title` on re-render while hovering — keep it stripped
    // so the native tooltip stays suppressed.
    const onMove = () => {
      const el = elRef.current;
      if (el?.hasAttribute("title")) el.removeAttribute("title");
    };

    const onOut = (e: MouseEvent) => {
      const el = elRef.current;
      if (!el) return;
      const related = e.relatedTarget as Node | null;
      if (related && el.contains(related)) return; // moved to a child — keep
      elRef.current = null;
      window.clearTimeout(timer.current);
      setTip(undefined);
    };

    // Any click/scroll dismisses — the anchor position would otherwise drift.
    const dismiss = () => {
      elRef.current = null;
      window.clearTimeout(timer.current);
      setTip(undefined);
    };

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("mousedown", dismiss, true);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("mousedown", dismiss, true);
      window.removeEventListener("scroll", dismiss, true);
      window.clearTimeout(timer.current);
    };
  }, []);

  // Clamp to the viewport so long descriptions never render off-screen.
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!node || !tip) return;

    const width = node.offsetWidth;
    const height = node.offsetHeight;

    if (tip.placement === "top" || tip.placement === "bottom") {
      const half = width / 2;
      const min = EDGE_PADDING + half;
      const max = window.innerWidth - EDGE_PADDING - half;
      node.style.left = `${Math.min(max, Math.max(min, tip.x))}px`;

      if (tip.placement === "top") {
        node.style.top = `${Math.max(EDGE_PADDING + height, tip.y)}px`;
      } else {
        node.style.top = `${Math.min(window.innerHeight - EDGE_PADDING - height, tip.y)}px`;
      }
      return;
    }

    if (tip.placement === "right") {
      node.style.left = `${Math.min(window.innerWidth - EDGE_PADDING - width, Math.max(EDGE_PADDING, tip.x))}px`;
    } else {
      node.style.left = `${Math.min(window.innerWidth - EDGE_PADDING, Math.max(EDGE_PADDING + width, tip.x))}px`;
    }

    const half = height / 2;
    const min = EDGE_PADDING + half;
    const max = window.innerHeight - EDGE_PADDING - half;
    node.style.top = `${Math.min(max, Math.max(min, tip.y))}px`;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={tipRef}
      className={`tooltip tt-${tip.placement}`}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      <div className="tooltip-body">{tip.text}</div>
    </div>,
    document.body,
  );
}
