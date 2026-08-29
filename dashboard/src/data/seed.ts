import type {
  AgentDetail,
  AgentLogLine,
  AgentPosition,
  AgentStanding,
  AgentTrade,
  ArbitrageSnapshot,
  ArbTradeMarker,
  ArchiveClosingPrice,
  ArchiveEvent,
  ArchiveFinalStanding,
  ArchivePodiumEntry,
  ArchiveRoundInfo,
  ArchiveStats,
  Candle,
  ExplorerBlock,
  ExplorerStats,
  ExplorerTransaction,
  MarketFeedItem,
  MarketOrder,
  MarketPosition,
  MarketStats,
  MarketTicker,
  MarketTrade,
  RoundInfo,
  RoundProgressSegment,
  TapeEvent,
  VenueDepthView,
  VenueSeries,
} from "./types";

export const ROUND_DURATION_MS = 2 * 3600 * 1000 + 14 * 60 * 1000 + 36 * 1000;
export const SEASON_LENGTH = 13;

export function createSeedRound(): RoundInfo {
  const endsAt = Date.now() + 42 * 60 * 1000 + 18 * 1000;
  return {
    roundNumber: 14,
    status: "live",
    startsAt: endsAt - ROUND_DURATION_MS,
    endsAt,
    blockNumber: 19_442_110,
  };
}

export const seedAgents: AgentStanding[] = [
  {
    rank: 1,
    agent: "agent-9a12",
    strategy: "Options-hedged farming",
    strategyCategory: "mm",
    score: 92.4,
    netPnlUsdc: 6120,
    sharpe: 2.41,
    maxDrawdownPercent: -4.1,
    move: 0,
  },
  {
    rank: 2,
    agent: "agent-21cd",
    strategy: "Cross-DEX arbitrage",
    strategyCategory: "arb",
    score: 88.1,
    netPnlUsdc: 4890,
    sharpe: 2.18,
    maxDrawdownPercent: -3.0,
    move: 2,
  },
  {
    rank: 3,
    agent: "agent-7788",
    strategy: "Funding rate carry",
    strategyCategory: "arb",
    score: 81.6,
    netPnlUsdc: 3340,
    sharpe: 2.02,
    maxDrawdownPercent: -5.6,
    move: -1,
  },
  {
    rank: 4,
    agent: "agent-4f2a",
    strategy: "Delta-neutral LP",
    strategyCategory: "mm",
    score: 74.9,
    netPnlUsdc: 1840,
    sharpe: 1.84,
    maxDrawdownPercent: -6.2,
    move: 1,
  },
  {
    rank: 5,
    agent: "agent-55aa",
    strategy: "Liquidation sniper",
    strategyCategory: "dir",
    score: 70.2,
    netPnlUsdc: 1500,
    sharpe: 1.61,
    maxDrawdownPercent: -8.9,
    move: -2,
  },
  {
    rank: 6,
    agent: "agent-3e91",
    strategy: "Perp momentum",
    strategyCategory: "dir",
    score: 65.8,
    netPnlUsdc: 970.25,
    sharpe: 1.42,
    maxDrawdownPercent: -7.3,
    move: 0,
  },
  {
    rank: 7,
    agent: "agent-c204",
    strategy: "Stablecoin basis",
    strategyCategory: "arb",
    score: 61.0,
    netPnlUsdc: 720.5,
    sharpe: 1.3,
    maxDrawdownPercent: -2.1,
    move: 3,
  },
  {
    rank: 8,
    agent: "agent-88b1",
    strategy: "Oracle lag exploit",
    strategyCategory: "arb",
    score: 55.4,
    netPnlUsdc: 490.75,
    sharpe: 1.05,
    maxDrawdownPercent: -11.4,
    move: -3,
  },
  {
    rank: 9,
    agent: "agent-1a6f",
    strategy: "Long-only spot",
    strategyCategory: "dir",
    score: 48.7,
    netPnlUsdc: -180.4,
    sharpe: 0.71,
    maxDrawdownPercent: -14.0,
    move: 1,
  },
  {
    rank: 10,
    agent: "agent-de33",
    strategy: "Flashloan arb",
    strategyCategory: "arb",
    score: 41.2,
    netPnlUsdc: -640.9,
    sharpe: 0.52,
    maxDrawdownPercent: -18.7,
    move: -1,
  },
];

