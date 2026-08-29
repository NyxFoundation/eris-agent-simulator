import { useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
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
import { useAgentDetailSnapshot } from "@/data/useAgentDetailSnapshot";
import { navigate } from "@/navigation";
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

const TABS = [
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

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const { data, loading, error } = useAgentDetailSnapshot(agentId);
  const blockscout = useBlockscoutBase();
  const [tab, setTab] = useState("overview");

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
      <Sidebar activePage="leaderboard" />

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
            onClick={() => navigate("/leaderboard")}
            style={{
              font: "var(--text-sm) var(--font-mono)",
              color: "var(--text-link)",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            ← Run {round.runNumber} leaderboard
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

          <Tabs tabs={TABS} value={tab} onChange={setTab} />

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
