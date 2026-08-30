import { useMemo, useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import {
  formatSpreadBps,
  formatStanding,
  Stat,
  toneColor,
} from "@/components/competitionUi";
import { Badge } from "@/design-system/Badge";
import { StatCard } from "@/design-system/StatCard";
import { Tabs } from "@/design-system/Tabs";
import { StateChart } from "@/components/StateChart";
import { LogStream } from "@/design-system/LogStream";
import {
  blockscoutAddressUrl,
  blockscoutTxUrl,
  useBlockscoutBase,
} from "@/data/blockscout";
import {
  buildStandings,
  decomposeAgent,
  LAMBDA,
  type AgentRoundDecomposition,
} from "@/data/standings";
import { useAgentDetailSnapshot } from "@/data/useAgentDetailSnapshot";
import { useCompetitionSnapshot } from "@/data/useCompetitionSnapshot";
import {
  formatBps,
  formatMove,
  formatPnlUsdc,
  formatScore,
  formatUsd,
} from "@/lib/format";
import { cssVar } from "@/lib/cssVar";
import type { AgentPosition, AgentTrade, VenueChart } from "@/data/types";

const SECTION_LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

/** The scenario-level tabs. "Standing" is prepended when the agent ranks in a competition. */
const SCENARIO_TABS = [
  { label: "Overview", value: "overview" },
  { label: "Rounds", value: "rounds" },
  { label: "Positions", value: "positions" },
  { label: "Trade history", value: "trades" },
  { label: "Decision log", value: "log" },
];

const ROUNDS_GRID = "60px 150px 70px 110px 100px 90px";

const POSITIONS_GRID = "150px 70px 120px 130px minmax(0,1fr)";
const TRADES_GRID = "120px 90px 1fr 100px 90px";

function positionAvatar(agentId: string): string {
  const digit = agentId.match(/\d/)?.[0] ?? "•";
  return `A${digit}`;
}

function PositionRow({
  position,
  grid,
  padding,
  borderSide = "borderTop",
}: {
  position: AgentPosition;
  grid: string;
  padding: string;
  borderSide?: "borderTop" | "borderBottom";
}) {
  const kindColor =
    position.tone === "up"
      ? "var(--success-text)"
      : position.tone === "down"
        ? "var(--danger-text)"
        : "var(--text-secondary)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: grid,
        padding,
        [borderSide]: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
        color: "var(--text-primary)",
        alignItems: "baseline",
      }}
    >
      <span>{position.market}</span>
      <span style={{ color: kindColor }}>{position.kind}</span>
      <span>{position.size}</span>
      <span style={{ color: "var(--text-secondary)" }}>{position.mark}</span>
      <span
        title={position.note ?? ""}
        style={{
          color:
            position.pnlPercent === undefined
              ? "var(--text-tertiary)"
              : position.pnlPercent >= 0
                ? "var(--success-text)"
                : "var(--danger-text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {position.pnlPercent !== undefined
          ? `${position.pnlPercent >= 0 ? "+" : ""}${position.pnlPercent.toFixed(1)}% · ${position.note ?? ""}`
          : (position.note ?? "")}
      </span>
    </div>
  );
}

/** Positions only exist as an end-of-run reconstruction, and a run can legitimately end with none.
 * Saying which is which is the whole point — a bare table reads as a broken view. */
function PositionsEmpty({ padding }: { padding: string }) {
  return (
    <div
      style={{
        padding,
        font: "var(--text-xs) var(--font-mono)",
        color: "var(--text-tertiary)",
      }}
    >
      no venue position open at the final block — this agent ended flat, or the
      run predates the per-agent venue reads in market.json
    </div>
  );
}

function TradeRow({ trade, href }: { trade: AgentTrade; href?: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: TRADES_GRID,
        padding: "11px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        font: "var(--text-xs) var(--font-mono)",
      }}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open transaction in Blockscout"
          style={{ color: "var(--text-link)", textDecoration: "none" }}
        >
          {trade.hash}
        </a>
      ) : (
        <span style={{ color: "var(--text-link)" }}>{trade.hash}</span>
      )}
      <span style={{ color: "var(--text-secondary)" }}>{trade.block}</span>
      <span style={{ color: "var(--text-secondary)" }}>{trade.method}</span>
      <span style={{ color: "var(--text-secondary)" }}>{trade.amount}</span>
      <span style={{ textAlign: "right", color: "var(--text-tertiary)" }}>
        {trade.time}
      </span>
    </div>
  );
}

