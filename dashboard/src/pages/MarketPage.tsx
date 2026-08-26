import { useState } from "react";
import { RoundsBar } from "@/components/RoundsBar";
import { Sidebar } from "@/components/Sidebar";
import { CandleChart } from "@/components/CandleChart";
import { ArbitrageChart } from "@/components/ArbitrageChart";
import { Select } from "@/design-system/Select";
import { Sparkline } from "@/design-system/Sparkline";
import { Tabs } from "@/design-system/Tabs";
import { navigate } from "@/navigation";
import { useMarketSnapshot } from "@/data/useMarketSnapshot";
import type {
  AgentStanding,
  MarketOrder,
  MarketPosition,
  MarketTrade,
  VenueDepthView,
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
  { label: "Price", value: "price" },
  { label: "Cross-venue arb", value: "arb" },
];

const POSITIONS_GRID = "1fr 60px 80px 90px 90px";
const TRADES_GRID = "1fr 90px 90px";

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
    row.pnlPercent >= 0 ? "var(--success-text)" : "var(--danger-text)";
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
        {row.pnlPercent >= 0 ? "+" : ""}
        {row.pnlPercent.toFixed(1)}%
      </span>
    </div>
  );
}

function PositionRow({ row }: { row: MarketPosition }) {
  const sideColor =
    row.side === "long" ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      title="Position detail not yet available"
      style={{
        display: "grid",
        gridTemplateColumns: POSITIONS_GRID,
        padding: "10px 20px",
        borderBottom: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
        cursor: "not-allowed",
      }}
    >
      <span style={{ color: "var(--text-link)" }}>{row.agent}</span>
      <span style={{ color: sideColor, textTransform: "uppercase" }}>
        {row.side}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-primary)" }}>
        {row.size}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>
        {row.entry}
      </span>
      <span style={{ textAlign: "right", color: sideColor }}>
        {row.pnlPercent >= 0 ? "+" : ""}
        {row.pnlPercent.toFixed(1)}%
      </span>
    </div>
  );
}

function OrderRow({ row }: { row: MarketOrder }) {
  const sideColor =
    row.side === "long" ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: POSITIONS_GRID,
        padding: "10px 20px",
        borderBottom: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
      }}
    >
      <span style={{ color: "var(--text-link)" }}>{row.agent}</span>
      <span style={{ color: sideColor, textTransform: "uppercase" }}>
        {row.side}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-primary)" }}>
        {row.size}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>
        {row.trigger}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-tertiary)" }}>
        {row.status}
      </span>
    </div>
  );
}

function TradeRow({ row }: { row: MarketTrade }) {
  const sideColor =
    row.side === "long" ? "var(--success-text)" : "var(--danger-text)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: TRADES_GRID,
        padding: "10px 20px",
        borderBottom: "1px solid var(--border-subtle)",
        font: "var(--text-sm) var(--font-mono)",
      }}
    >
      <span style={{ color: sideColor }}>{row.agent}</span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>
        {row.size}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-tertiary)" }}>
        {row.price}
      </span>
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

