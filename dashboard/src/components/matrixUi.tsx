// Pieces shared by the matrix-level pages: the home overview and the full standings.
//
// Extracted rather than duplicated because the two pages show the same quantities at different
// depth — a top-five card and a full table are the same numbers formatted twice, and two copies of
// "how a total is formatted" is two chances for the home and the standings to disagree about what
// an agent scored.

import { METRICS, type Aggregator, type MetricKey } from "@/data/matrixScoring";
import { formatBps, formatPnlUsdc } from "@/lib/format";

export function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  /** A link rendered on the header's right — "see all →" on the home cards. */
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

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-wide)",
          textTransform: "uppercase",
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

/** A metric's own units. Log-growth metrics are shown in bps so they are not a wall of zeroes. */
export function formatMetric(value: number, metric: MetricKey): string {
  const unit = METRICS.find((m) => m.key === metric)?.unit ?? "usdc";
  if (unit === "usdc") return formatPnlUsdc(value);
  if (unit === "ratio") return (value >= 0 ? "+" : "") + value.toFixed(3);
  return formatBps(value * 10_000);
}

/** An aggregated total. Only `mean` keeps the metric's units; the others produce their own scale. */
export function formatTotal(
  value: number,
  aggregator: Aggregator,
  metric: MetricKey,
): string {
  if (aggregator === "mean") return formatMetric(value, metric);
  if (aggregator === "borda") return value.toFixed(2);
  return (value >= 0 ? "+" : "") + value.toFixed(3);
}

/** A spread, not a direction: a leading "+" on a standard deviation reads as a gain that is not one. */
export function formatSpreadBps(value: number): string {
  return formatBps(Math.abs(value)).replace(/^\+/, "");
}

/** "1 scenarios" reads as a bug in the code rather than as a matrix with one scenario in it. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
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
