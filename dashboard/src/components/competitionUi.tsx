// Pieces shared by the competition-level views: the standings table on the home page and the
// standing section of an agent page. One copy of "how a standing is formatted" keeps the two from
// disagreeing about what an agent scored.

import { formatBps } from "@/lib/format";

export function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  /** A link rendered on the header's right. */
  action?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-surface)",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <header
        style={{
          padding: "13px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "3px",
            minWidth: 0,
          }}
        >
          <span
            style={{
              font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
              letterSpacing: "var(--tracking-widest)",
              textTransform: "uppercase",
              color: "var(--text-secondary)",
            }}
          >
            {title}
          </span>
          {subtitle && (
            <span
              style={{
                font: "var(--text-xs) var(--font-sans)",
                color: "var(--text-tertiary)",
                lineHeight: 1.5,
              }}
            >
              {subtitle}
            </span>
          )}
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--text-link)",
              font: "var(--text-xs) var(--font-mono)",
              cursor: "pointer",
              padding: 0,
              whiteSpace: "nowrap",
            }}
          >
            {action.label}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  caps = true,
}: {
  label: string;
  value: string;
  /** Off for labels carrying a symbol the uppercase transform would mangle (λ → Λ). */
  caps?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-wide)",
          textTransform: caps ? "uppercase" : "none",
        }}
      >
        {label}
      </span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-sm) var(--font-mono)",
          color: "var(--text-primary)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** An aggregated standing (a z-score average): unitless, signed. */
export function formatStanding(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(3);
}

/** A spread, not a direction: a leading "+" on a standard deviation reads as a gain that is not one. */
export function formatSpreadBps(value: number): string {
  return formatBps(Math.abs(value)).replace(/^\+/, "");
}

export function toneColor(value: number): string {
  if (value > 0) return "var(--success-text)";
  if (value < 0) return "var(--danger-text)";
  return "var(--text-tertiary)";
}

/** null is "no previous round to compare against", which is not the same claim as "did not move". */
export function MoveCell({ move }: { move: number | null }) {
  if (move === null)
    return (
      <span
        style={{
          textAlign: "center",
          color: "var(--text-disabled)",
          font: "var(--text-xs) var(--font-mono)",
        }}
      >
        ·
      </span>
    );
  return (
    <span
      style={{
        textAlign: "center",
        font: "var(--text-xs) var(--font-mono)",
        color:
          move > 0
            ? "var(--success-text)"
            : move < 0
              ? "var(--danger-text)"
              : "var(--text-disabled)",
      }}
    >
      {move === 0 ? "—" : move > 0 ? `▲${move}` : `▼${-move}`}
    </span>
  );
}
