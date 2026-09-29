// The "?" beside a heading or a number: the explanation of that thing, one tap away instead of in
// the reading path.
//
// It replaces two things that did not work. A paragraph under every heading pushed the numbers a
// returning reader came for below the fold, and a native `title=` tooltip does not open on a phone
// at all and cannot be reached from the keyboard. This opens on click or tap, and from the keyboard
// like any button (Enter / Space). Escape closes it (focus goes back to the button if it was in the
// tip), and so does a click or a tap outside it — a touch that turns into a scroll does not. One is
// open at a time.
//
// The panel is rendered right after its button, so the tab order runs from the button into any
// links inside it, but positioned `fixed` against the viewport: tables and panels on these pages
// scroll sideways inside `overflow: auto` boxes, which would clip an absolutely placed panel. Two
// consequences for where a tip may go: not inside a heading (the open panel would become part of the
// heading's text), and not under an ancestor with a `transform` or `filter` (which would become the
// panel's containing block).

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { t } from "@/i18n/messages";

let openId: string | null = null;
const listeners = new Set<() => void>();

function setOpenId(id: string | null): void {
  if (openId === id) return;
  openId = id;
  for (const listener of [...listeners]) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

const GAP = 6;
const MARGIN = 8;
/** How far a touch may travel and still be a tap rather than the start of a scroll, px. */
const TAP_SLOP = 10;

/** The panel's width: the preferred one, or the viewport less a margin on each side. */
function panelWidth(preferred: number): number {
  return Math.min(preferred, document.documentElement.clientWidth - MARGIN * 2);
}

interface Placement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function InfoTip({
  label,
  title,
  children,
  width = 380,
}: {
  /** What is being explained; the button is announced as "About {label}". */
  label: string;
  /** Optional heading inside the panel. */
  title?: string;
  children: React.ReactNode;
  /** Preferred panel width in px; never wider than the viewport less a margin. */
  width?: number;
}) {
  const id = useId();
  const current = useSyncExternalStore(
    subscribe,
    () => openId,
    () => null,
  );
  const open = current === id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const r = button.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = panelWidth(width);
    const left = Math.max(
      MARGIN,
      Math.min(r.left + r.width / 2 - w / 2, vw - w - MARGIN),
    );
    const below = vh - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    // Measured at the width it will be shown at (the hidden first pass uses the same width), so
    // an upward panel ends at the button rather than short of it.
    // scrollHeight is the content's full height even while maxHeight clips it; + its 1px borders.
    const height = (panelRef.current?.scrollHeight ?? 0) + 2;
    // Below the button unless it does not fit there and there is more room above.
    const downward = height <= below || below >= above;
    // Never taller than the side it opens on, even when that side is small (a landscape phone).
    const maxHeight = Math.max(0, downward ? below : above);
    const top = downward
      ? r.bottom + GAP
      : Math.max(MARGIN, r.top - GAP - Math.min(height, maxHeight));
    setPlacement({ top, left, width: w, maxHeight });
  }, [width]);

  // Measure after the panel has rendered (hidden) once, then show it in place.
  useLayoutEffect(() => {
    if (open) place();
    else setPlacement(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (buttonRef.current?.contains(target) ||
        panelRef.current?.contains(target));
    // A mouse press outside closes it at once. A touch outside closes it only if it was a tap: a
    // touch that becomes a scroll is a finger that meant only to read on, and the panel follows
    // the button instead (below).
    let touchStart: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      if (inside(e.target)) return;
      if (e.pointerType === "touch")
        touchStart = { x: e.clientX, y: e.clientY };
      else setOpenId(null);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!touchStart || e.pointerType !== "touch") return;
      const moved = Math.hypot(
        e.clientX - touchStart.x,
        e.clientY - touchStart.y,
      );
      touchStart = null;
      if (moved < TAP_SLOP && !inside(e.target)) setOpenId(null);
    };
    const onPointerCancel = () => {
      // The browser took the touch over for scrolling.
      touchStart = null;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpenId(null);
      // Back to the button only if focus was with the tip; a reader who opened it with the mouse
      // and has since moved focus elsewhere keeps their place.
      const active = document.activeElement;
      if (!active || active === document.body || inside(active))
        buttonRef.current?.focus();
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, place]);

  // Unmounting while open (a route change) must not leave the store pointing at nothing.
  useEffect(
    () => () => {
      if (openId === id) setOpenId(null);
    },
    [id],
  );

  const panelId = `${id}-tip`;
  return (
    <span
      style={{ display: "inline-flex", verticalAlign: "middle" }}
      onBlur={(e) => {
        // Tabbing past the last link inside closes it; a click on the panel's own text does not
        // (that blur has no related target).
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next)) setOpenId(null);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("tip.about", { label })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(e) => {
          // A tip inside a clickable row explains the row; it does not open it.
          e.stopPropagation();
          setOpenId(open ? null : id);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "22px",
          height: "22px",
          padding: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            border: `1px solid ${open ? "var(--pink-500)" : "var(--border-strong)"}`,
            color: open ? "var(--pink-500)" : "var(--text-tertiary)",
            background: open
              ? "color-mix(in oklch, var(--pink-500) 14%, transparent)"
              : "transparent",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            font: "var(--weight-semibold) 10px var(--font-mono)",
            lineHeight: 1,
          }}
        >
          ?
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={title ?? label}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            zIndex: 60,
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            width: placement?.width ?? panelWidth(width),
            maxHeight: placement?.maxHeight,
            overflowY: "auto",
            visibility: placement ? "visible" : "hidden",
            boxSizing: "border-box",
            padding: "12px 14px",
            background: "var(--bg-surface-raised)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            color: "var(--text-secondary)",
            font: "var(--text-sm) var(--font-sans)",
            lineHeight: 1.6,
            textAlign: "left",
            textTransform: "none",
            letterSpacing: "normal",
            whiteSpace: "normal",
            fontWeight: "var(--weight-regular)" as never,
            cursor: "auto",
          }}
        >
          <button
            type="button"
            aria-label={t("tip.close")}
            onClick={() => {
              setOpenId(null);
              buttonRef.current?.focus();
            }}
            style={{
              position: "absolute",
              top: "6px",
              right: "6px",
              width: "24px",
              height: "24px",
              border: "none",
              background: "transparent",
              color: "var(--text-tertiary)",
              font: "var(--text-base) var(--font-mono)",
              lineHeight: 1,
              padding: 0,
              cursor: "pointer",
            }}
          >
            ×
          </button>
          {title && (
            <span
              style={{
                display: "block",
                marginBottom: "6px",
                paddingRight: "20px",
                font: "var(--weight-semibold) var(--text-sm) var(--font-sans)",
                color: "var(--text-primary)",
              }}
            >
              {title}
            </span>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              paddingRight: title ? 0 : "18px",
            }}
          >
            {children}
          </div>
        </div>
      )}
    </span>
  );
}

/** A paragraph inside an InfoTip. */
export function TipText({ children }: { children: React.ReactNode }) {
  return <span style={{ display: "block" }}>{children}</span>;
}
