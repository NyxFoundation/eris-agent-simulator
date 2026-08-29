import { useState, type ReactNode } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { Sparkline } from "@/design-system/Sparkline";
import { blockscoutBlockUrl, useBlockscoutBase } from "@/data/blockscout";
import { useTopPageSnapshot } from "@/data/useTopPageSnapshot";
import { navigate } from "@/navigation";
import { formatScore } from "@/lib/format";
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

// Real copy about this simulator (issue #63 Phase 4) — the seed build shipped a fictional
// marketing text here. Sources: README, ADR 0006 (environment/agent split, post-run scoring),
// ADR 0019 (epoch scoring), issue #63 (artifacts).
const INFO_TABS: InfoTab[] = [
  {
    key: "overview",
    num: "01",
    label: "Overview",
    body: [
      "Eris is a DeFi trading-competition simulator. Autonomous agents compete on a multi-protocol venue set — Uniswap v3, Balancer, Curve, GMX v2 and Aave v3, plus optional LST and CDP-stablecoin venues — all deployed on a local anvil chain.",
      "Agents run as fully independent processes and see only finalized on-chain state: no privileged RPC, no pending transactions, no other agent's orders. Each block they observe, decide, and sign their own transactions; in-block ordering is anvil's fee ordering (descending priority fee), so priority is something you bid for.",
      "The environment daemon drives the market: a seed-derived fair price written on-chain every block, uninformed and informed order flow, a GMX keeper, and scheduled stress events — crashes, liquidity pulls, stablecoin depegs, whale orders — that agents cannot opt out of.",
      "Self-improving agents pair a rule strategy with an LLM that rewrites the strategy code mid-run. The LLM is never in the trade path: the rules trade every block on their own, and revisions install only after a static check, compilation, and a sandboxed test run.",
    ],
  },
  {
    key: "environment",
    num: "02",
    label: "Environment",
    body: [
      "SEED is a label for market conditions. The fair-price path is reproducible per (regime, seed), but transaction timing and in-block ordering are not — the same scenario replayed twice gives different fills, which is the point of measuring over many scenarios.",
      "Official regimes: calm, cex-drift, informed-flow, whale, lending-incident, crash, and depeg. A scenario is one (regime, seed) pair; the backtest matrix replays a whole set against a state dump and ranks agents per regime.",
      "Stress events are randomized-but-deterministic overlays on the fair price (ramp, hold, decay), liquidity pulls that thin every AMM pool at once, and depegs where the environment leans on a stablecoin's pool until the window closes. Seeded victim positions make Aave liquidations reachable for agents that watch health factors.",
      "The fair price is distributed on-chain through a PriceFeed contract and lands one block late for everyone equally — reacting to information a block after it exists is part of the game.",
    ],
  },
  {
    key: "scoring",
    num: "03",
    label: "Scoring",
    body: [
      "Scoring happens after the run, not during it. The coordinator walks back over historical block state and values every agent at identical block cross-sections (one batched multicall per block), so the live loop pays nothing for it and no agent can game a snapshot phase.",
      "Score is mean − λ·std of per-epoch log returns of total account value, measured in excess of the roster's do-nothing baseline agent. The leaderboard shows it in bps of log growth per epoch.",
      "PnL%, Sharpe (mean/std of the same epoch returns) and max drawdown come from the same reconstructed series and are shown for context; rank is by score. The rank move column is the change over the run's final epoch.",
      "Holdings the scorer cannot price are reported, never silently zeroed — a zero that is really a read failure would be indistinguishable from a trading loss.",
    ],
  },
  {
    key: "artifacts",
    num: "04",
    label: "Artifacts",
    body: [
      "Everything on these pages is derived from the run's files: summary.json (standings and epoch scores), events.jsonl (reconstructed observations and the event stream), blocks.csv (every transaction), agents/<id>.jsonl (each agent's own decision log), and market.json (per-venue prices, pool depth, GMX/Aave state, decoded transaction notionals).",
      "The chain is the source of truth: every numeric series is reconstructed from on-chain reads after the run. Logs supply only reasoning, intent and identity.",
      "While a run is live the dashboard tails the log files and reads the chain over RPC — prices, blocks, the event tape and decision logs update in place. Scores and per-venue series appear the moment the run completes.",
      "The local Blockscout explorer (npm run explorer) is the deep-dive tool: when it is running, every transaction, address and block on these pages links into it.",
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
        {formatScore(row.score)}
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

  const { round, leaderboard, marketTickers, blocks, tape } = data;
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
              "linear-gradient(90deg, rgba(8,6,16,0.92) 0%, rgba(8,6,16,0.55) 42%, rgba(8,6,16,0.15) 100%), url('/assets/eris-bg.png')",
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
            ERIS
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
            RUN {round.runNumber} · {leaderboard.length} AGENTS · BLOCK{" "}
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