/**
 * Rounds progress bar on the top page: a fixed-length season of `SEASON_LENGTH`
 * rounds, wrapping so any absolute round number maps to a season position.
 */
export function buildRoundsProgress(roundNumber: number): {
  liveRoundLabel: string;
  totalRounds: number;
  roundsProgress: RoundProgressSegment[];
} {
  const liveIndex = (roundNumber - 1) % SEASON_LENGTH;
  const roundsProgress: RoundProgressSegment[] = Array.from(
    { length: SEASON_LENGTH },
    (_, i) => ({
      n: String(i + 1).padStart(2, "0"),
      status: i < liveIndex ? "done" : i === liveIndex ? "live" : "upcoming",
    }),
  );
  return {
    liveRoundLabel: String(liveIndex + 1).padStart(2, "0"),
    totalRounds: SEASON_LENGTH,
    roundsProgress,
  };
}

const up = "up" as const;
const down = "down" as const;

export const seedMarketTickers: MarketTicker[] = [
  {
    symbol: "ETH-USD",
    price: "$3,412.60",
    delta: "+1.84%",
    direction: up,
    points: [3180, 3220, 3190, 3260, 3300, 3280, 3350, 3412],
  },
  {
    symbol: "BTC-USD",
    price: "$61,204",
    delta: "-0.62%",
    direction: down,
    points: [61800, 61950, 61700, 61500, 61350, 61600, 61300, 61204],
  },
  {
    symbol: "SOL-USD",
    price: "$148.22",
    delta: "+4.10%",
    direction: up,
    points: [138, 141, 139, 144, 146, 145, 147, 148.2],
  },
  {
    symbol: "USDX-USD",
    price: "$0.9942",
    delta: "-0.58%",
    direction: down,
    points: [1.0, 0.999, 0.998, 0.9975, 0.996, 0.9955, 0.995, 0.9942],
  },
  {
    symbol: "ARB-USD",
    price: "$1.084",
    delta: "+2.31%",
    direction: up,
    points: [1.03, 1.04, 1.035, 1.05, 1.06, 1.055, 1.07, 1.084],
  },
  {
    symbol: "stETH-ETH",
    price: "0.9968",
    delta: "-0.11%",
    direction: down,
    points: [0.9985, 0.998, 0.9979, 0.9974, 0.9972, 0.997, 0.9969, 0.9968],
  },
  {
    symbol: "Funding APR",
    price: "11.4%",
    delta: "+0.9pp",
    direction: up,
    points: [9.8, 10.1, 10.5, 10.3, 10.9, 11.0, 11.2, 11.4],
  },
  {
    symbol: "Borrow util.",
    price: "78.2%",
    delta: "+3.4pp",
    direction: up,
    points: [70, 71, 73, 72, 75, 76, 77, 78.2],
  },
  {
    symbol: "Pool TVL",
    price: "$284.7M",
    delta: "+2.1%",
    direction: up,
    points: [268, 271, 274, 270, 277, 280, 282, 284.7],
  },
];

const TAPE_TONES: Record<string, TapeEvent["tone"]> = {
  DEPEG: "down",
  LIQUIDATION: "down",
  REVERT: "down",
  FILL: "up",
  FLASHLOAN: "up",
  WHALE: "purple",
  SCENARIO: "accent",
  ORACLE: "purple",
};

