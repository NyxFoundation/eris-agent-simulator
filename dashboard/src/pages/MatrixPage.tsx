// Standings over a scenario matrix — the unit the competition is actually scored on (ADR 0020).
//
// The page deliberately does not present one table as the answer. Two independent choices produce a
// standing in `scenario` mode (the per-scenario metric and the cross-scenario aggregation), neither
// is settled, and ADR 0019 retired the incumbent aggregator without naming a successor. So the
// controls are first-class, the disagreement between combinations is shown next to the standings
// rather than in an appendix, and every row opens into the round-level distribution that explains
// why it sits where it does.

import { useEffect, useMemo, useState } from "react";
import { RoundCursorBar } from "@/components/RoundCursorBar";
import { Sidebar } from "@/components/Sidebar";
import { scenarioRunId } from "@/data/matrixArtifacts";
import {
  AGGREGATORS,
  buildStandings,
  compareCombinations,
  decomposeAgent,
  DEFAULT_AGGREGATOR,
  DEFAULT_LAMBDA,
  DEFAULT_METRIC,
  DEFAULT_RHO,
  ENDPOINT_ONLY_METRICS,
  METRICS,
  rankMoves,
  SERIES_METRICS,
  type Aggregator,
  type MatrixStandings,
  type MetricKey,
  type ScoringParams,
} from "@/data/matrixScoring";
import { windowsAtRound } from "@/data/matrixSchedule";
import { setCursorRange, useCursor } from "@/data/roundCursor";
import {
  useMatrixSnapshot,
  type MatrixSnapshot,
} from "@/data/useMatrixSnapshot";
import { setSelectedRound } from "@/data/roundSelection";
import { getSelectedRunId, setSelectedRunId } from "@/data/runSelection";
import { Select } from "@/design-system/Select";
import { formatBps, formatPnlUsdc } from "@/lib/format";
import { navigate } from "@/navigation";
import { TopPage } from "./TopPage";

const PAGE_MAX_WIDTH = "1320px";

// ---------------------------------------------------------------------------
// small shared pieces

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
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
          flexDirection: "column",
          gap: "3px",
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
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
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
function formatMetric(value: number, metric: MetricKey): string {
  const unit = METRICS.find((m) => m.key === metric)?.unit ?? "usdc";
  if (unit === "usdc") return formatPnlUsdc(value);
  if (unit === "ratio") return (value >= 0 ? "+" : "") + value.toFixed(3);
  return formatBps(value * 10_000);
}

/** An aggregated total. Only `mean` keeps the metric's units; the others produce their own scale. */
function formatTotal(
  value: number,
  aggregator: Aggregator,
  metric: MetricKey,
): string {
  if (aggregator === "mean") return formatMetric(value, metric);
  if (aggregator === "borda") return value.toFixed(2);
  return (value >= 0 ? "+" : "") + value.toFixed(3);
}

/** A spread, not a direction: a leading "+" on a standard deviation reads as a gain that is not one. */
function formatSpreadBps(value: number): string {
  return formatBps(Math.abs(value)).replace(/^\+/, "");
}

function toneColor(value: number): string {
  if (value > 0) return "var(--success-text)";
  if (value < 0) return "var(--danger-text)";
  return "var(--text-tertiary)";
}

// ---------------------------------------------------------------------------
// controls

