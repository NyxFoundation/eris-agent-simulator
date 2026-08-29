// /markets — what each deployed application is doing.
//
// The page used to be a price chart with a venue-agnostic stat strip, which said almost nothing
// about a run: the price is the environment's own input (a seeded fair path written on-chain every
// block), while what an agent actually reads and trades against is venue *state* — an AMM's depth
// and cross-venue gap, a perp's open interest and funding, a lender's utilization and the health
// factors near the line, a CDP's peg and collateral ratio, an LST's redemption rate against its
// market price. One tab per application, each built from that run's own artifacts.
import { useEffect, useState, type ReactNode } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { CandleChart } from "@/components/CandleChart";
import { ArbitrageChart } from "@/components/ArbitrageChart";
import { StateChart } from "@/components/StateChart";
import { Select } from "@/design-system/Select";
import { Sparkline } from "@/design-system/Sparkline";
import { Tabs } from "@/design-system/Tabs";
import { setSelectedRound } from "@/data/roundSelection";
import { navigate } from "@/navigation";
import { formatPnlUsdc } from "@/lib/format";
import { useMarketSnapshot } from "@/data/useMarketSnapshot";
import type {
  AgentStanding,
  StatTone,
  VenueDepthView,
  VenuePanel,
  VenueStat,
  VenueTable,
  VenueTableCell,
} from "@/data/types";

const SECTION_LABEL_STYLE = {
  font: "var(--weight-medium) 9px var(--font-mono)",
  letterSpacing: "var(--tracking-widest)",
  textTransform: "uppercase" as const,
  color: "var(--text-tertiary)",
};

const RANK_COLORS: Record<number, string> = {
  1: "var(--warning)",
  2: "var(--gray-400)",
  3: "color-mix(in oklch, var(--amber-500), var(--red-500) 40%)",
};

const CHART_VIEWS = [
  { label: "Cross-venue arb", value: "arb" },
  { label: "Fair price", value: "price" },
];

function toneColor(tone: StatTone | "link" | undefined): string {
  switch (tone) {
    case "up":
      return "var(--success-text)";
    case "down":
      return "var(--danger-text)";
    case "warn":
      return "var(--warning)";
    case "link":
      return "var(--text-link)";
    default:
      return "var(--text-primary)";
  }
}

