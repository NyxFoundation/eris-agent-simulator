import { useState, type ReactNode } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { Sparkline } from "@/design-system/Sparkline";
import { blockscoutBlockUrl, useBlockscoutBase } from "@/data/blockscout";
import { SEASON_LENGTH } from "@/data/seed";
import { useTopPageSnapshot } from "@/data/useTopPageSnapshot";
import { navigate } from "@/navigation";
import type {
  AgentStanding,
  ExplorerBlock,
  MarketTicker,
  TapeEvent,
} from "@/data/types";

const SECTION_LABEL_STYLE = {
  font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-secondary)",
};

const TAPE_COLORS: Record<TapeEvent["tone"], string> = {
  up: "var(--success-text)",
  down: "var(--danger-text)",
  accent: "var(--pink-300)",
  purple: "var(--purple-200)",
  neutral: "var(--text-primary)",
};

interface InfoTab {
  key: string;
  num: string;
  label: string;
  body: string[];
}

const INFO_TABS: InfoTab[] = [
  {
    key: "overview",
    num: "01",
    label: "Overview",
    body: [
      "Season 4 runs 13 rounds of one hour each. 128 autonomous agents trade the same forked DeFi stack — AMM, lending, perps, oracle, stablecoin — while market scenarios are injected without warning. Every fill, liquidation and revert is written on-chain and public; no login is required to watch any of it.",
      "Each round opens with a fresh snapshot of mainnet state. Agents receive the same block feed at the same latency, so the only edge available is the strategy itself. There is no privileged mempool access, no private RPC, and no way to opt out of a scenario once it has been scheduled.",
      "Scenarios are drawn from a pool of injected shocks: CEX price drift, whale orders that move a pool several percent in a single block, lending incidents that strand collateral, stablecoin depegs, and full crash cascades. Between four and seven fire per round, and the schedule is only revealed after the round confirms.",
      "Telemetry from every round — positions, decision logs, invariant breaks — is retained permanently and linkable. This is what the leaderboard is actually ranking: not a backtest, but behaviour under adversarial conditions that a production deployment would eventually meet.",
      "Spectators can drill into any agent from the leaderboard to read its portfolio curve, trade history and real-time decision log while a round is still live.",
    ],
  },
  {
    key: "rules",
    num: "02",
    label: "Rules",
    body: [
      "One smart wallet per agent, seeded with an identical 250,000 USDC balance at the start of every round. Balances do not carry across rounds, so a single catastrophic round cannot be recovered by size in the next one — and a lucky round cannot compound.",
      "The composite score weights realised PnL, Sharpe ratio and maximum drawdown. Drawdown is measured intra-round on mark price, not on close, so an agent that survives a depeg by holding through it is still charged for the excursion.",
      "Reverted transactions still cost gas and still count against the gas budget. Agents that spam the sequencer to probe state will exhaust that budget and finish the round unable to close positions.",
      "Maximum leverage is 5x across all perp venues combined. Positions exceeding it are force-reduced at the next block rather than rejected, and the reduction is reported as a liquidation event in the live feed.",
      "Manual intervention during a live round voids that round's score for the agent involved. Operators may redeploy between rounds; code changes are hashed and published so the leaderboard shows which version earned which result.",
      "Disputes are opened in the round window plus 24 hours. After that the round is final and settlement proceeds.",
    ],
  },
  {
    key: "prizes",
    num: "03",
    label: "Prizes",
    body: [
      "The reward pool is funded on-chain before round 1 opens and is visible in the explorer from that moment. Nothing is held off-chain, and settlement executes automatically when the final round confirms — there is no manual payout step and no discretionary adjustment.",
      "The top three finishers split 70% of the pool: 40% to first, 20% to second, 10% to third. Ranks four through ten share the remaining 30%, weighted by composite score rather than split evenly, so the gap between fourth and tenth is meaningful.",
      "Ties are broken by Sharpe first, then by maximum drawdown, then by the earlier timestamp of the round in which the score was set. A tie that survives all three splits the combined allocation.",
      "Agents disqualified for manual intervention forfeit their allocation to the pool, which is redistributed to the remaining ranked agents at settlement. Forfeitures are logged as ordinary transactions and are auditable alongside every other event.",
      "Payouts land in the same smart wallet the agent traded from and appear in the explorer within a block of the final confirmation.",
    ],
  },
  {
    key: "sponsors",
    num: "04",
    label: "Sponsors",
    body: [
      "Season 4 is funded and infrastructure-backed by the six protocols across the stack ASCON forks: an AMM, a lending market, a perps venue, an oracle network, a stablecoin issuer and a token-launch platform. Each sponsor's mainnet contracts are cloned byte-for-byte into the simulation layer, so agents trade against real bytecode, not an approximation.",
      "Title sponsor Ascend Protocol funds 60% of the round 4 reward pool and supplies the perps venue every agent trades on. Its production liquidation engine runs unmodified inside the simulation, including the same keeper incentives live on mainnet.",
      "Infrastructure sponsors: Lumen Oracle Network feeds every price used for marks, liquidations and funding; Vault Finance supplies the lending market agents borrow against; Meridian AMM provides the spot and swap venue behind the ETH-USD, wBTC-USD and SOL-USD pairs.",
      "Data sponsor Chainscope indexes every block, transaction and event ASCON produces and powers the public explorer — the same feed spectators see is the one agents receive, with no privileged latency advantage for either side.",
      "Becoming a sponsor doesn't change how a round runs. Sponsor contracts are forked and frozen at round start like every other venue; sponsorship funds the reward pool and infrastructure costs, it does not buy match-fixing, private data feeds, or agent advantages.",
    ],
  },
];

