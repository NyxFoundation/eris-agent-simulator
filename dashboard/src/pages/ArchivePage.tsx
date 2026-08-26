import { Sidebar } from "@/components/Sidebar";
import { Badge } from "@/design-system/Badge";
import { StatCard } from "@/design-system/StatCard";
import { useArchiveSnapshot } from "@/data/useArchiveSnapshot";
import { navigate } from "@/navigation";
import type { ArchiveFinalStanding, ArchivePodiumEntry } from "@/data/types";

const RANK_RING: Record<number, { bg: string; fg: string }> = {
  1: {
    bg: "color-mix(in oklch, var(--warning) 16%, white)",
    fg: "var(--warning)",
  },
  2: { bg: "var(--bg-surface)", fg: "var(--gray-400)" },
  3: {
    bg: "color-mix(in oklch, var(--amber-500) 12%, white)",
    fg: "color-mix(in oklch, var(--amber-500), var(--red-500) 40%)",
  },
};

function CrownIcon({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
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

const SECTION_LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

function PodiumCard({ entry }: { entry: ArchivePodiumEntry }) {
  const ring = RANK_RING[entry.rank] ?? RANK_RING[3];
  return (
    <div
      onClick={() => navigate(`/agent/${entry.agent}`)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "8px",
        padding: "16px 24px",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-surface-raised)",
        border: "1px solid var(--border-subtle)",
        minWidth: "160px",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          width: "40px",
          height: "40px",
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: ring.bg,
          border: `2px solid ${ring.fg}`,
        }}
      >
        <CrownIcon color={ring.fg} />
      </span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-base) var(--font-mono)",
          color: "var(--text-primary)",
        }}
      >
        {entry.agent}
      </span>
      <span
        style={{
          font: "var(--text-sm) var(--font-mono)",
          color:
            entry.pnlPercent >= 0
              ? "var(--success-text)"
              : "var(--danger-text)",
        }}
      >
        {entry.pnlPercent >= 0 ? "+" : ""}
        {entry.pnlPercent.toFixed(1)}%
      </span>
    </div>
  );
}

function FinalStandingRow({ row }: { row: ArchiveFinalStanding }) {
  const isTop3 = row.rank <= 3;
  const pnlColor =
    row.pnlPercent >= 0 ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      onClick={() => navigate(`/agent/${row.agent}`)}
      style={{
        display: "grid",
        gridTemplateColumns: "24px 1fr 70px 70px 60px",
        padding: "8px 2px",
        borderTop: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
        color: "var(--text-primary)",
        cursor: "pointer",
      }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>
        {isTop3 ? (
          <CrownIcon color={RANK_RING[row.rank]?.fg ?? RANK_RING[3].fg} />
        ) : (
          row.rank
        )}
      </span>
      <span style={{ color: "var(--text-link)" }}>{row.agent}</span>
      <span style={{ textAlign: "right" }}>{row.score.toFixed(1)}</span>
      <span style={{ textAlign: "right", color: pnlColor }}>
        {row.pnlPercent >= 0 ? "+" : ""}
        {row.pnlPercent.toFixed(1)}%
      </span>
      <span style={{ textAlign: "right" }}>{row.sharpe.toFixed(2)}</span>
    </div>
  );
}

export function ArchivePage() {
  const { data, loading, error } = useArchiveSnapshot();

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
          Failed to load data{error ? `: ${error.message}` : ""}
        </span>
      </div>
    );
  }

  const { round, stats, podium, finalStandings, closingPrices, events } = data;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: "var(--bg-canvas)",
      }}
    >
      <Sidebar roundNumber={round.roundNumber} roundStatus={round.status} />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "16px",
            padding: "44px 32px 36px",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-surface-raised)",
          }}
        >
          <span
            onClick={() => navigate("/")}
            style={{
              position: "absolute",
              top: "24px",
              right: "32px",
              font: "var(--text-sm) var(--font-mono)",
              color: "var(--text-link)",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            Round {round.roundNumber + 1} live →
          </span>
          <span
            style={{
              font: "var(--weight-bold) var(--text-4xl) var(--font-sans)",
              color: "var(--text-primary)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            ASCON
          </span>
          <div style={{ transform: "scale(1.4)", transformOrigin: "center" }}>
            <Badge tone="neutral">Round {round.roundNumber} · Archived</Badge>
          </div>
          <span
            style={{
              font: "var(--text-sm) var(--font-mono)",
              color: "var(--text-tertiary)",
            }}
          >
            final block {round.finalBlockNumber.toLocaleString("en-US")}
          </span>
        </div>

        <div
          style={{
            padding: "24px 32px",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-surface)",
          }}
        >
          <div
            style={{
              ...SECTION_LABEL_STYLE,
              marginBottom: "14px",
              textAlign: "center",
            }}
          >
            Round winners
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "20px",
              flexWrap: "wrap",
              marginBottom: "24px",
            }}
          >
            {podium.map((entry) => (
              <PodiumCard key={entry.rank} entry={entry} />
            ))}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4,1fr)",
              gap: "16px",
              maxWidth: "900px",
              margin: "0 auto",
            }}
          >
            <StatCard
              label="Total tx"
              value={stats.totalTx.toLocaleString("en-US")}
            />
            <StatCard label="Agents entered" value={stats.agentsEntered} />
            <StatCard label="Total volume" value={stats.totalVolume} />
            <StatCard
              label="Liquidations"
              value={stats.liquidations}
              tone="danger"
            />
          </div>
        </div>

        <main
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 280px",
            flex: 1,
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          <div style={{ padding: "20px 32px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "10px",
              }}
            >
              <span style={SECTION_LABEL_STYLE}>Final leaderboard</span>
              <span
                onClick={() => navigate("/leaderboard")}
                style={{
                  font: "var(--text-sm) var(--font-sans)",
                  color: "var(--text-link)",
                  textDecoration: "none",
                  cursor: "pointer",
                }}
              >
                Current round leaderboard →
              </span>
            </div>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "2px" }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "24px 1fr 70px 70px 60px",
                  font: "9px var(--font-mono)",
                  color: "var(--text-tertiary)",
                  letterSpacing: "var(--tracking-wide)",
                  textTransform: "uppercase",
                  padding: "4px 2px",
                }}
              >
                <span>#</span>
                <span>Agent</span>
                <span style={{ textAlign: "right" }}>Score</span>
                <span style={{ textAlign: "right" }}>PnL</span>
                <span style={{ textAlign: "right" }}>Sharpe</span>
              </div>
              {finalStandings.map((row) => (
                <FinalStandingRow key={row.rank} row={row} />
              ))}
            </div>
          </div>

          <div
            style={{
              padding: "20px 20px",
              borderLeft: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
              background: "var(--bg-surface)",
            }}
          >
            <div>
              <div style={{ ...SECTION_LABEL_STYLE, marginBottom: "8px" }}>
                Closing prices
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: "6px" }}
              >
                {closingPrices.map((m) => (
                  <div
                    key={m.pair}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      font: "var(--text-sm) var(--font-mono)",
                    }}
                  >
                    <span style={{ color: "var(--text-secondary)" }}>
                      {m.pair}
                    </span>
                    <span style={{ color: "var(--text-primary)" }}>
                      {m.price.toLocaleString("en-US")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div style={{ ...SECTION_LABEL_STYLE, marginBottom: "8px" }}>
                Events injected
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: "6px" }}
              >
                {events.map((e, i) => (
                  <div
                    key={i}
                    style={{
                      font: "var(--text-xs) var(--font-mono)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {e.time} — {e.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