function CrownIcon({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
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

function LeaderboardMiniRow({ row }: { row: AgentStanding }) {
  const isTop3 = row.rank <= 3;
  const pnlColor =
    row.netPnlUsdc >= 0 ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      onClick={() => navigate(`/agent/${row.agent}`)}
      style={{
        display: "grid",
        gridTemplateColumns: "20px 1fr 56px",
        gap: "6px",
        padding: "8px 16px",
        borderTop: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
        cursor: "pointer",
      }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>
        {isTop3 ? <CrownIcon color={RANK_COLORS[row.rank]} /> : row.rank}
      </span>
      <span
        style={{
          color: "var(--text-link)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.agent}
      </span>
      <span style={{ textAlign: "right", color: pnlColor }}>
        {formatPnlUsdc(row.netPnlUsdc)}
      </span>
    </div>
  );
}

function StatTile({ stat }: { stat: VenueStat }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        minWidth: 0,
        background: "var(--bg-surface)",
      }}
    >
      <span style={SECTION_LABEL_STYLE}>{stat.label}</span>
      <span
        style={{
          font: "var(--weight-semibold) var(--text-md) var(--font-mono)",
          color: toneColor(stat.tone),
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {stat.value}
      </span>
      {stat.sub && (
        <span
          style={{
            font: "10px var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          {stat.sub}
        </span>
      )}
    </div>
  );
}

function PanelTable({ table }: { table: VenueTable }) {
  const grid = table.columns
    .map((c, i) =>
      c.width ? c.width : i === 0 ? "minmax(0,1.2fr)" : "minmax(0,1fr)",
    )
    .join(" ");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <span style={SECTION_LABEL_STYLE}>{table.title}</span>
      <div
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: grid,
            gap: "8px",
            padding: "8px 12px",
            background: "var(--bg-surface)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {table.columns.map((column) => (
            <span
              key={column.label}
              style={{
                ...SECTION_LABEL_STYLE,
                textAlign: column.align ?? "left",
              }}
            >
              {column.label}
            </span>
          ))}
        </div>
        {table.rows.length === 0 ? (
          <div
            style={{
              padding: "12px",
              font: "var(--text-xs) var(--font-mono)",
              color: "var(--text-tertiary)",
            }}
          >
            {table.empty}
          </div>
        ) : (
          table.rows.map((row, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                gap: "8px",
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-subtle)",
                font: "var(--text-sm) var(--font-mono)",
              }}
            >
              {row.map((c: VenueTableCell, j) => (
                <span
                  key={j}
                  // The cells are single-line so the columns stay aligned; the full text is one
                  // hover away rather than lost.
                  title={c.text}
                  style={{
                    textAlign: table.columns[j]?.align ?? "left",
                    color: toneColor(c.tone),
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.text}
                </span>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// One AMM venue's pool depth with its executable two-sided quote — the order-book replacement
// (issue #63 Phase 4): every venue is an AMM, so depth and spread are what actually exist.
function VenueDepthRow({ venue }: { venue: VenueDepthView }) {
  const deltaColor =
    venue.deltaPercent >= 0 ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: venue.color,
            display: "inline-block",
            alignSelf: "center",
          }}
        />
        <span
          style={{
            font: "11px var(--font-mono)",
            color: "var(--text-secondary)",
          }}
        >
          {venue.label}
        </span>
        <span
          style={{
            marginLeft: "auto",
            font: "var(--weight-semibold) 12px var(--font-mono)",
            color: "var(--text-primary)",
          }}
        >
          {venue.depthUsd}
        </span>
        <span style={{ font: "11px var(--font-mono)", color: deltaColor }}>
          {venue.deltaPercent >= 0 ? "+" : ""}
          {venue.deltaPercent.toFixed(1)}%
        </span>
      </div>
      <Sparkline
        points={venue.points}
        width={250}
        height={26}
        tone={venue.deltaPercent >= 0 ? "success" : "danger"}
      />
      {(venue.buy !== undefined || venue.sell !== undefined) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            font: "10px var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          <span>
            sell{" "}
            <span style={{ color: "var(--danger-text)" }}>
              {venue.sell ?? "—"}
            </span>
          </span>
          <span>
            buy{" "}
            <span style={{ color: "var(--success-text)" }}>
              {venue.buy ?? "—"}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

function PanelBody({
  panel,
  children,
}: {
  panel: VenuePanel;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        padding: "18px 20px 40px",
        minWidth: 0,
      }}
    >
      <p
        style={{
          margin: 0,
          maxWidth: "84ch",
          font: "var(--text-sm) var(--font-sans)",
          lineHeight: 1.6,
          color: "var(--text-secondary)",
        }}
      >
        {panel.caption}
      </p>

      {panel.note && (
        <div
          style={{
            padding: "8px 12px",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
            font: "var(--text-xs) var(--font-mono)",
            color: "var(--warning)",
          }}
        >
          {panel.note}
        </div>
      )}

      {panel.stats.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "10px",
          }}
        >
          {panel.stats.map((stat) => (
            <StatTile key={stat.label} stat={stat} />
          ))}
        </div>
      )}

      {children}

      {panel.charts.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: "20px",
          }}
        >
          {panel.charts.map((chart) => (
            <StateChart key={chart.id} chart={chart} />
          ))}
        </div>
      )}

      {panel.tables.map((table) => (
        <PanelTable key={table.id} table={table} />
      ))}
    </div>
  );
}

function CenteredMessage({ text, tone }: { text: string; tone?: "danger" }) {
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
          color:
            tone === "danger" ? "var(--danger-text)" : "var(--text-tertiary)",
        }}
      >
        {text}
      </span>
    </div>
  );
}

