import type { ReactNode } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { t } from "@/i18n/messages";
import { Sidebar } from "@/components/Sidebar";
import { Sparkline } from "@/design-system/Sparkline";
import { blockscoutBlockUrl, useBlockscoutBase } from "@/data/blockscout";
import { useScenarioLabel } from "@/data/useScenarioLabel";
import { useTopPageSnapshot } from "@/data/useTopPageSnapshot";
import { useMode } from "@/data/mode";
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

function SectionPanel({
  title,
  path,
  children,
}: {
  title: string;
  path?: string;
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
        {path && (
          <span
            onClick={() => navigate(path)}
            style={{
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-link)",
              letterSpacing: "var(--tracking-wide)",
              cursor: "pointer",
            }}
          >
            {t("common.seeAll")}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export function ScenarioPage() {
  const scenario = useScenarioLabel();
  const { data, loading, error } = useTopPageSnapshot();
  const blockscout = useBlockscoutBase();
  const mode = useMode();

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
          {t("common.loading")}
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
          {t("common.loadFailed", {
            detail: error ? `: ${error.message}` : "",
          })}
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
      <Sidebar activePage="scenario" />

      <div style={{ flex: 1, minWidth: 0 }}>
        <RoundsBar round={round} />

        {/* The page header, in the standings page's grammar: the scenario's name at heading size,
            one meta line, nothing decorative. It used to be a 340px hero over a background image
            with a display-size timestamp and "See what's happening" beneath it -- a poster in a
            monitoring tool, and the only page that had one. The three panels below are the page. */}
        <header
          style={{
            borderBottom: "1px solid var(--border-subtle)",
            padding: "var(--space-6) var(--space-6) var(--space-4)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {/* Which unit is on screen, and what it sits inside. A scenario opened from the
              standings otherwise looks like a page in its own right, and "round 14" on it reads as
              a round of the competition rather than of this one world. */}
          <a
            onClick={() => navigate("/")}
            style={{
              font: "var(--text-xs) var(--font-mono)",
              letterSpacing: "var(--tracking-wide)",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
              cursor: "pointer",
              textDecoration: "none",
            }}
          >
            <span style={{ color: "var(--text-link)" }}>
              {t("units.competition")}
            </span>
            {"  ›  "}
            {t("units.scenario")}
          </a>
          {/* The scenario names itself (regime#seed, or a practice period's day). */}
          <h1
            title={round.runId}
            style={{
              margin: 0,
              font: "var(--weight-bold) 21px var(--font-sans)",
              letterSpacing: "var(--tracking-tight)",
              color: "var(--text-primary)",
            }}
          >
            {scenario.name?.replace(/^full-/, "") ??
              t("scenario.fallbackTitle")}
          </h1>
          <span
            style={{
              font: "var(--text-sm) var(--font-mono)",
              color: "var(--text-secondary)",
            }}
          >
            {[
              scenario.seed !== null
                ? t("scenario.seed", { n: scenario.seed })
                : null,
              round.epochs.length > 0
                ? t("scenario.roundsBlocks", {
                    rounds: round.epochs.length,
                    blocks: round.epochBlocks,
                  })
                : null,
              scenario.competition,
              scenario.name === null ? round.runId : null,
              t("scenario.heroMeta", {
                agents: leaderboard.length,
                block: round.blockNumber.toLocaleString("en-US"),
              }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "minmax(0,0.8fr) minmax(0,1.5fr) minmax(0,0.68fr)",
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          <SectionPanel title={t("scenario.markets")} path="/markets">
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
            {/* Rules §4.7: the trial environment posts no standings; the per-run ranking is one. */}
            {mode.standings ? (
              <SectionPanel title={t("scenario.standings")}>
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
                      textTransform: "uppercase",
                    }}
                  >
                    {t("rounds.col.rank")}
                  </span>
                  <span
                    style={{
                      font: "var(--text-xs) var(--font-mono)",
                      color: "var(--text-tertiary)",
                      letterSpacing: "var(--tracking-wide)",
                      textTransform: "uppercase",
                    }}
                  >
                    {t("home.col.agent")}
                  </span>
                  <span
                    title={t("agent.standing.score")}
                    style={{
                      font: "var(--text-xs) var(--font-mono)",
                      color: "var(--text-tertiary)",
                      letterSpacing: "var(--tracking-wide)",
                      textAlign: "right",
                      textTransform: "uppercase",
                    }}
                  >
                    {t("home.col.score")}
                  </span>
                </div>
                {leaderboard.map((row) => (
                  <LeaderboardPreviewRow key={row.rank} row={row} />
                ))}
              </SectionPanel>
            ) : (
              <SectionPanel title={t("scenario.standings")}>
                <p
                  style={{
                    margin: 0,
                    padding: "12px 14px",
                    font: "var(--text-xs) var(--font-sans)",
                    lineHeight: 1.6,
                    color: "var(--text-tertiary)",
                  }}
                >
                  {t("home.standingsOff")}
                </p>
              </SectionPanel>
            )}
          </div>

          <div style={{ borderLeft: "1px solid var(--border-subtle)" }}>
            <SectionPanel title={t("scenario.explorer")} path="/explorer">
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