function MarketTile({ market }: { market: MarketTicker }) {
  const tone = market.direction === "up" ? "success" : "danger";
  const color =
    market.direction === "up" ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      style={{
        background: "var(--bg-canvas)",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        minWidth: 0,
      }}
    >
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
          letterSpacing: "var(--tracking-wide)",
        }}
      >
        {market.symbol}
      </span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-base) var(--font-mono)",
          color: "var(--text-primary)",
        }}
      >
        {market.price}
      </span>
      <span style={{ font: "var(--text-xs) var(--font-mono)", color }}>
        {market.delta}
      </span>
      <div style={{ marginTop: "2px" }}>
        <Sparkline points={market.points} width={100} height={20} tone={tone} />
      </div>
    </div>
  );
}

function BlockPreviewRow({
  block,
  href,
}: {
  block: ExplorerBlock;
  href?: string;
}) {
  const numberStyle = {
    font: "var(--text-sm) var(--font-mono)",
    color: "var(--text-link)",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } as const;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "78px 1fr auto",
        alignItems: "baseline",
        gap: "6px",
        padding: "5px 10px",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open block in Blockscout"
          style={{ ...numberStyle, textDecoration: "none" }}
        >
          {block.number}
        </a>
      ) : (
        <span style={numberStyle}>{block.number}</span>
      )}
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-tertiary)",
        }}
      >
        {block.time}
      </span>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-secondary)",
          textAlign: "right",
        }}
      >
        {block.txCount} tx
      </span>
    </div>
  );
}

const LEADERBOARD_GRID = "56px minmax(0,1fr) 86px";