export function MarketPage() {
  const [selectedBase, setSelectedBase] = useState("WETH");
  const { data, loading, error } = useMarketSnapshot(selectedBase);
  // Empty until the run says which panels it has: the first tab is the run's own lead (Scenario),
  // and hard-coding "amm" made the default disagree with the tab order.
  const [panelId, setPanelId] = useState("");
  const [chartView, setChartView] = useState("arb");

  // The run switch can change which applications exist; keep the tab on something the run has.
  const panelIds: string[] = data?.panels.map((p) => p.id) ?? [];
  const panelKey = panelIds.join("|");
  useEffect(() => {
    if (panelIds.length > 0 && !panelIds.includes(panelId))
      setPanelId(panelIds[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelKey]);

  if (loading) return <CenteredMessage text="Loading Eris…" />;
  if (error || !data)
    return (
      <CenteredMessage
        text={`Failed to load data${error ? `: ${error.message}` : ""}`}
        tone="danger"
      />
    );

  const {
    round,
    scope,
    protocols,
    pairs,
    base,
    fairPrice,
    fairDirection,
    candles,
    arbitrage,
    venueDepths,
    panels,
    leaderboard,
    feed,
  } = data;

  const panel = panels.find((p) => p.id === panelId) ?? panels[0];
  const priceColor =
    fairDirection === "up" ? "var(--success-text)" : "var(--danger-text)";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: "var(--bg-canvas)",
      }}
    >
      <Sidebar activePage="markets" />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <RoundsBar round={round} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "24px",
            padding: "12px 20px",
            borderBottom: "1px solid var(--border-subtle)",
            flexWrap: "wrap",
          }}
        >
          <Select
            value={base}
            options={
              pairs.length > 0
                ? pairs
                : [{ label: `${base}/USDC`, value: base }]
            }
            onChange={(e) => setSelectedBase(e.target.value)}
            style={{ minWidth: "150px" }}
          />
          <div>
            <div style={SECTION_LABEL_STYLE}>
              Fair price · environment input
            </div>
            <div
              style={{
                font: "var(--weight-semibold) var(--text-lg) var(--font-mono)",
                color: priceColor,
              }}
            >
              {fairPrice.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <div style={SECTION_LABEL_STYLE}>Venues in this run</div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {protocols.length === 0 && (
                <span
                  style={{
                    font: "var(--text-xs) var(--font-mono)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  not recorded
                </span>
              )}
              {protocols.map((p) => (
                <span
                  key={p}
                  style={{
                    font: "10px var(--font-mono)",
                    letterSpacing: "var(--tracking-wide)",
                    textTransform: "uppercase",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    padding: "2px 6px",
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Which blocks everything below covers. Selecting a round in the bar above narrows every
            series, stat and table on this page — the end-of-run position tables say so in their
            own titles, because those are the run's close whatever window is selected. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "8px 20px",
            borderBottom: "1px solid var(--border-subtle)",
            background:
              scope.roundIndex === null ? "transparent" : "var(--bg-surface)",
            flexWrap: "wrap",
          }}
        >
          <span style={SECTION_LABEL_STYLE}>Scope</span>
          <span
            style={{
              font: "var(--text-xs) var(--font-mono)",
              color:
                scope.roundIndex === null || panel?.runWide
                  ? "var(--text-tertiary)"
                  : "var(--pink-300)",
            }}
          >
            {panel?.runWide
              ? `whole run · blocks ${round.epochs[0]?.fromBlock.toLocaleString("en-US") ?? "—"}–${round.blockNumber.toLocaleString("en-US")} · this tab is never scoped to a round`
              : scope.roundIndex === null
                ? `whole run · blocks ${scope.fromBlock.toLocaleString("en-US")}–${scope.toBlock.toLocaleString("en-US")}`
                : `Round ${String(scope.roundIndex).padStart(2, "0")} · blocks ${scope.fromBlock.toLocaleString("en-US")}–${scope.toBlock.toLocaleString("en-US")}`}
          </span>
          {scope.roundIndex === null || panel?.runWide ? (
            <span
              style={{
                font: "var(--text-xs) var(--font-mono)",
                color: "var(--text-tertiary)",
              }}
            >
              click a round in the bar above to narrow every panel to it
            </span>
          ) : (
            <span
              onClick={() => setSelectedRound(null)}
              style={{
                font: "var(--text-xs) var(--font-mono)",
                color: "var(--text-link)",
                cursor: "pointer",
              }}
            >
              show the whole run →
            </span>
          )}
        </div>

        <main
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) 300px",
            flex: 1,
            width: "100%",
            boxSizing: "border-box",
            minHeight: 0,
          }}
        >
          <div
            style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
          >
            <div style={{ padding: "0 20px" }}>
              <Tabs
                tabs={panels.map((p) => ({ label: p.label, value: p.id }))}
                value={panel?.id ?? ""}
                onChange={setPanelId}
              />
            </div>

            {panel ? (
              <PanelBody panel={panel}>
                {panel.id === "amm" && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                    }}
                  >
                    <div style={{ maxWidth: "340px" }}>
                      <Tabs
                        tabs={CHART_VIEWS}
                        value={chartView}
                        onChange={setChartView}
                      />
                    </div>
                    {chartView === "arb" ? (
                      <div>
                        <div
                          style={{
                            display: "flex",
                            gap: "16px",
                            padding: "0 0 10px",
                            flexWrap: "wrap",
                          }}
                        >
                          {arbitrage.venues.map((v) => (
                            <span
                              key={v.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                font: "11px var(--font-mono)",
                                color: "var(--text-secondary)",
                              }}
                            >
                              <span
                                style={{
                                  width: "8px",
                                  height: "8px",
                                  borderRadius: "50%",
                                  background: v.color,
                                  display: "inline-block",
                                }}
                              />
                              {v.label}
                            </span>
                          ))}
                          <span
                            style={{
                              marginLeft: "auto",
                              font: "11px var(--font-mono)",
                              color: "var(--text-tertiary)",
                            }}
                          >
                            ▲ buy / ▼ sell, coloured by venue · dashed = fair ·
                            lower pane = widest venue gap vs the{" "}
                            {arbitrage.thresholdBps}bps round-trip cost
                          </span>
                        </div>
                        <ArbitrageChart data={arbitrage} height={380} />
                      </div>
                    ) : (
                      <CandleChart candles={candles} height={300} />
                    )}
                    {venueDepths.length > 0 && (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(240px, 1fr))",
                          gap: "16px",
                          paddingTop: "8px",
                        }}
                      >
                        {venueDepths.map((venue) => (
                          <VenueDepthRow key={venue.id} venue={venue} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </PanelBody>
            ) : (
              <div
                style={{
                  padding: "24px 20px",
                  font: "var(--text-sm) var(--font-mono)",
                  color: "var(--text-tertiary)",
                }}
              >
                this run enabled no venue the dashboard knows how to render
              </div>
            )}
          </div>

          <div
            style={{
              borderLeft: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                padding: "14px 16px 10px",
              }}
            >
              <span style={SECTION_LABEL_STYLE}>Leaderboard</span>
              <span
                onClick={() => navigate("/leaderboard")}
                style={{
                  font: "11px var(--font-mono)",
                  color: "var(--text-link)",
                  cursor: "pointer",
                }}
              >
                all →
              </span>
            </div>
            {leaderboard.slice(0, 8).map((row) => (
              <LeaderboardMiniRow key={row.rank} row={row} />
            ))}

            <div
              style={{
                padding: "16px 16px 6px",
                borderTop: "1px solid var(--border-subtle)",
                marginTop: "12px",
              }}
            >
              <span style={SECTION_LABEL_STYLE}>Agent submissions ↓</span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                padding: "0 16px 16px",
              }}
            >
              {feed.length === 0 && (
                <span
                  style={{
                    font: "11px var(--font-mono)",
                    color: "var(--text-tertiary)",
                    paddingTop: "6px",
                  }}
                >
                  no agent submitted a transaction in this run
                </span>
              )}
              {feed.map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: "6px 0",
                    borderBottom: "1px solid var(--border-subtle)",
                    font: "11px var(--font-mono)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {item.text}
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