export const seedTape: TapeEvent[] = [
  {
    id: 1,
    time: "14:02:11",
    kind: "DEPEG",
    body: "USDX pool imbalance",
    value: "-0.58%",
    tone: TAPE_TONES.DEPEG,
  },
  {
    id: 2,
    time: "14:01:47",
    kind: "LIQUIDATION",
    body: "agent-55aa position closed",
    value: "-12.4 ETH",
    tone: TAPE_TONES.LIQUIDATION,
  },
  {
    id: 3,
    time: "14:01:20",
    kind: "WHALE",
    body: "AMM swap ETH → USDC",
    value: "4,200 ETH",
    tone: TAPE_TONES.WHALE,
  },
  {
    id: 4,
    time: "14:00:58",
    kind: "FILL",
    body: "agent-9a12 opened perp long",
    value: "+1.8x",
    tone: TAPE_TONES.FILL,
  },
  {
    id: 5,
    time: "14:00:31",
    kind: "SCENARIO",
    body: "CEX drift injected",
    value: "sigma 2.4",
    tone: TAPE_TONES.SCENARIO,
  },
  {
    id: 6,
    time: "13:59:52",
    kind: "ORACLE",
    body: "stETH-ETH feed updated",
    value: "0.9968",
    tone: TAPE_TONES.ORACLE,
  },
  {
    id: 7,
    time: "13:59:04",
    kind: "FLASHLOAN",
    body: "agent-21cd arb executed",
    value: "+8.6k USDC",
    tone: TAPE_TONES.FLASHLOAN,
  },
  {
    id: 8,
    time: "13:58:22",
    kind: "REVERT",
    body: "agent-7788 tx reverted",
    value: "gas 214k",
    tone: TAPE_TONES.REVERT,
  },
];

export const seedExplorerStats: ExplorerStats = {
  latestBlockNumber: "19,442,110",
  txCountThisRound: 1204,
  activeAgents: 24,
  avgBlockTimeSeconds: 12,
};

export const seedBlocks: ExplorerBlock[] = [
  { number: "19,442,110", time: "2s ago", txCount: 18 },
  { number: "19,442,109", time: "14s ago", txCount: 22 },
  { number: "19,442,108", time: "26s ago", txCount: 15 },
  { number: "19,442,107", time: "38s ago", txCount: 31 },
  { number: "19,442,106", time: "50s ago", txCount: 9 },
  { number: "19,442,105", time: "1m ago", txCount: 27 },
];

export const seedTransactions: ExplorerTransaction[] = [
  {
    seq: 0,
    hash: "0x71a…4f2",
    agent: "agent-9a12",
    method: "openPosition",
    amount: "4.2 ETH",
    time: "2s ago",
    methodTone: "default",
  },
  {
    seq: 1,
    hash: "0x2c9…a01",
    agent: "agent-21cd",
    method: "swap",
    amount: "12,000 USDC",
    time: "14s ago",
    methodTone: "default",
  },
  {
    seq: 2,
    hash: "0x9d4…7bc",
    agent: "agent-88b1",
    method: "liquidation",
    amount: "-2.1 wBTC",
    time: "26s ago",
    methodTone: "danger",
  },
  {
    seq: 3,
    hash: "0x5e2…0d9",
    agent: "agent-7788",
    method: "closePosition",
    amount: "+3.8% ETH",
    time: "38s ago",
    methodTone: "default",
  },
  {
    seq: 4,
    hash: "0x1f8…c3a",
    agent: "agent-4f2a",
    method: "addLiquidity",
    amount: "9,600 USDC",
    time: "50s ago",
    methodTone: "default",
  },
  {
    seq: 5,
    hash: "0x8b0…9e1",
    agent: "agent-de33",
    method: "flashLoan",
    amount: "50,000 USDC",
    time: "1m ago",
    methodTone: "default",
  },
];

export const seedMarketStats: MarketStats = {
  pair: "ETH/USDC",
  price: 3412.08,
  direction: "up",
  volume24h: "$3.3m",
  openInterest: "$4.2M",
  openInterestLongPercent: 52,
  openInterestShortPercent: 48,
  availableLiquidity: "$53.1m",
  totalLiquidity: "$50.1m",
  fundingRate1h: "0.008%",
};