export function MarketPage() {
  const [selectedBase, setSelectedBase] = useState("WETH");
  const { data, loading, error } = useMarketSnapshot(selectedBase);
  const [bottomTab, setBottomTab] = useState("positions");
  const [chartView, setChartView] = useState("price");

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

  const {
    round,
    stats,
    candles,
    leaderboard,
    positions,
    orders,
    trades,
    venueDepths,
    pairs,
    feed,
    arbitrage,
  } = data;
  const priceColor =
    stats.direction === "up" ? "var(--success-text)" : "var(--danger-text)";
  const midPrice = stats.price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Trigger orders exist in the protocol but no current strategy uses them; the tab only appears
  // when a run actually produced some (issue #63 Phase 4).
  const bottomTabs = [
    { label: "Positions", value: "positions" },
    ...(orders.length > 0 ? [{ label: "Orders", value: "orders" }] : []),
    { label: "Trades", value: "trades" },
  ];

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
            gap: "32px",
            padding: "12px 24px",
            borderBottom: "1px solid var(--border-subtle)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: "150px" }}>
            <Select
              value={selectedBase}
              options={
                pairs.length > 0
                  ? pairs
                  : [{ label: `${selectedBase}/USDC`, value: selectedBase }]
              }
              onChange={(e) => setSelectedBase(e.target.value)}
              style={{ minWidth: "150px" }}
            />
          </div>
          <span
            style={{
              font: "var(--weight-semibold) var(--text-lg) var(--font-mono)",
              color: priceColor,
            }}
          >
            {midPrice}
          </span>
          <div>
            <div style={SECTION_LABEL_STYLE}>24h volume</div>
            <div
              style={{
                font: "var(--text-sm) var(--font-mono)",
                color: "var(--text-primary)",
              }}
            >
              {stats.volume24h}
            </div>
          </div>
          <div>
            <div style={SECTION_LABEL_STYLE}>Open interest</div>
            <div
              style={{
                font: "var(--text-sm) var(--font-mono)",
                color: "var(--text-primary)",
              }}
            >
              {stats.openInterest}{" "}
              <span style={{ color: "var(--success-text)" }}>
                {stats.openInterestLongPercent}%
              </span>
              /
              <span style={{ color: "var(--danger-text)" }}>
                {stats.openInterestShortPercent}%
              </span>
            </div>
          </div>
          <div>
            <div style={SECTION_LABEL_STYLE}>Available liquidity</div>
            <div
              style={{
                font: "var(--text-sm) var(--font-mono)",
                color: "var(--text-primary)",
              }}
            >
              {stats.availableLiquidity} / {stats.totalLiquidity}
            </div>
          </div>
          <div>
            <div style={SECTION_LABEL_STYLE}>Funding / 1h</div>
            <div
              style={{
                font: "var(--text-sm) var(--font-mono)",
                color: "var(--text-primary)",
              }}
            >
              {stats.fundingRate1h}
            </div>
          </div>
        </div>

        <main
          style={{
            display: "grid",
            gridTemplateColumns: "240px 1fr 300px",
            flex: 1,
            width: "100%",
            boxSizing: "border-box",
            minHeight: 0,
          }}
        >
          <div
            style={{
              borderRight: "1px solid var(--border-subtle)",
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
          </div>

          <div
            style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
          >
            <div style={{ padding: "0 20px" }}>
              <Tabs
                tabs={CHART_VIEWS}
                value={chartView}
                onChange={setChartView}
              />
            </div>

            {chartView === "price" ? (
              <div style={{ padding: "16px 20px 8px" }}>
                <CandleChart candles={candles} height={320} />
              </div>
            ) : (
              <div style={{ padding: "16px 20px 8px" }}>
                <div
                  style={{ display: "flex", gap: "16px", padding: "0 0 10px" }}
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
                    threshold {arbitrage.thresholdBps}bps · round-trip cost
                  </span>
                </div>
                <ArbitrageChart data={arbitrage} height={320} />
              </div>
            )}

            <div
              style={{
                padding: "0 20px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <Tabs
                tabs={bottomTabs}
                value={bottomTab}
                onChange={setBottomTab}
              />
            </div>

            {bottomTab === "positions" && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: POSITIONS_GRID,
                    padding: "9px 20px",
                    font: "9px var(--font-mono)",
                    color: "var(--text-tertiary)",
                    textTransform: "uppercase",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <span>Agent</span>
                  <span>Side</span>
                  <span style={{ textAlign: "right" }}>Size</span>
                  <span style={{ textAlign: "right" }}>Entry</span>
                  <span style={{ textAlign: "right" }}>PnL</span>
                </div>
                {positions.map((row, i) => (
                  <PositionRow key={i} row={row} />
                ))}
              </div>
            )}

            {bottomTab === "orders" && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: POSITIONS_GRID,
                    padding: "9px 20px",
                    font: "9px var(--font-mono)",
                    color: "var(--text-tertiary)",
                    textTransform: "uppercase",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <span>Agent</span>
                  <span>Side</span>
                  <span style={{ textAlign: "right" }}>Size</span>
                  <span style={{ textAlign: "right" }}>Trigger</span>
                  <span style={{ textAlign: "right" }}>Status</span>
                </div>
                {orders.map((row, i) => (
                  <OrderRow key={i} row={row} />
                ))}
              </div>
            )}

            {bottomTab === "trades" && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: TRADES_GRID,
                    padding: "9px 20px",
                    font: "9px var(--font-mono)",
                    color: "var(--text-tertiary)",
                    textTransform: "uppercase",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <span>Agent</span>
                  <span style={{ textAlign: "right" }}>Size</span>
                  <span style={{ textAlign: "right" }}>Price</span>
                </div>
                {trades.map((row, i) => (
                  <TradeRow key={i} row={row} />
                ))}
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
                padding: "12px 16px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span style={SECTION_LABEL_STYLE}>AMM depth</span>
            </div>
            <div
              style={{
                padding: "10px 16px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              {venueDepths.length === 0 && (
                <span
                  style={{
                    font: "11px var(--font-mono)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  depth series appears after the run completes
                </span>
              )}
              {venueDepths.map((venue) => (
                <VenueDepthRow key={venue.id} venue={venue} />
              ))}
            </div>
            <div style={{ padding: "12px 16px 6px" }}>
              <span style={SECTION_LABEL_STYLE}>Recent trades ↓</span>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                padding: "0 16px 16px",
              }}
            >
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