function Controls({
  metric,
  aggregator,
  params,
  fromSeries,
  scrubbing,
  onMetric,
  onAggregator,
  onParams,
}: {
  metric: MetricKey;
  aggregator: Aggregator;
  params: ScoringParams;
  fromSeries: boolean;
  scrubbing: boolean;
  onMetric: (m: MetricKey) => void;
  onAggregator: (a: Aggregator) => void;
  onParams: (p: ScoringParams) => void;
}) {
  const hint = METRICS.find((m) => m.key === metric)?.hint ?? "";
  // One slot, because only one of the two parameters is ever live: lambda is M9's risk charge and
  // rho is M7's risk aversion. Showing both at once would suggest a combination that does not exist.
  const knob =
    metric === "score"
      ? ({
          label: `λ = ${params.lambda.toFixed(2)}${params.lambda === DEFAULT_LAMBDA ? "  (ADR 0019)" : ""}`,
          min: 0,
          max: 1,
          step: 0.05,
          value: params.lambda,
          set: (v: number) => onParams({ ...params, lambda: v }),
        } as const)
      : metric === "mppm"
        ? ({
            label: `ρ = ${params.rho.toFixed(1)}${params.rho === DEFAULT_RHO ? "  (default)" : ""}`,
            min: 1,
            max: 6,
            step: 0.5,
            value: params.rho,
            set: (v: number) => onParams({ ...params, rho: v }),
          } as const)
        : null;
  return (
    <Panel
      title="Ranking rule"
      subtitle="Two independent choices. Neither is settled — #56 is open on the metric, and ADR 0019 retired the incumbent aggregator without naming a successor."
    >
      <div
        style={{
          padding: "16px",
          display: "flex",
          gap: "20px",
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            minWidth: "230px",
          }}
        >
          <span
            style={{
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
              letterSpacing: "var(--tracking-wide)",
            }}
          >
            METRIC · one scenario → one number
          </span>
          <Select
            value={metric}
            options={METRICS.map((m) => ({
              // The two final-marks metrics price both ends at the run's last prices, so there is
              // no "value at round k" to take. While the cursor is mid-competition they are not
              // offered rather than silently showing the finished number under a round label.
              label:
                scrubbing && ENDPOINT_ONLY_METRICS.includes(m.key)
                  ? `${m.label}  (end only)`
                  : m.label,
              value: m.key,
              disabled: scrubbing && ENDPOINT_ONLY_METRICS.includes(m.key),
            }))}
            onChange={(e) => onMetric(e.target.value as MetricKey)}
          />
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            minWidth: "190px",
          }}
        >
          <span
            style={{
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
              letterSpacing: "var(--tracking-wide)",
            }}
          >
            AGGREGATION · 35 numbers → one standing
          </span>
          <Select
            value={aggregator}
            options={AGGREGATORS.map((a) => ({
              label:
                a === "zscore"
                  ? "z-score (incumbent)"
                  : a === "borda"
                    ? "Borda (rank)"
                    : "mean (absolute)",
              value: a,
            }))}
            onChange={(e) => onAggregator(e.target.value as Aggregator)}
          />
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            minWidth: "220px",
            opacity: knob ? 1 : 0.4,
          }}
        >
          <span
            style={{
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
              letterSpacing: "var(--tracking-wide)",
            }}
          >
            {knob?.label ?? "no parameter"}
          </span>
          <input
            type="range"
            min={knob?.min ?? 0}
            max={knob?.max ?? 1}
            step={knob?.step ?? 0.05}
            value={knob?.value ?? 0}
            disabled={!knob}
            onChange={(e) => knob?.set(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--pink-500)" }}
          />
          <span
            style={{
              font: "var(--text-xs) var(--font-sans)",
              color: "var(--text-tertiary)",
              lineHeight: 1.5,
            }}
          >
            {!knob
              ? "this metric has none"
              : fromSeries
                ? "recomputed from each run's stored epoch series"
                : "no epoch series on disk — showing the values as scored"}
          </span>
        </label>
      </div>
      <div
        style={{
          padding: "0 16px 14px",
          font: "var(--text-xs) var(--font-sans)",
          color: "var(--text-tertiary)",
          lineHeight: 1.6,
        }}
      >
        {hint}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// round decomposition — the answer to "why is this agent here"

function ReturnHistogram({ values }: { values: number[] }) {
  const bins = 41;
  const bps = values.map((v) => v * 10_000);
  // Scaled to a high quantile rather than the maximum. These distributions are the point of the
  // panel and most of them have one round orders of magnitude past the rest -- scaling to it puts
  // every other round in the middle bin and draws a single spike, which is the shape of the axis
  // rather than the shape of the returns. The rounds past the edge are counted into the end bins
  // and reported below, so nothing is hidden, only compressed at the tails.
  const sortedAbs = [...bps].map(Math.abs).sort((a, b) => a - b);
  const quantile =
    sortedAbs[
      Math.min(sortedAbs.length - 1, Math.floor(sortedAbs.length * 0.98))
    ] ?? 0;
  const edge = Math.max(quantile, 1e-9);
  const clipped = bps.filter((v) => Math.abs(v) > edge).length;
  const counts = new Array(bins).fill(0) as number[];
  for (const v of bps) {
    const idx = Math.min(
      bins - 1,
      Math.max(0, Math.floor(((v + edge) / (2 * edge)) * bins)),
    );
    counts[idx] += 1;
  }
  const peak = Math.max(...counts, 1);
  const width = 100 / bins;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <svg
        viewBox="0 0 100 34"
        preserveAspectRatio="none"
        style={{ width: "100%", height: "70px", display: "block" }}
      >
        {counts.map((c, i) => {
          const h = (c / peak) * 32;
          const centre = -edge + ((i + 0.5) / bins) * 2 * edge;
          return (
            <rect
              key={i}
              x={i * width}
              y={33 - h}
              width={width * 0.86}
              height={h}
              fill={
                centre >= 0
                  ? "color-mix(in oklch, var(--green-500), transparent 35%)"
                  : "color-mix(in oklch, var(--red-500), transparent 35%)"
              }
            />
          );
        })}
        <line
          x1="50"
          y1="0"
          x2="50"
          y2="33"
          stroke="var(--border-strong)"
          strokeWidth="0.3"
        />
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
        }}
      >
        <span>≤ {formatBps(-edge)}</span>
        <span>
          {clipped > 0
            ? `0 · ${clipped} round${clipped === 1 ? "" : "s"} past the edge, stacked into the end bins`
            : "0"}
        </span>
        <span>≥ {formatBps(edge)}</span>
      </div>
    </div>
  );
}