// Deterministic OHLC series so the chart looks the same on every load.
const seedCloses = [
  3380, 3392, 3375, 3401, 3418, 3406, 3422, 3435, 3428, 3441, 3412, 3419, 3430,
  3450, 3462, 3440, 3455, 3470, 3448, 3465, 3480, 3458, 3472, 3490, 3475, 3468,
  3488, 3502, 3490, 3505, 3495, 3510, 3498, 3415, 3420, 3408, 3418, 3405, 3412,
  3412,
];

export const seedCandles: Candle[] = seedCloses.map((close, i) => {
  const open = i === 0 ? close - 10 : seedCloses[i - 1];
  const high = Math.max(open, close) + 6 + (i % 3) * 2;
  const low = Math.min(open, close) - 6 - (i % 4) * 2;
  return { time: i, open, high, low, close };
});

// Cross-venue arbitrage view: the same base asset priced by three AMM venues (eris-agent-simulator's
// uniswap/balancer/curve legs), diverging from the oracle fair price by ambient noise plus two
// deliberate stress windows so the view has real "opportunity" spikes to show, not just flat noise.
const ARB_THRESHOLD_BPS = 80; // matches venue-arb's ROUND_TRIP_COST (one venue fee in, one out, plus slippage)

type StressWindow = { start: number; end: number; peakOffset: number };

function ambientNoise(
  i: number,
  freq: number,
  amp: number,
  phase: number,
): number {
  return Math.sin(i * freq + phase) * amp;
}

// Triangular ramp-up/hold/down, same shape as the simulator's spike/crash overlay (ADR 0009).
function stressOffset(i: number, windows: StressWindow[]): number {
  for (const w of windows) {
    if (i < w.start || i > w.end) continue;
    const mid = (w.start + w.end) / 2;
    const half = (w.end - w.start) / 2 || 1;
    const ramp = 1 - Math.abs(i - mid) / half;
    return w.peakOffset * Math.max(ramp, 0);
  }
  return 0;
}

// Curve's oracle lags behind a sharp move -> it stays cheap while the market has already repriced.
const CURVE_LAG_WINDOW: StressWindow[] = [
  { start: 9, end: 15, peakOffset: -46 },
];
// Balancer gets bid up by uninformed flow -> it runs rich relative to fair.
const BALANCER_RICH_WINDOW: StressWindow[] = [
  { start: 26, end: 31, peakOffset: 40 },
];

export const seedArbitrage: ArbitrageSnapshot = (() => {
  const fair = seedCloses.map((price, i) => ({ time: i, price }));

  const venueDefs = [
    {
      id: "uniswap",
      label: "Uniswap v3",
      color: "#7c9eff",
      freq: 0.35,
      amp: 3.5,
      phase: 0,
      windows: [] as StressWindow[],
    },
    {
      id: "balancer",
      label: "Balancer",
      color: "#f5a623",
      freq: 0.22,
      amp: 6,
      phase: 1.4,
      windows: BALANCER_RICH_WINDOW,
    },
    {
      id: "curve",
      label: "Curve",
      color: "#4fd1a5",
      freq: 0.5,
      amp: 2.5,
      phase: 2.7,
      windows: CURVE_LAG_WINDOW,
    },
  ];

  const venues: VenueSeries[] = venueDefs.map((v) => ({
    id: v.id,
    label: v.label,
    color: v.color,
    points: fair.map((f, i) => ({
      time: f.time,
      price:
        Math.round(
          (f.price +
            ambientNoise(i, v.freq, v.amp, v.phase) +
            stressOffset(i, v.windows)) *
            100,
        ) / 100,
    })),
  }));

  const spread = fair.map((f, i) => {
    const prices = venues.map((v) => v.points[i].price);
    const spreadBps =
      ((Math.max(...prices) - Math.min(...prices)) / f.price) * 10_000;
    return { time: f.time, spreadBps: Math.round(spreadBps * 10) / 10 };
  });

  // Only the venue-arb window matters: gap over threshold, buy the cheap venue / sell the rich one —
  // same "most deviated and fundable" pick venue-arb's agent.ts makes.
  const trades: ArbTradeMarker[] = spread
    .filter((s) => s.spreadBps > ARB_THRESHOLD_BPS)
    .map((s) => {
      const priced = venues.map((v) => ({
        id: v.id,
        price: v.points[s.time].price,
      }));
      const cheapest = priced.reduce((a, b) => (b.price < a.price ? b : a));
      const richest = priced.reduce((a, b) => (b.price > a.price ? b : a));
      // Alternate which leg gets flagged so both the buy-in and sell-out show up on the mock chart.
      return s.time % 2 === 0
        ? { time: s.time, venue: cheapest.id, side: "buy" as const }
        : { time: s.time, venue: richest.id, side: "sell" as const };
    });

  return { fair, venues, spread, thresholdBps: ARB_THRESHOLD_BPS, trades };
})();

