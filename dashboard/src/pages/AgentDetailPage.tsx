import { useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { Badge } from "@/design-system/Badge";
import { StatCard } from "@/design-system/StatCard";
import { Tabs } from "@/design-system/Tabs";
import { Sparkline } from "@/design-system/Sparkline";
import { LogStream } from "@/design-system/LogStream";
import {
  blockscoutAddressUrl,
  blockscoutTxUrl,
  useBlockscoutBase,
} from "@/data/blockscout";
import { useAgentDetailSnapshot } from "@/data/useAgentDetailSnapshot";
import { navigate } from "@/navigation";
import type { AgentPosition, AgentTrade } from "@/data/types";

const SECTION_LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

const TABS = [
  { label: "Overview", value: "overview" },
  { label: "Positions", value: "positions" },
  { label: "Trade history", value: "trades" },
  { label: "Decision log", value: "log" },
];

const POSITIONS_GRID = "1fr 60px 80px 90px 80px";
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
  const sideColor =
    position.side === "long" ? "var(--success-text)" : "var(--danger-text)";
  const pnlColor =
    position.pnlPercent >= 0 ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: grid,
        padding,
        [borderSide]: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
        color: "var(--text-primary)",
      }}
    >
      <span>{position.market}</span>
      <span style={{ color: sideColor, textTransform: "uppercase" }}>
        {position.side}
      </span>
      <span>{position.size}</span>
      <span>{position.entry}</span>
      <span style={{ textAlign: "right", color: pnlColor }}>
        {position.pnlPercent >= 0 ? "+" : ""}
        {position.pnlPercent.toFixed(1)}%
      </span>
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
          Loading ASCON…
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
  const positionsGridWithHeader = "1fr 70px 90px 100px 90px";

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
            ← Round {round.roundNumber} leaderboard
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
            <StatCard label="Score" value={agent.score.toFixed(1)} />
            <StatCard
              label="PnL"
              value={`${agent.pnlPercent >= 0 ? "+" : ""}${agent.pnlPercent.toFixed(1)}%`}
              tone="success"
              delta={`${agent.pnlPercent >= 0 ? "+" : ""}${agent.pnlPercent.toFixed(1)}%`}
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
                <span style={SECTION_LABEL_STYLE}>Portfolio value</span>
                <Sparkline
                  points={agent.portfolioPoints}
                  tone="success"
                  width={500}
                  height={140}
                />
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
                    <span>Market</span>
                    <span>Side</span>
                    <span>Size</span>
                    <span>Entry</span>
                    <span style={{ textAlign: "right" }}>PnL</span>
                  </div>
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
                <span>Market</span>
                <span>Side</span>
                <span>Size</span>
                <span>Entry</span>
                <span style={{ textAlign: "right" }}>PnL</span>
              </div>
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