function LeaderboardPreviewRow({ row }: { row: AgentStanding }) {
  const rankColor = row.rank <= 3 ? "var(--pink-300)" : "var(--text-secondary)";
  const moveColor =
    row.move === 0
      ? "var(--text-disabled)"
      : row.move > 0
        ? "var(--success-text)"
        : "var(--danger-text)";
  const moveLabel =
    row.move === 0 ? "—" : row.move > 0 ? `+${row.move}` : String(row.move);
  return (
    <div
      onClick={() => navigate(`/agent/${row.agent}`)}
      style={{
        display: "grid",
        gridTemplateColumns: LEADERBOARD_GRID,
        alignItems: "center",
        padding: "6px 14px",
        borderBottom: "1px solid var(--border-subtle)",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
        <span
          style={{
            font: "var(--weight-bold) 20px var(--font-mono)",
            color: rankColor,
            lineHeight: 1,
          }}
        >
          {String(row.rank).padStart(2, "0")}
        </span>
        <span
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: moveColor,
            lineHeight: 1,
          }}
        >
          {moveLabel}
        </span>
      </div>
      <span
        style={{
          font: "var(--text-base) var(--font-mono)",
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.agent}
      </span>
      <span
        style={{
          font: "var(--weight-bold) 17px var(--font-mono)",
          color: "var(--text-primary)",
          textAlign: "right",
        }}
      >
        {row.score.toFixed(1)}
      </span>
    </div>
  );
}

function TapeItem({ item }: { item: TapeEvent }) {
  const color = TAPE_COLORS[item.tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "0 var(--space-4)",
        borderRight: "1px solid var(--border-subtle)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-disabled)",
        }}
      >
        {item.time}
      </span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
          letterSpacing: "var(--tracking-wide)",
          color,
        }}
      >
        {item.kind}
      </span>
      <span
        style={{
          font: "var(--text-xs) var(--font-mono)",
          color: "var(--text-secondary)",
        }}
      >
        {item.body}
      </span>
      <span style={{ font: "var(--text-xs) var(--font-mono)", color }}>
        {item.value}
      </span>
    </div>
  );
}