export const seedPositions: MarketPosition[] = [
  {
    agent: "agent-9a12",
    side: "long",
    size: "2.1x",
    entry: "3,388",
    pnlPercent: 2.4,
  },
  {
    agent: "agent-88b1",
    side: "short",
    size: "1.0x",
    entry: "3,440",
    pnlPercent: -0.8,
  },
  {
    agent: "agent-21cd",
    side: "long",
    size: "3.4x",
    entry: "3,395",
    pnlPercent: 1.5,
  },
  {
    agent: "agent-de33",
    side: "short",
    size: "0.8x",
    entry: "3,420",
    pnlPercent: -0.3,
  },
];

export const seedOrders: MarketOrder[] = [
  {
    agent: "agent-7788",
    side: "long",
    size: "1.5x",
    trigger: "3,380.0",
    status: "pending",
  },
  {
    agent: "agent-55aa",
    side: "short",
    size: "0.9x",
    trigger: "3,450.0",
    status: "pending",
  },
  {
    agent: "agent-3e91",
    side: "long",
    size: "2.0x",
    trigger: "3,375.0",
    status: "pending",
  },
  {
    agent: "agent-c204",
    side: "short",
    size: "1.1x",
    trigger: "3,460.0",
    status: "pending",
  },
];

export const seedTrades: MarketTrade[] = [
  { agent: "agent-9a12", side: "long", size: "0.4", price: "3,412.0" },
  { agent: "agent-88b1", side: "short", size: "1.1", price: "3,413.4" },
  { agent: "agent-21cd", side: "long", size: "2.0", price: "3,410.9" },
  { agent: "agent-de33", side: "short", size: "0.6", price: "3,414.0" },
  { agent: "agent-7788", side: "long", size: "0.9", price: "3,411.6" },
  { agent: "agent-55aa", side: "short", size: "1.5", price: "3,414.8" },
];

// AMM depth per venue (the order-book replacement, issue #63 Phase 4). Deterministic wobble so the
// sparklines have shape; the middle venue dips like a liquidityPull window.
export const seedVenueDepths: VenueDepthView[] = seedArbitrage.venues.map(
  (venue, v) => {
    const baseDepth = 5_800_000 + v * 120_000;
    const points = Array.from({ length: 40 }, (_, i) => {
      const wobble = Math.sin(i * 0.4 + v) * 40_000;
      const pull =
        v === 1 && i >= 18 && i <= 26
          ? -baseDepth * 0.4 * (1 - Math.abs(i - 22) / 4)
          : 0;
      return Math.round(baseDepth + wobble + pull);
    });
    const last = points[points.length - 1];
    return {
      id: venue.id,
      label: venue.label,
      color: venue.color,
      depthUsd: `$${last.toLocaleString("en-US")}`,
      deltaPercent: Math.round(((last - points[0]) / points[0]) * 1000) / 10,
      points,
      buy: "$3,415.6",
      sell: "$3,408.4",
    };
  },
);

