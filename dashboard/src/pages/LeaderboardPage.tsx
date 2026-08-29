import { useMemo, useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { Input } from "@/design-system/Input";
import { Select } from "@/design-system/Select";
import { useTopPageSnapshot } from "@/data/useTopPageSnapshot";
import { navigate } from "@/navigation";
import { formatPnlUsdc, formatScore } from "@/lib/format";
import type { AgentStanding, StrategyCategory } from "@/data/types";

const RANK_COLORS: Record<number, string> = {
  1: "var(--warning)",
  2: "var(--gray-400)",
  3: "color-mix(in oklch, var(--amber-500), var(--red-500) 40%)",
};

const STRATEGY_OPTIONS: { label: string; value: "all" | StrategyCategory }[] = [
  { label: "All strategies", value: "all" },
  { label: "Arbitrage", value: "arb" },
  { label: "Market making", value: "mm" },
  { label: "Directional", value: "dir" },
];

const ROW_GRID_COLUMNS = "34px 130px 1fr 80px 90px 80px 80px";

function CrownIcon({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M17 5h3a2 2 0 0 1 0 4h-1" />
      <path d="M7 5H4a2 2 0 0 0 0 4h1" />
    </svg>
  );
}

function LeaderboardTableRow({ row }: { row: AgentStanding }) {
  const isTop3 = row.rank <= 3;
  const pnlColor =
    row.netPnlUsdc >= 0 ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      onClick={() => navigate(`/agent/${row.agent}`)}
      style={{
        display: "grid",
        gridTemplateColumns: ROW_GRID_COLUMNS,
        padding: "11px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
        cursor: "pointer",
      }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>
        {isTop3 ? <CrownIcon color={RANK_COLORS[row.rank]} /> : row.rank}
      </span>
      <span style={{ color: "var(--text-link)" }}>{row.agent}</span>
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-sans)",
        }}
      >
        {row.strategy}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-primary)" }}>
        {formatScore(row.score)}
      </span>
      <span style={{ textAlign: "right", color: pnlColor }}>
        {formatPnlUsdc(row.netPnlUsdc)}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-primary)" }}>
        {row.sharpe.toFixed(2)}
      </span>
      <span style={{ textAlign: "right", color: "var(--danger-text)" }}>
        {row.maxDrawdownPercent.toFixed(1)}%
      </span>
    </div>
  );
}

export function LeaderboardPage() {
  const { data, loading, error } = useTopPageSnapshot();
  const [search, setSearch] = useState("");
  const [strategyFilter, setStrategyFilter] = useState<
    "all" | StrategyCategory
  >("all");

  const filteredRows = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.leaderboard.filter((row) => {
      const matchesTerm =
        !term ||
        row.agent.toLowerCase().includes(term) ||
        row.strategy.toLowerCase().includes(term);
      const matchesStrategy =
        strategyFilter === "all" || row.strategyCategory === strategyFilter;
      return matchesTerm && matchesStrategy;
    });
  }, [data, search, strategyFilter]);

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
          Failed to load data{error ? `: ${error.message}` : ""}
        </span>
      </div>
    );
  }

  const { round } = data;

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
            maxWidth: "1120px",
            width: "100%",
            minWidth: 0,
            margin: "0 auto",
            padding: "32px 32px 64px",
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            flex: 1,
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{ display: "flex", alignItems: "baseline", gap: "14px" }}
            >
              <span
                style={{
                  font: "var(--weight-bold) var(--text-xl) var(--font-sans)",
                  color: "var(--text-primary)",
                }}
              >
                Leaderboard
              </span>
              <span
                style={{
                  font: "var(--text-sm) var(--font-sans)",
                  color: "var(--text-tertiary)",
                }}
              >
                Run {round.roundNumber} ·{" "}
                {round.status === "live" ? "live" : "archived"}
              </span>
            </div>
            <span
              style={{
                font: "var(--text-xs) var(--font-mono)",
                color: "var(--text-tertiary)",
              }}
            >
              score = mean − λ·std of epoch log returns vs baseline (bps/epoch)
            </span>
          </div>

          <div style={{ display: "flex", gap: "12px", alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: "220px" }}>
              <Input
                placeholder="Search agent…"
                mono
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div style={{ minWidth: "200px" }}>
              <Select
                value={strategyFilter}
                options={STRATEGY_OPTIONS}
                onChange={(e) =>
                  setStrategyFilter(e.target.value as "all" | StrategyCategory)
                }
                style={{ minWidth: "200px" }}
              />
            </div>
          </div>

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
                gridTemplateColumns: ROW_GRID_COLUMNS,
                padding: "10px 16px",
                background: "var(--bg-surface)",
                font: "9px var(--font-mono)",
                color: "var(--text-tertiary)",
                textTransform: "uppercase",
                letterSpacing: "var(--tracking-wide)",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span>#</span>
              <span>Agent</span>
              <span>Strategy</span>
              <span style={{ textAlign: "right" }}>Score</span>
              <span style={{ textAlign: "right" }}>PnL (USDC)</span>
              <span style={{ textAlign: "right" }}>Sharpe</span>
              <span style={{ textAlign: "right" }}>Max DD</span>
            </div>
            {filteredRows.map((row) => (
              <LeaderboardTableRow key={row.rank} row={row} />
            ))}
            {filteredRows.length === 0 && (
              <div
                style={{
                  padding: "18px 16px",
                  font: "var(--text-sm) var(--font-sans)",
                  color: "var(--text-tertiary)",
                }}
              >
                No agents match your filters.
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