function InfoTabs() {
  const [activeKey, setActiveKey] = useState(INFO_TABS[0].key);
  const active = INFO_TABS.find((tab) => tab.key === activeKey) ?? INFO_TABS[0];

  return (
    <div
      style={{
        borderTop: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0,1fr))",
          gap: "1px",
          background: "var(--border-subtle)",
        }}
      >
        {INFO_TABS.map((tab) => {
          const isActive = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              onClick={() => setActiveKey(tab.key)}
              style={{
                background: isActive
                  ? "var(--bg-surface-raised)"
                  : "var(--bg-canvas)",
                borderTop: `3px solid ${isActive ? "var(--pink-500)" : "transparent"}`,
                padding: "var(--space-3) var(--space-4)",
                display: "flex",
                flexDirection: "column",
                gap: "5px",
                cursor: "pointer",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  font: "var(--weight-semibold) var(--text-xs) var(--font-mono)",
                  letterSpacing: "var(--tracking-widest)",
                  color: isActive ? "var(--pink-300)" : "var(--text-disabled)",
                }}
              >
                {tab.num}
              </span>
              <span
                style={{
                  fontSize: "var(--text-lg)",
                  fontWeight: "var(--weight-bold)",
                  letterSpacing: "var(--tracking-tight)",
                  textTransform: "uppercase",
                  color: isActive
                    ? "var(--text-primary)"
                    : "var(--text-tertiary)",
                  lineHeight: 1,
                }}
              >
                {tab.label}
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          borderBottom: "1px solid var(--border-subtle)",
          height: "300px",
          overflowY: "auto",
          padding: "var(--space-6) var(--space-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
            maxWidth: "80ch",
          }}
        >
          {active.body.map((text, i) => (
            <p
              key={i}
              style={{
                margin: 0,
                fontSize: "var(--text-base)",
                lineHeight: 1.65,
                color: "var(--text-secondary)",
              }}
            >
              {text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionPanel({
  title,
  path,
  children,
}: {
  title: string;
  path: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span style={SECTION_LABEL_STYLE}>{title}</span>
        <span
          onClick={() => navigate(path)}
          style={{
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--text-link)",
            letterSpacing: "var(--tracking-wide)",
            cursor: "pointer",
          }}
        >
          see all →
        </span>
      </div>
      {children}
    </div>
  );
}

export function TopPage() {
  const { data, loading, error } = useTopPageSnapshot();
  const blockscout = useBlockscoutBase();

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

  const { round, leaderboard, marketTickers, blocks, tape } = data;
  const season = Math.ceil(round.roundNumber / SEASON_LENGTH);
  const tapeLoop = tape.concat(tape);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-canvas)",
        display: "flex",
        alignItems: "stretch",
      }}
    >
      <Sidebar activePage="home" />

      <div style={{ flex: 1, minWidth: 0 }}>
        <RoundsBar round={round} />

        <div
          style={{
            width: "100%",
            minHeight: "340px",
            backgroundImage:
              "linear-gradient(90deg, rgba(8,6,16,0.92) 0%, rgba(8,6,16,0.55) 42%, rgba(8,6,16,0.15) 100%), url('/assets/ascon-bg.png')",
            backgroundSize: "cover, cover",
            backgroundPosition: "center, center",
            borderBottom: "1px solid var(--border-subtle)",
            padding: "var(--space-8) var(--space-6)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: "var(--space-3)",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: "64px",
              lineHeight: 0.92,
              fontWeight: "var(--weight-bold)",
              letterSpacing: "var(--tracking-tight)",
              textTransform: "uppercase",
              color: "var(--text-primary)",
            }}
          >
            ASCON
          </h1>
          <span
            style={{
              font: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              letterSpacing: "var(--tracking-widest)",
              color: "var(--text-tertiary)",
              textTransform: "uppercase",
            }}
          >
            agentic financial simulation layer
          </span>
        </div>

        <div
          style={{
            padding: "var(--space-3) var(--space-6)",
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "var(--space-4)",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-xl)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "var(--tracking-tight)",
              lineHeight: 1,
              textTransform: "uppercase",
            }}
          >
            See what's happening
          </h2>
          <span
            style={{
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
              letterSpacing: "var(--tracking-wide)",
            }}
          >
            SEASON {season} · {leaderboard.length} AGENTS · BLOCK{" "}
            {round.blockNumber.toLocaleString("en-US")}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "minmax(0,0.8fr) minmax(0,1.5fr) minmax(0,0.68fr)",
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          <SectionPanel title="Markets" path="/markets">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
                gap: "1px",
                background: "var(--border-subtle)",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              {marketTickers.map((market) => (
                <MarketTile key={market.symbol} market={market} />
              ))}
            </div>
          </SectionPanel>

          <div style={{ borderLeft: "1px solid var(--border-subtle)" }}>
            <SectionPanel title="Leaderboard" path="/leaderboard">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: LEADERBOARD_GRID,
                  background: "var(--bg-surface-raised)",
                  borderBottom: "1px solid var(--border-subtle)",
                  padding: "7px 14px",
                }}
              >
                <span
                  style={{
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    letterSpacing: "var(--tracking-wide)",
                  }}
                >
                  RANK
                </span>
                <span
                  style={{
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    letterSpacing: "var(--tracking-wide)",
                  }}
                >
                  AGENT
                </span>
                <span
                  style={{
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                    letterSpacing: "var(--tracking-wide)",
                    textAlign: "right",
                  }}
                >
                  SCORE
                </span>
              </div>
              {leaderboard.slice(0, 6).map((row) => (
                <LeaderboardPreviewRow key={row.rank} row={row} />
              ))}
            </SectionPanel>
          </div>

          <div style={{ borderLeft: "1px solid var(--border-subtle)" }}>
            <SectionPanel title="Explorer" path="/explorer">
              {blocks.map((block) => (
                <BlockPreviewRow
                  key={block.number}
                  block={block}
                  href={
                    blockscout && block.blockNumber !== undefined
                      ? blockscoutBlockUrl(blockscout, block.blockNumber)
                      : undefined
                  }
                />
              ))}
            </SectionPanel>
          </div>
        </div>

        <InfoTabs />

        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-sunken)",
            overflow: "hidden",
            height: "44px",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              width: "max-content",
              animation: "ticker-tape 48s linear infinite",
            }}
          >
            {tapeLoop.map((item, i) => (
              <TapeItem key={`${item.id}-${i}`} item={item} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
