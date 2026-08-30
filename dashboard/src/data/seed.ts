import type {
  AgentDetail,
  AgentLogLine,
  AgentPosition,
  AgentStanding,
  AgentTrade,
  ArbitrageSnapshot,
  ArbTradeMarker,
  Candle,
  ExplorerBlock,
  ExplorerStats,
  ExplorerTransaction,
  AgentRoundResult,
  MarketFeedItem,
  MarketTicker,
  RoundAgentResult,
  RoundEpoch,
  RoundInfo,
  TapeEvent,
  VenuePanel,
  VenueDepthView,
  VenueSeries,
} from "./types";

export const ROUND_DURATION_MS = 2 * 3600 * 1000 + 14 * 60 * 1000 + 36 * 1000;

// Eight rounds of twelve blocks — the shape a default sim:realtime run produces (run.epochBlocks
// defaults to 12). Six are scored, one is running, one has not started.
const SEED_EPOCH_BLOCKS = 12;
const SEED_EPOCHS = 8;
const SEED_FIRST_BLOCK = 19_442_026;

function seedRoundResults(index: number): RoundAgentResult[] {
  return seedAgents
    .map((agent, i) => {
      const swing = Math.sin(index * 1.3 + i) * (40 + i * 9);
      return {
        agent: agent.agent,
        rank: 0,
        deltaUsdc: Math.round(swing * 10) / 10,
        logReturnBps: Math.round(swing * 0.4 * 100) / 100,
        cumulativeRank: agent.rank,
        move: index === 1 ? 0 : ((index + i) % 3) - 1,
        bankrupt: false,
      };
    })
    .sort((a, b) => b.logReturnBps - a.logReturnBps)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

function seedEpochs(): RoundEpoch[] {
  return Array.from({ length: SEED_EPOCHS }, (_, i) => {
    const fromBlock = SEED_FIRST_BLOCK + i * SEED_EPOCH_BLOCKS;
    const status = i < 6 ? "done" : i === 6 ? "live" : "upcoming";
    return {
      index: i + 1,
      fromBlock,
      toBlock: fromBlock + SEED_EPOCH_BLOCKS,
      status: status as RoundEpoch["status"],
      results: status === "done" ? seedRoundResults(i + 1) : [],
      events: [],
      txCount: 40 + ((i * 7) % 23),
    };
  });
}

export function createSeedRound(): RoundInfo {
  const endsAt = Date.now() + 42 * 60 * 1000 + 18 * 1000;
  return {
    runId: "seed-run",
    runNumber: 14,
    status: "live",
    startsAt: endsAt - ROUND_DURATION_MS,
    endsAt,
    blockNumber: SEED_FIRST_BLOCK + 6 * SEED_EPOCH_BLOCKS + 5,
    epochs: seedEpochs(),
    epochBlocks: SEED_EPOCH_BLOCKS,
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

// Venue-state panels for the seed provider (the /markets page's shape). The real provider builds
// these from a run's market.json and event stream; here they are just enough to develop against.
export const seedVenuePanels: VenuePanel[] = [
  {
    id: "amm",
    label: "AMM",
    protocols: ["uniswap", "balancer", "curve"],
    caption:
      "Three constant-function venues quote the same pair. Depth is what a liquidity pull moves; the gap between venues is what an arbitrageur is paid to close, once it clears the round-trip cost.",
    stats: [
      { label: "Widest cross-venue gap", value: "134.0bps", tone: "up", sub: "threshold 80bps round-trip" },
      { label: "Pool depth (all venues)", value: "$17.6M", sub: "start $17.4M" },
      { label: "Swap volume · WETH", value: "$3.3M", sub: "412 swaps" },
    ],
    charts: [
      {
        id: "amm-depth",
        title: "Pool depth · WETH",
        unit: "usd",
        lines: seedVenueDepths.map((venue) => ({
          id: venue.id,
          label: venue.label,
          color: venue.color,
          points: venue.points.map((value, i) => ({ time: i, value })),
        })),
      },
    ],
    tables: [
      {
        id: "amm-quotes",
        title: "Executable quotes at the final block · WETH",
        columns: [
          { label: "Venue" },
          { label: "Mid", align: "right" },
          { label: "Sell", align: "right" },
          { label: "Buy", align: "right" },
          { label: "Depth", align: "right" },
        ],
        rows: seedVenueDepths.map((venue) => [
          { text: venue.label, tone: "link" as const },
          { text: "$3,412.00" },
          { text: venue.sell ?? "—", tone: "down" as const },
          { text: venue.buy ?? "—", tone: "up" as const },
          { text: venue.depthUsd },
        ]),
        empty: "no venue quotes in this run's market series",
      },
    ],
  },
  {
    id: "perp",
    label: "Perp",
    protocols: ["gmx"],
    caption:
      "GMX v2. Positions are opened as orders and executed by the environment's keeper a block later, so a perp trade always lands one block after the decision that produced it. Funding is what the crowded side pays the other.",
    stats: [
      { label: "Open interest", value: "$4.2M", sub: "52% long / 48% short" },
      { label: "Funding / 1h", value: "0.080bps", sub: "positive = longs pay shorts" },
    ],
    charts: [],
    tables: [
      {
        id: "gmx-positions",
        title: "Positions open at the final block",
        columns: [
          { label: "Agent" },
          { label: "Side" },
          { label: "Size", align: "right" },
          { label: "Entry", align: "right" },
        ],
        rows: [
          [
            { text: "agent-9a12", tone: "link" as const },
            { text: "LONG", tone: "up" as const },
            { text: "$120,400" },
            { text: "3,388" },
          ],
          [
            { text: "agent-88b1", tone: "link" as const },
            { text: "SHORT", tone: "down" as const },
            { text: "$61,900" },
            { text: "3,440" },
          ],
        ],
        empty: "no perp position was open when the run ended",
      },
    ],
  },
];

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

  const portfolioSeries = Array.from({ length: 14 }, (_, i) => {
    const drift = (trendUp ? 1 : -1) * i * (1.5 + (seed % 3) * 0.6);
    const wobble = ((i * (seed + 3)) % 7) - 3;
    return {
      time: SEED_FIRST_BLOCK + i * 6,
      value: Math.round((100 + drift + wobble) * 3800),
    };
  });

  const positions: AgentPosition[] = [
    {
      market: `GMX ${AGENT_DETAIL_MARKETS[(seed - 1) % AGENT_DETAIL_MARKETS.length]}`,
      kind: "LONG",
      tone: "up",
      size: `$${((1.2 + (seed % 4) * 0.5) * 100_000).toLocaleString("en-US")}`,
      mark: "entry 3,388",
      note: "collateral $40,000",
      pnlPercent: trendUp ? 2.4 : -1.6,
    },
    {
      market: "LST vault",
      kind: "STAKE",
      tone: "neutral",
      size: `${(8 + (seed % 3) * 1.5).toFixed(4)} LST`,
      mark: "par 1.0041 WETH",
      note: "nothing queued for withdrawal",
    },
  ];

  const rounds: AgentRoundResult[] = seedEpochs()
    .filter((e) => e.results.length > 0)
    .map((e) => {
      const result = e.results.find((r) => r.agent === standing.agent);
      return {
        index: e.index,
        fromBlock: e.fromBlock,
        toBlock: e.toBlock,
        deltaUsdc: result?.deltaUsdc ?? 0,
        logReturnBps: result?.logReturnBps ?? 0,
        rank: result?.rank ?? standing.rank,
        cumulativeRank: result?.cumulativeRank ?? standing.rank,
        move: result?.move ?? 0,
        txCount: e.txCount ?? 0,
      };
    });

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
      text: `evaluated funding skew, opened ${positions[0].kind} ${positions[0].market}`,
      tone: "success",
    },
    { time: "11:58:40", text: "checked oracle deviation, held", tone: "info" },
    {
      time: "11:44:12",
      text: `closed ${positions[1].market}, ${trendUp ? "took profit" : "cut losses"}`,
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
    portfolioSeries,
    positions,
    trades,
    recentLog,
    fullLog,
    rounds,
  };
}