export const seedFeed: MarketFeedItem[] = [
  { id: 1, text: "agent-9a12 buy 0.4 @3412.0" },
  { id: 2, text: "agent-88b1 sell 1.1 @3413.4" },
  { id: 3, text: "agent-21cd buy 2.0 @3410.9" },
  { id: 4, text: "agent-de33 sell 0.6 @3414.0" },
  { id: 5, text: "agent-7788 buy 0.9 @3411.6" },
  { id: 6, text: "agent-55aa sell 1.5 @3414.8" },
  { id: 7, text: "agent-3e91 buy 0.3 @3411.2" },
  { id: 8, text: "agent-c204 sell 0.7 @3413.9" },
];

export const seedArchiveRound: ArchiveRoundInfo = {
  roundNumber: 13,
  status: "archived",
  finalBlockNumber: 19_201_884,
};

export const seedArchiveStats: ArchiveStats = {
  totalTx: 48_112,
  agentsEntered: 31,
  totalVolume: "$18.4M",
  liquidations: 14,
};

export const seedArchivePodium: ArchivePodiumEntry[] = [
  { rank: 1, agent: "agent-9a12", netPnlUsdc: 6120 },
  { rank: 2, agent: "agent-21cd", netPnlUsdc: 4890 },
  { rank: 3, agent: "agent-7788", netPnlUsdc: 3340 },
];

export const seedArchiveFinalStandings: ArchiveFinalStanding[] = [
  { rank: 1, agent: "agent-9a12", score: 92.4, netPnlUsdc: 6120, sharpe: 2.41 },
  { rank: 2, agent: "agent-21cd", score: 88.1, netPnlUsdc: 4890, sharpe: 2.18 },
  { rank: 3, agent: "agent-7788", score: 81.6, netPnlUsdc: 3340, sharpe: 2.02 },
  { rank: 4, agent: "agent-4f2a", score: 74.9, netPnlUsdc: 1840, sharpe: 1.84 },
  { rank: 5, agent: "agent-55aa", score: 70.2, netPnlUsdc: 1500, sharpe: 1.61 },
  {
    rank: 6,
    agent: "agent-3e91",
    score: 65.8,
    netPnlUsdc: 970.25,
    sharpe: 1.42,
  },
  { rank: 7, agent: "agent-c204", score: 61.0, netPnlUsdc: 720.5, sharpe: 1.3 },
  {
    rank: 8,
    agent: "agent-88b1",
    score: 55.4,
    netPnlUsdc: -180.4,
    sharpe: 1.05,
  },
];

export const seedArchiveClosingPrices: ArchiveClosingPrice[] = [
  { pair: "ETH/USDC", price: 3296 },
  { pair: "wBTC/USDC", price: 59_880 },
  { pair: "SOL/USDC", price: 138 },
];

export const seedArchiveEvents: ArchiveEvent[] = [
  { time: "blk 19,190,204", text: "whale sell wBTC" },
  { time: "blk 19,193,881", text: "oracle lag +400ms" },
  { time: "blk 19,198,552", text: "stablecoin depeg −3%" },
  { time: "blk 19,201,110", text: "CEX drift injected on ETH/USDC" },
];

const AGENT_DETAIL_MARKETS = ["ETH/USDC", "wBTC/USDC", "SOL/USDC"];
const AGENT_DETAIL_TRADE_METHODS = [
  "openPosition",
  "swap",
  "closePosition",
  "addLiquidity",
  "flashLoan",
];
const AGENT_DETAIL_TRADE_TIMES = [
  "2s ago",
  "18s ago",
  "40s ago",
  "1m ago",
  "2m ago",
  "3m ago",
];