function Decomposition({
  agentId,
  snapshot,
  lambda,
}: {
  agentId: string;
  snapshot: MatrixSnapshot;
  lambda: number;
}) {
  const d = useMemo(
    () => decomposeAgent(agentId, snapshot.matrix, snapshot.rounds, lambda),
    [agentId, snapshot, lambda],
  );

  if (!d) {
    return (
      <div
        style={{
          padding: "16px 20px",
          font: "var(--text-sm) var(--font-sans)",
          color: "var(--text-tertiary)",
          background: "var(--bg-sunken)",
        }}
      >
        No epoch series on disk for this agent — the scenario runs behind this
        matrix were not collected, so the standings can be shown but not
        explained.
      </div>
    );
  }

  const penalty = lambda * d.stats.std;
  return (
    <div
      style={{
        padding: "18px 20px 22px",
        background: "var(--bg-sunken)",
        borderBottom: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <p
        style={{
          margin: 0,
          font: "var(--text-xs) var(--font-sans)",
          color: "var(--text-tertiary)",
          lineHeight: 1.6,
          maxWidth: "78ch",
        }}
      >
        Every epoch this agent produced, pooled across the whole matrix. This is
        not how the standings are computed — M9 is per scenario, then averaged
        per regime — it is what the standings cannot show: an agent can earn
        several times more per round than the winner and still place last, and
        the whole of the difference is the spread λ charges for.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "14px",
        }}
      >
        <Stat label="rounds" value={String(d.stats.epochs)} />
        <Stat label="mean / round" value={formatBps(d.stats.mean * 10_000)} />
        <Stat
          label="std / round"
          value={formatSpreadBps(d.stats.std * 10_000)}
        />
        <Stat
          label={`λ·std (λ=${lambda.toFixed(2)})`}
          value={formatSpreadBps(penalty * 10_000)}
        />
        <Stat label="mean − λ·std" value={formatBps(d.stats.score * 10_000)} />
      </div>

      <ReturnHistogram values={d.pooled} />

      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-tertiary)",
            letterSpacing: "var(--tracking-wide)",
            textTransform: "uppercase",
          }}
        >
          by regime
        </span>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: "560px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 80px 90px 90px 100px",
                padding: "6px 8px",
                font: "var(--text-xs) var(--font-mono)",
                color: "var(--text-tertiary)",
                borderBottom: "1px solid var(--border-subtle)",
                textTransform: "uppercase",
                letterSpacing: "var(--tracking-wide)",
              }}
            >
              <span>regime</span>
              <span style={{ textAlign: "right" }}>rounds</span>
              <span style={{ textAlign: "right" }}>mean</span>
              <span style={{ textAlign: "right" }}>std</span>
              <span style={{ textAlign: "right" }}>mean − λ·std</span>
            </div>
            {d.byRegime.map((r) => (
              <div
                key={r.regime}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px 90px 90px 100px",
                  padding: "6px 8px",
                  font: "var(--text-xs) var(--font-mono)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <span style={{ color: "var(--text-secondary)" }}>
                  {r.regime}
                </span>
                <span
                  style={{ textAlign: "right", color: "var(--text-tertiary)" }}
                >
                  {r.stats.epochs}
                </span>
                <span
                  style={{ textAlign: "right", color: toneColor(r.stats.mean) }}
                >
                  {formatBps(r.stats.mean * 10_000)}
                </span>
                <span
                  style={{ textAlign: "right", color: "var(--text-secondary)" }}
                >
                  {formatSpreadBps(r.stats.std * 10_000)}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: toneColor(r.stats.score),
                  }}
                >
                  {formatBps(r.stats.score * 10_000)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {d.bankruptIn.length > 0 && (
        <div
          style={{
            font: "var(--text-xs) var(--font-sans)",
            color: "var(--danger-text)",
            lineHeight: 1.6,
          }}
        >
          Hit the bankruptcy floor in {d.bankruptIn.length} scenario
          {d.bankruptIn.length === 1 ? "" : "s"} (ADR 0019 G1/G2 — every later
          round is frozen at a return of 0):{" "}
          {d.bankruptIn
            .map((b) => `${b.regime}#${b.seed} @ round ${b.epoch}`)
            .join(", ")}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// what the environment did in this round

function ThisRoundPanel({
  snapshot,
  round,
  standings,
  moves,
}: {
  snapshot: MatrixSnapshot;
  round: number;
  standings: MatrixStandings;
  moves: Map<string, number | null>;
}) {
  const open = useMemo(
    () => windowsAtRound(snapshot.schedules, round),
    [snapshot, round],
  );
  const opening = open.filter((w) => w.opening);
  const movers = standings.rows
    .map((r) => ({ id: r.id, move: moves.get(r.id) ?? null }))
    .filter((m): m is { id: string; move: number } => (m.move ?? 0) !== 0)
    .sort((a, b) => Math.abs(b.move) - Math.abs(a.move))
    .slice(0, 5);

  return (
    <Panel
      title={`Round ${round}`}
      subtitle="What the environment was scheduled to do here, and who it moved. The schedule is drawn from each scenario's seed before its first block, so these are the planned windows — crash, spike, cexDrift and flowTrend change the price walk itself and leave no per-block record."
    >
      <div
        style={{
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {open.length === 0 ? (
          <span
            style={{
              font: "var(--text-sm) var(--font-sans)",
              color: "var(--text-tertiary)",
            }}
          >
            No scheduled window covers this round in any scenario — every world
            is in its ordinary regime here.
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {open.slice(0, 8).map((w) => (
              <div
                key={`${w.key}:${w.window.type}:${w.window.fromRound}`}
                onClick={() => {
                  setSelectedRunId(w.runId);
                  navigate("/run");
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "88px 1fr 170px",
                  gap: "10px",
                  alignItems: "center",
                  font: "var(--text-xs) var(--font-mono)",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    color: w.opening
                      ? "var(--warning-text)"
                      : "var(--text-tertiary)",
                  }}
                >
                  {w.opening ? "opens" : "open"}
                </span>
                <span style={{ color: "var(--text-primary)" }}>
                  {w.window.type}
                  {w.window.venue ? ` · ${w.window.venue}` : ""}
                  {w.window.stable ? ` · ${w.window.stable}` : ""}
                </span>
                <span
                  style={{ textAlign: "right", color: "var(--text-secondary)" }}
                >
                  {w.regime.replace(/^full-/, "")}#{w.seed}
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {" "}
                    r{w.window.fromRound}–{w.window.toRound}
                  </span>
                </span>
              </div>
            ))}
            {open.length > 8 && (
              <span
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                + {open.length - 8} more
              </span>
            )}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "14px",
            flexWrap: "wrap",
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: "11px",
          }}
        >
          <span style={{ ...LABEL_UPPER }}>moved this round</span>
          {movers.length === 0 ? (
            <span
              style={{
                font: "var(--text-xs) var(--font-mono)",
                color: "var(--text-tertiary)",
              }}
            >
              {round <= 1
                ? "no previous round to compare"
                : "nobody changed place"}
            </span>
          ) : (
            movers.map((m) => (
              <span
                key={m.id}
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color:
                    m.move > 0 ? "var(--success-text)" : "var(--danger-text)",
                }}
              >
                {m.id} {m.move > 0 ? `▲${m.move}` : `▼${-m.move}`}
              </span>
            ))
          )}
        </div>

        {opening.length > 0 && (
          <span
            style={{
              font: "var(--text-xs) var(--font-sans)",
              color: "var(--text-tertiary)",
              lineHeight: 1.6,
            }}
          >
            A window opening in one scenario moves the whole standing, because a
            scenario is a seventh of a regime and a regime is a seventh of the
            total.
          </span>
        )}
      </div>
    </Panel>
  );
}

const LABEL_UPPER = {
  font: "var(--text-xs) var(--font-mono)",
  color: "var(--text-tertiary)",
  letterSpacing: "var(--tracking-wide)",
  textTransform: "uppercase" as const,
};

// ---------------------------------------------------------------------------
// standings

/** null is "no previous round to compare against", which is not the same claim as "did not move". */
function MoveCell({ move }: { move: number | null }) {
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

function StandingsTable({
  standings,
  snapshot,
  lambda,
  moves,
}: {
  standings: MatrixStandings;
  snapshot: MatrixSnapshot;
  lambda: number;
  moves: Map<string, number | null>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const regimes = standings.regimes;
  const columns = `36px 46px 150px 96px repeat(${regimes.length}, minmax(74px, 1fr)) 74px`;
  const at = standings.throughRound;

  return (
    <Panel
      title={
        at === null
          ? `Standings · final · ${standings.rows.length} agents · ${standings.cells.length} scenarios`
          : `Standings · through round ${at} · ${standings.rows.length} agents`
      }
      subtitle={
        at === null
          ? "Regimes are weighted equally regardless of how many seeds each contributed (ADR 0017 §3). Open a row for the round-level distribution behind it."
          : `Recomputed over the first ${at} round${at === 1 ? "" : "s"} of every scenario, not read off the finished run — the cursor must never show the future. The arrow is the move since round ${at - 1}.`
      }
    >
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: `${360 + regimes.length * 80}px` }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: columns,
              padding: "9px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
              letterSpacing: "var(--tracking-wide)",
              textTransform: "uppercase",
              position: "sticky",
              top: 0,
              background: "var(--bg-surface)",
            }}
          >
            <span>#</span>
            <span style={{ textAlign: "center" }}>move</span>
            <span>agent</span>
            <span style={{ textAlign: "right" }}>total</span>
            {regimes.map((r) => (
              <span key={r} style={{ textAlign: "right" }} title={r}>
                {r.replace(/^full-/, "")}
              </span>
            ))}
            <span style={{ textAlign: "right" }}>scen.</span>
          </div>

          {standings.rows.map((row, i) => {
            const isOpen = open === row.id;
            return (
              <div key={row.id}>
                <div
                  onClick={() => setOpen(isOpen ? null : row.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--border-subtle)",
                    font: "var(--text-sm) var(--font-mono)",
                    cursor: "pointer",
                    background: isOpen ? "var(--bg-surface-raised)" : undefined,
                  }}
                >
                  <span style={{ color: "var(--text-tertiary)" }}>{i + 1}</span>
                  <MoveCell move={moves.get(row.id) ?? null} />
                  <span
                    style={{
                      color: "var(--text-link)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={row.id}
                  >
                    {isOpen ? "▾ " : "▸ "}
                    {row.id}
                  </span>
                  <span
                    style={{
                      textAlign: "right",
                      color: toneColor(row.total),
                      fontWeight: "var(--weight-semibold)" as never,
                    }}
                  >
                    {formatTotal(
                      row.total,
                      standings.aggregator,
                      standings.metric,
                    )}
                  </span>
                  {regimes.map((r) => {
                    const v = row.byRegime[r];
                    return (
                      <span
                        key={r}
                        style={{
                          textAlign: "right",
                          font: "var(--text-xs) var(--font-mono)",
                          color:
                            v === undefined
                              ? "var(--text-disabled)"
                              : toneColor(v),
                        }}
                      >
                        {v === undefined
                          ? "—"
                          : formatTotal(
                              v,
                              standings.aggregator,
                              standings.metric,
                            )}
                      </span>
                    );
                  })}
                  <span
                    style={{
                      textAlign: "right",
                      font: "var(--text-xs) var(--font-mono)",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    {row.scenariosScored}
                  </span>
                </div>
                {isOpen && (
                  <Decomposition
                    agentId={row.id}
                    snapshot={snapshot}
                    lambda={lambda}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// heatmap: scenario x agent, grouped by regime

function Heatmap({ standings }: { standings: MatrixStandings }) {
  // Column order follows the standings so the shape of the field reads top-to-bottom as a ranking.
  const agents = standings.rows.map((r) => r.id);
  const cells = standings.cells;

  return (
    <Panel
      title="Scenario × agent"
      subtitle="Colour is that scenario's own z-score of the selected metric, so rows are comparable to each other rather than to the field's absolute scale. Click a cell to open that scenario."
    >
      <div style={{ overflowX: "auto" }}>
        <div
          style={{
            minWidth: `${190 + agents.length * 34}px`,
            padding: "0 16px 16px",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `170px repeat(${agents.length}, 1fr)`,
              gap: "2px",
              alignItems: "end",
              paddingTop: "12px",
            }}
          >
            <span />
            {agents.map((a) => (
              <span
                key={a}
                title={a}
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                  writingMode: "vertical-rl",
                  transform: "rotate(180deg)",
                  height: "104px",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                {a}
              </span>
            ))}
          </div>

          {cells.map((cell) => {
            const values = agents
              .map((a) => cell.byAgent[a])
              .filter((v): v is number => typeof v === "number");
            const mu = values.reduce((x, y) => x + y, 0) / (values.length || 1);
            const sd =
              Math.sqrt(
                values.reduce((s, v) => s + (v - mu) ** 2, 0) /
                  (values.length || 1),
              ) || 1;
            return (
              <div
                key={`${cell.regime}#${cell.seed}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: `170px repeat(${agents.length}, 1fr)`,
                  gap: "2px",
                  marginTop: "2px",
                  alignItems: "stretch",
                }}
              >
                <span
                  style={{
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-secondary)",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {cell.regime.replace(/^full-/, "")}
                  <span style={{ color: "var(--text-tertiary)" }}>
                    #{cell.seed}
                  </span>
                </span>
                {agents.map((a) => {
                  const v = cell.byAgent[a];
                  if (typeof v !== "number")
                    return (
                      <span
                        key={a}
                        style={{
                          height: "18px",
                          background: "var(--bg-sunken)",
                          borderRadius: "2px",
                        }}
                      />
                    );
                  const z = Math.max(-2.5, Math.min(2.5, (v - mu) / sd));
                  const strength = Math.min(1, Math.abs(z) / 2.5);
                  const hue = z >= 0 ? "var(--green-500)" : "var(--red-500)";
                  return (
                    <span
                      key={a}
                      title={`${a} · ${cell.regime}#${cell.seed}\n${formatMetric(v, standings.metric)}  (z ${z.toFixed(2)})\nclick to open this scenario`}
                      onClick={() => {
                        setSelectedRound(null);
                        setSelectedRunId(cell.runId);
                        navigate("/run");
                      }}
                      style={{
                        height: "18px",
                        borderRadius: "2px",
                        cursor: "pointer",
                        background: `color-mix(in oklch, ${hue}, transparent ${Math.round(
                          100 - strength * 88,
                        )}%)`,
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// issue #55 and the disagreement summary

function SdInflationPanel({ standings }: { standings: MatrixStandings }) {
  const rows = [...standings.cells]
    .map((c) => ({
      key: `${c.regime}#${c.seed}`,
      ratio: c.sdInflation.ratio,
      agentId: c.sdInflation.agentId,
    }))
    .sort((a, b) => b.ratio - a.ratio);
  const median = rows.length ? rows[Math.floor(rows.length / 2)].ratio : 1;

  return (
    <Panel
      title="Scale exposure (issue #55)"
      subtitle="How much of each scenario's spread comes from its single most extreme agent. A z-score divides by that spread, so 3× means everyone else's score is compressed threefold by one entry. 1.0 means nobody is setting the scale."
    >
      <div
        style={{
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div style={{ display: "flex", gap: "22px", flexWrap: "wrap" }}>
          <Stat label="median" value={`${median.toFixed(2)}×`} />
          <Stat
            label="worst"
            value={rows.length ? `${rows[0].ratio.toFixed(2)}×` : "—"}
          />
          <Stat label="worst offender" value={rows[0]?.agentId ?? "—"} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          {rows.slice(0, 6).map((r) => (
            <div
              key={r.key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 130px 56px",
                gap: "8px",
                alignItems: "center",
                font: "var(--text-xs) var(--font-mono)",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>
                {r.key.replace(/^full-/, "")}
              </span>
              <span style={{ color: "var(--text-tertiary)" }}>
                {r.agentId ?? "—"}
              </span>
              <span
                style={{ textAlign: "right", color: "var(--warning-text)" }}
              >
                {r.ratio.toFixed(2)}×
              </span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function DisagreementPanel({
  snapshot,
  standings,
}: {
  snapshot: MatrixSnapshot;
  standings: MatrixStandings;
}) {
  const rows = useMemo(
    () => compareCombinations(snapshot.matrix, snapshot.rounds, standings),
    [snapshot, standings],
  );
  const sorted = [...rows].sort((a, b) => a.sameRank - b.sameRank);

  return (
    <Panel
      title="If the rule were different"
      subtitle="Every other combination's order against the one on screen. This is the honest summary of a matrix while the ranking rule is undecided: how much of the order is a property of the agents rather than of the choice."
    >
      <div style={{ padding: "6px 16px 14px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 88px 70px 1fr",
            padding: "7px 0",
            borderBottom: "1px solid var(--border-subtle)",
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-wide)",
          }}
        >
          <span>rule</span>
          <span style={{ textAlign: "right" }}>same place</span>
          <span style={{ textAlign: "right" }}>max move</span>
          <span style={{ textAlign: "right" }}>biggest mover</span>
        </div>
        {sorted.map((r) => (
          <div
            key={`${r.metric}:${r.aggregator}`}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 88px 70px 1fr",
              padding: "6px 0",
              borderBottom: "1px solid var(--border-subtle)",
              font: "var(--text-xs) var(--font-mono)",
            }}
          >
            <span style={{ color: "var(--text-secondary)" }}>
              {r.metric} × {r.aggregator}
            </span>
            <span style={{ textAlign: "right", color: "var(--text-primary)" }}>
              {(r.sameRank * 100).toFixed(0)}%
            </span>
            <span style={{ textAlign: "right", color: "var(--warning-text)" }}>
              {r.maxShift}
            </span>
            <span style={{ textAlign: "right", color: "var(--text-tertiary)" }}>
              {r.mover
                ? `${r.mover.id} ${r.mover.shift > 0 ? "▲" : "▼"}${Math.abs(r.mover.shift)}`
                : "—"}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function MatrixPage() {
  const { data, loading, error } = useMatrixSnapshot();
  const cursor = useCursor();
  const [metric, setMetric] = useState<MetricKey>(DEFAULT_METRIC);
  const [aggregator, setAggregator] = useState<Aggregator>(DEFAULT_AGGREGATOR);
  const [params, setParams] = useState<ScoringParams>({
    lambda: DEFAULT_LAMBDA,
    rho: DEFAULT_RHO,
  });

  // The cursor's range is the longest scenario in the matrix. Scenarios shorter than that end
  // early rather than being excluded — see buildStandings.
  const maxRound = useMemo(() => {
    if (!data) return 0;
    let max = 0;
    for (const series of data.rounds.values())
      for (const returns of Object.values(series.byAgent))
        max = Math.max(max, returns.length);
    return max;
  }, [data]);

  useEffect(() => {
    setCursorRange(maxRound);
  }, [maxRound]);

  // A metric defined only at the run's end cannot be scoped to a round. Rather than showing the
  // finished number under a round label, the page falls back to M9 while the cursor is mid-run.
  const scrubbing = cursor.round !== null;
  const effectiveMetric =
    scrubbing && ENDPOINT_ONLY_METRICS.includes(metric) ? "score" : metric;

  const standings = useMemo(() => {
    if (!data) return null;
    return buildStandings(
      data.matrix,
      data.rounds,
      effectiveMetric,
      aggregator,
      params,
      cursor.round,
    );
  }, [data, effectiveMetric, aggregator, params, cursor.round]);

  const moves = useMemo(() => {
    if (!data || !standings) return new Map<string, number | null>();
    return rankMoves(data.matrix, data.rounds, standings);
  }, [data, standings]);

  // Keep the scenario selection inside the matrix on screen, so drilling into Markets or Explorer
  // never lands on a world belonging to a different competition.
  useEffect(() => {
    if (!data) return;
    const ids = data.matrix.file.scenarios.map((s) =>
      scenarioRunId(data.matrix.id, s.runDir),
    );
    const current = getSelectedRunId();
    if (current && ids.includes(current)) return;
    if (ids[0]) setSelectedRunId(ids[0]);
  }, [data]);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-canvas)",
          font: "var(--text-sm) var(--font-mono)",
          color: "var(--text-tertiary)",
        }}
      >
        Loading matrix…
      </div>
    );
  }

  // No matrix on disk: the dashboard is being used on standalone `sim:realtime` runs, which is the
  // day-to-day loop. Fall through to the run view rather than showing an empty competition.
  if (error || !data || !standings) return <TopPage />;

  const file = data.matrix.file;
  const seeds = [...new Set(file.scenarios.map((s) => s.seed))];

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: "var(--bg-canvas)",
      }}
    >
      <Sidebar activePage="standings" />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <RoundCursorBar
          cursor={cursor}
          scenarioCount={file.scenarios.length}
          endedScenarios={standings.endedScenarios}
        />
        <main
          style={{
            maxWidth: PAGE_MAX_WIDTH,
            width: "100%",
            minWidth: 0,
            margin: "0 auto",
            padding: "32px 32px 64px",
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            boxSizing: "border-box",
          }}
        >
          <header
            style={{ display: "flex", flexDirection: "column", gap: "10px" }}
          >
            <h1
              style={{
                margin: 0,
                font: "var(--weight-bold) 21px var(--font-sans)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {file.scenarioSet ?? data.matrix.id}
            </h1>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                gap: "14px",
              }}
            >
              <Stat label="scenarios" value={String(file.scenarios.length)} />
              <Stat label="regimes" value={String(standings.regimes.length)} />
              <Stat label="seeds" value={seeds.join(" ")} />
              <Stat label="agents" value={String(standings.agentIds.length)} />
              <Stat label="reset unit" value={file.resetUnit ?? "continuous"} />
              <Stat
                label="recorded"
                value={
                  file.createdAt
                    ? new Date(file.createdAt).toLocaleDateString("en-US")
                    : "—"
                }
              />
            </div>
            {data.missingRounds > 0 && (
              <span
                style={{
                  font: "var(--text-xs) var(--font-sans)",
                  color: "var(--warning-text)",
                }}
              >
                {data.missingRounds} of {file.scenarios.length} scenario runs
                were not collected — they still rank, but have no round detail.
              </span>
            )}
          </header>

          <Controls
            metric={effectiveMetric}
            aggregator={aggregator}
            params={params}
            fromSeries={standings.fromSeries}
            scrubbing={scrubbing}
            onMetric={setMetric}
            onAggregator={setAggregator}
            onParams={setParams}
          />

          {standings.rows.length === 0 ? (
            <Panel title="No standings">
              <p
                style={{
                  margin: 0,
                  padding: "16px",
                  font: "var(--text-sm) var(--font-sans)",
                  color: "var(--text-tertiary)",
                  lineHeight: 1.6,
                }}
              >
                {SERIES_METRICS.includes(effectiveMetric)
                  ? "This metric is computed from the per-epoch series, and none of this matrix's scenario runs were collected — matrix.json alone cannot produce it. Pick one of the metrics it stores, or collect the runs."
                  : "This matrix produced no comparable values for the selected metric."}
              </p>
            </Panel>
          ) : (
            <>
              {cursor.round !== null && (
                <ThisRoundPanel
                  snapshot={data}
                  round={cursor.round}
                  standings={standings}
                  moves={moves}
                />
              )}

              <StandingsTable
                standings={standings}
                snapshot={data}
                lambda={params.lambda}
                moves={moves}
              />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(390px, 1fr))",
                  gap: "18px",
                }}
              >
                <DisagreementPanel snapshot={data} standings={standings} />
                <SdInflationPanel standings={standings} />
              </div>

              <Heatmap standings={standings} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