function ReturnHistogram({ values }: { values: number[] }) {
  const bins = 41;
  const bps = values.map((v) => v * 10_000);
  // Scaled to a high quantile rather than the maximum: most of these distributions have one round
  // orders of magnitude past the rest, and scaling to it draws the shape of the axis rather than
  // the shape of the returns. Rounds past the edge are counted into the end bins and reported
  // below, so nothing is hidden, only compressed at the tails.
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

/** The agent's place in the competition, and the round-level distribution that explains it. */
interface CompetitionStanding {
  rank: number;
  fieldSize: number;
  total: number;
  netPnlUsdc: number;
  regimes: { regime: string; value: number | undefined }[];
  decomposition: AgentRoundDecomposition | null;
}

function useCompetitionStanding(agentId: string): CompetitionStanding | null {
  const { data } = useCompetitionSnapshot();
  return useMemo(() => {
    if (!data) return null;
    const standings = buildStandings(data.competition, data.rounds);
    const rank = standings.rows.findIndex((r) => r.id === agentId);
    if (rank === -1) return null;
    const row = standings.rows[rank];
    return {
      rank: rank + 1,
      fieldSize: standings.rows.length,
      total: row.total,
      netPnlUsdc: standings.netPnlByAgent[agentId] ?? 0,
      regimes: standings.regimes.map((regime) => ({
        regime,
        value: row.byRegime[regime],
      })),
      decomposition: decomposeAgent(agentId, data.competition, data.rounds),
    };
  }, [data, agentId]);
}

function StandingTab({ standing }: { standing: CompetitionStanding }) {
  const d = standing.decomposition;
  return (
    <div
      style={{
        background: "var(--bg-surface-raised)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg)",
        padding: "20px 22px",
        display: "flex",
        flexDirection: "column",
        gap: "18px",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "14px",
        }}
      >
        <Stat
          label="rank"
          value={`${standing.rank} of ${standing.fieldSize}`}
        />
        <Stat label="score" value={formatStanding(standing.total)} />
        <Stat label="net PnL" value={formatPnlUsdc(standing.netPnlUsdc)} />
        {d && <Stat label="rounds" value={String(d.stats.epochs)} />}
      </div>

      {!d ? (
        <span
          style={{
            font: "var(--text-sm) var(--font-sans)",
            color: "var(--text-tertiary)",
            lineHeight: 1.6,
          }}
        >
          No round series on disk for this agent — the scenario runs behind this
          competition were not collected, so the standing can be shown but not
          explained.
        </span>
      ) : (
        <>
          <p
            style={{
              margin: 0,
              font: "var(--text-xs) var(--font-sans)",
              color: "var(--text-tertiary)",
              lineHeight: 1.6,
              maxWidth: "78ch",
            }}
          >
            Every round this agent produced, pooled across the whole
            competition. An agent can earn several times more per round than the
            winner and still place last — the difference is the spread λ charges
            for.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
              gap: "14px",
            }}
          >
            <Stat
              label="mean / round"
              value={formatBps(d.stats.mean * 10_000)}
            />
            <Stat
              label="std / round"
              value={formatSpreadBps(d.stats.std * 10_000)}
            />
            <Stat
              label={`λ·std (λ=${LAMBDA.toFixed(2)})`}
              value={formatSpreadBps(LAMBDA * d.stats.std * 10_000)}
            />
            <Stat
              label="mean − λ·std"
              value={formatBps(d.stats.score * 10_000)}
            />
          </div>

          <ReturnHistogram values={d.pooled} />

          {d.byRegime.length > 1 && (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "6px" }}
            >
              <span style={SECTION_LABEL_STYLE}>by regime</span>
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
                        style={{
                          textAlign: "right",
                          color: "var(--text-tertiary)",
                        }}
                      >
                        {r.stats.epochs}
                      </span>
                      <span
                        style={{
                          textAlign: "right",
                          color: toneColor(r.stats.mean),
                        }}
                      >
                        {formatBps(r.stats.mean * 10_000)}
                      </span>
                      <span
                        style={{
                          textAlign: "right",
                          color: "var(--text-secondary)",
                        }}
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
          )}

          {d.bankruptIn.length > 0 && (
            <span
              style={{
                font: "var(--text-xs) var(--font-sans)",
                color: "var(--danger-text)",
                lineHeight: 1.6,
              }}
            >
              Hit the bankruptcy floor in {d.bankruptIn.length} scenario
              {d.bankruptIn.length === 1 ? "" : "s"} — every later round is
              frozen at a return of 0:{" "}
              {d.bankruptIn
                .map((b) => `${b.regime}#${b.seed} @ round ${b.epoch}`)
                .join(", ")}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const { data, loading, error } = useAgentDetailSnapshot(agentId);
  const blockscout = useBlockscoutBase();
  const standing = useCompetitionStanding(agentId);
  // null = "not chosen yet": land on the standing when the agent ranks in a competition, on the
  // scenario overview otherwise (seed mode, live runs).
  const [chosenTab, setChosenTab] = useState<string | null>(null);
  const tab = chosenTab ?? (standing ? "standing" : "overview");
  const tabs = standing
    ? [{ label: "Standing", value: "standing" }, ...SCENARIO_TABS]
    : SCENARIO_TABS;

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-canvas)",
        }}
      >
        <span
          style={{
            font: "var(--text-sm) var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          Loading Eris…
        </span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-canvas)",
        }}
      >
        <span
          style={{
            font: "var(--text-sm) var(--font-mono)",
            color: "var(--danger-text)",
          }}
        >
          Failed to load agent{error ? `: ${error.message}` : ""}
        </span>
      </div>
    );
  }

  const { round, agent } = data;
  const series = agent.portfolioSeries;
  const portfolioUp =
    series.length < 2 || series[series.length - 1].value >= series[0].value;
  // Both axes are named rather than left to be inferred: y is the account value the score is
  // computed from, x is chain height — not wall-clock time, and not a point index.
  const portfolioChart: VenueChart = {
    id: `portfolio-${agent.agent}`,
    title:
      series.length >= 2
        ? `Portfolio value · ${formatUsd(series[0].value)} → ${formatUsd(series[series.length - 1].value)}`
        : "Portfolio value",
    unit: "usd",
    showBlockAxis: true,
    yLabel: "account value (USDC)",
    xLabel: "block",
    height: 180,
    lines: [
      {
        id: "value",
        label: "total account value",
        color: portfolioUp ? cssVar("--success") : cssVar("--danger"),
        points: series,
      },
    ],
  };
  const positionsGridWithHeader = "160px 80px 130px 140px minmax(0,1fr)";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: "var(--bg-canvas)",
      }}
    >
      <Sidebar />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <RoundsBar round={round} />
        <main
          style={{
            maxWidth: "1200px",
            width: "100%",
            minWidth: 0,
            margin: "0 auto",
            padding: "24px 32px 64px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            flex: 1,
            boxSizing: "border-box",
          }}
        >
          <span
            onClick={() => window.history.back()}
            style={{
              font: "var(--text-sm) var(--font-mono)",
              color: "var(--text-link)",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            ← back
          </span>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              padding: "18px 22px",
              background: "var(--bg-surface-raised)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg)",
            }}
          >
            <div
              style={{
                width: "44px",
                height: "44px",
                borderRadius: "9px",
                background: "var(--accent-muted)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                font: "var(--weight-bold) var(--text-md) var(--font-mono)",
                color: "var(--accent-secondary)",
              }}
            >
              {positionAvatar(agent.agent)}
            </div>
            <div>
              <div
                style={{
                  font: "var(--weight-semibold) var(--text-md) var(--font-sans)",
                  color: "var(--text-primary)",
                }}
              >
                {agent.agent}
              </div>
              <div
                style={{
                  font: "var(--text-xs) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                {blockscout && agent.fullAddress ? (
                  <a
                    href={blockscoutAddressUrl(blockscout, agent.fullAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open address in Blockscout"
                    style={{
                      color: "var(--text-link)",
                      textDecoration: "none",
                    }}
                  >
                    {agent.address}
                  </a>
                ) : (
                  agent.address
                )}{" "}
                — {agent.strategy}
              </div>
            </div>
            <span style={{ marginLeft: "auto" }}>
              <Badge tone="success">Rank {agent.rank}</Badge>
            </span>
          </div>

          <Tabs tabs={tabs} value={tab} onChange={setChosenTab} />

          {/* The stat cards are the selected scenario's numbers; the standing tab carries its own,
              competition-level ones — mixing the two scales on one row invites misreading. */}
          {tab !== "standing" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4,1fr)",
                gap: "16px",
              }}
            >
              <StatCard label="Score" value={formatScore(agent.score)} />
              <StatCard
                label="PnL (USDC)"
                value={formatPnlUsdc(agent.netPnlUsdc)}
                // The card only tints its delta line, so the sign is echoed there to keep the
                // red/green signal -- the same shape the Max drawdown card uses.
                tone={agent.netPnlUsdc >= 0 ? "success" : "danger"}
                delta={formatPnlUsdc(agent.netPnlUsdc)}
              />
              <StatCard label="Sharpe" value={agent.sharpe.toFixed(2)} />
              <StatCard
                label="Max drawdown"
                value={`${agent.maxDrawdownPercent.toFixed(1)}%`}
                tone="danger"
                delta={`${agent.maxDrawdownPercent.toFixed(1)}%`}
              />
            </div>
          )}

          {tab === "standing" && standing && (
            <StandingTab standing={standing} />
          )}

          {tab === "overview" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 340px",
                gap: "20px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                  background: "var(--bg-surface-raised)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-lg)",
                  padding: "20px 22px",
                }}
              >
                {agent.portfolioSeries.length >= 2 ? (
                  <StateChart chart={portfolioChart} />
                ) : (
                  <span
                    style={{
                      font: "var(--text-xs) var(--font-mono)",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    no reconstructed value series for this agent — the curve is
                    built from the scoring cross-sections, which land when the
                    run completes
                  </span>
                )}
                <span style={{ ...SECTION_LABEL_STYLE, marginTop: "6px" }}>
                  Open positions
                </span>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: POSITIONS_GRID,
                      font: "9px var(--font-mono)",
                      color: "var(--text-tertiary)",
                      textTransform: "uppercase",
                      padding: "0 2px 4px",
                    }}
                  >
                    <span>Venue</span>
                    <span>Kind</span>
                    <span>Size</span>
                    <span>Mark</span>
                    <span>Detail</span>
                  </div>
                  {agent.positions.length === 0 && (
                    <PositionsEmpty padding="7px 2px" />
                  )}
                  {agent.positions.map((p, i) => (
                    <PositionRow
                      key={i}
                      position={p}
                      grid={POSITIONS_GRID}
                      padding="7px 2px"
                    />
                  ))}
                </div>
              </div>
              <div
                style={{
                  background: "var(--bg-surface-raised)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-lg)",
                  padding: "20px 18px",
                }}
              >
                <span
                  style={{
                    ...SECTION_LABEL_STYLE,
                    display: "block",
                    marginBottom: "10px",
                  }}
                >
                  Decision log — live ↓
                </span>
                <LogStream lines={agent.recentLog} height={320} />
              </div>
            </div>
          )}

          {tab === "rounds" && (
            <div
              style={{
                background: "var(--bg-surface-raised)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-lg)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: ROUNDS_GRID,
                  padding: "10px 16px",
                  background: "var(--bg-surface)",
                  font: "9px var(--font-mono)",
                  color: "var(--text-tertiary)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <span>Round</span>
                <span>Blocks</span>
                <span style={{ textAlign: "right" }}>Tx</span>
                <span style={{ textAlign: "right" }}>Δ value</span>
                <span style={{ textAlign: "right" }}>Log return</span>
                <span style={{ textAlign: "right" }}>Rank</span>
              </div>
              {agent.rounds.length === 0 && (
                <div
                  style={{
                    padding: "16px",
                    font: "var(--text-sm) var(--font-mono)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  this run has no scored rounds yet — the epoch series is
                  reconstructed once the run completes (ADR 0006 §4)
                </div>
              )}
              {agent.rounds.map((r) => {
                const gainColor =
                  r.deltaUsdc > 0
                    ? "var(--success-text)"
                    : r.deltaUsdc < 0
                      ? "var(--danger-text)"
                      : "var(--text-tertiary)";
                const moveColor =
                  r.move === 0
                    ? "var(--text-disabled)"
                    : r.move > 0
                      ? "var(--success-text)"
                      : "var(--danger-text)";
                return (
                  <div
                    key={r.index}
                    style={{
                      display: "grid",
                      gridTemplateColumns: ROUNDS_GRID,
                      padding: "10px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      font: "var(--text-sm) var(--font-mono)",
                    }}
                  >
                    <span style={{ color: "var(--text-primary)" }}>
                      {String(r.index).padStart(2, "0")}
                    </span>
                    <span style={{ color: "var(--text-tertiary)" }}>
                      {r.fromBlock.toLocaleString("en-US")}–
                      {r.toBlock.toLocaleString("en-US")}
                    </span>
                    <span
                      style={{
                        textAlign: "right",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {r.txCount}
                    </span>
                    <span style={{ textAlign: "right", color: gainColor }}>
                      {formatPnlUsdc(r.deltaUsdc)}
                    </span>
                    <span style={{ textAlign: "right", color: gainColor }}>
                      {formatBps(r.logReturnBps)}
                    </span>
                    <span
                      style={{
                        textAlign: "right",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {r.cumulativeRank}{" "}
                      <span style={{ color: moveColor }}>
                        {formatMove(r.move)}
                      </span>
                    </span>
                  </div>
                );
              })}
              <div
                style={{
                  padding: "10px 16px",
                  font: "10px var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                A round is a scoring epoch. Log return is this agent's excess
                over the roster's do-nothing baseline for that epoch — the
                series the score (mean − λ·std) is computed from.
              </div>
            </div>
          )}

          {tab === "positions" && (
            <div
              style={{
                background: "var(--bg-surface-raised)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-lg)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: positionsGridWithHeader,
                  padding: "10px 16px",
                  background: "var(--bg-surface)",
                  font: "9px var(--font-mono)",
                  color: "var(--text-tertiary)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <span>Venue</span>
                <span>Kind</span>
                <span>Size</span>
                <span>Mark</span>
                <span>Detail</span>
              </div>
              {agent.positions.length === 0 && (
                <PositionsEmpty padding="14px 16px" />
              )}
              {agent.positions.map((p, i) => (
                <PositionRow
                  key={i}
                  position={p}
                  grid={positionsGridWithHeader}
                  padding="12px 16px"
                  borderSide="borderBottom"
                />
              ))}
            </div>
          )}

          {tab === "trades" && (
            <div
              style={{
                background: "var(--bg-surface-raised)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-lg)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: TRADES_GRID,
                  padding: "10px 16px",
                  background: "var(--bg-surface)",
                  font: "9px var(--font-mono)",
                  color: "var(--text-tertiary)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-wide)",
                  borderBottom: "1px solid var(--border-subtle)",
                }}
              >
                <span>Tx hash</span>
                <span>Block</span>
                <span>Method</span>
                <span>Amount</span>
                <span style={{ textAlign: "right" }}>Time</span>
              </div>
              {agent.trades.map((t, i) => (
                <TradeRow
                  key={i}
                  trade={t}
                  href={
                    blockscout && t.fullHash
                      ? blockscoutTxUrl(blockscout, t.fullHash)
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          {tab === "log" && <LogStream lines={agent.fullLog} height={420} />}
        </main>
      </div>
    </div>
  );
}