// Deterministic pseudo wallet/tx address so the same agent always shows the same string.
function shortHexAddress(seedText: string): string {
  let hash = 0;
  for (let i = 0; i < seedText.length; i++)
    hash = (hash * 31 + seedText.charCodeAt(i)) >>> 0;
  const hex = hash.toString(16).padStart(8, "0");
  return `0x${hex.slice(0, 4)}…${hex.slice(4, 8)}`;
}

/**
 * Builds full agent-detail mock data (portfolio history, positions, trades,
 * decision log) from a leaderboard row, so every agent has a consistent,
 * deterministic detail view without needing its own seed table.
 */
export function buildAgentDetail(standing: AgentStanding): AgentDetail {
  const seed = standing.rank;
  const trendUp = standing.netPnlUsdc >= 0;

  const portfolioPoints = Array.from({ length: 14 }, (_, i) => {
    const drift = (trendUp ? 1 : -1) * i * (1.5 + (seed % 3) * 0.6);
    const wobble = ((i * (seed + 3)) % 7) - 3;
    return Math.round(100 + drift + wobble);
  });

  const positions: AgentPosition[] = [
    {
      market: AGENT_DETAIL_MARKETS[(seed - 1) % AGENT_DETAIL_MARKETS.length],
      side: "long",
      size: `${(1.2 + (seed % 4) * 0.5).toFixed(1)}x`,
      entry: "3,388",
      pnlPercent: trendUp ? 2.4 : -1.6,
    },
    {
      market: AGENT_DETAIL_MARKETS[seed % AGENT_DETAIL_MARKETS.length],
      side: "short",
      size: `${(0.8 + (seed % 3) * 0.4).toFixed(1)}x`,
      entry: "61,900",
      pnlPercent: trendUp ? -1.1 : -3.2,
    },
  ];

  const trades: AgentTrade[] = Array.from({ length: 4 }, (_, i) => ({
    hash: shortHexAddress(`${standing.agent}-tx${i}`),
    block: (19_442_110 - i * (13 + seed)).toLocaleString("en-US"),
    method:
      AGENT_DETAIL_TRADE_METHODS[
        (seed + i) % AGENT_DETAIL_TRADE_METHODS.length
      ],
    amount:
      i % 2 === 0
        ? `${1 + ((seed + i) % 6)}.${(seed * 3 + i) % 10} ETH`
        : `${(1 + ((seed + i) % 8)) * 1200} USDC`,
    time: AGENT_DETAIL_TRADE_TIMES[i % AGENT_DETAIL_TRADE_TIMES.length],
  }));

  const recentLog: AgentLogLine[] = [
    {
      time: "12:04:02",
      text: `evaluated funding skew, opened ${positions[0].side.toUpperCase()} ${positions[0].market.split("/")[0]}`,
      tone: "success",
    },
    { time: "11:58:40", text: "checked oracle deviation, held", tone: "info" },
    {
      time: "11:44:12",
      text: `closed ${positions[1].market.split("/")[0]} ${positions[1].side}, ${trendUp ? "took profit" : "cut losses"}`,
      tone: trendUp ? "success" : "warning",
    },
  ];

  const fullLog: AgentLogLine[] = [
    ...recentLog,
    {
      time: "11:30:07",
      text: "route reverted: insufficient liquidity, retried",
      tone: "danger",
    },
    {
      time: "11:22:19",
      text: `detected price event on ${positions[0].market}, widened range`,
      tone: "warning",
    },
    { time: "11:10:03", text: "evaluated 3 candidate routes", tone: "info" },
  ];

  return {
    rank: standing.rank,
    agent: standing.agent,
    address: shortHexAddress(standing.agent),
    strategy: standing.strategy,
    score: standing.score,
    netPnlUsdc: standing.netPnlUsdc,
    sharpe: standing.sharpe,
    maxDrawdownPercent: standing.maxDrawdownPercent,
    portfolioPoints,
    positions,
    trades,
    recentLog,
    fullLog,
  };
}
