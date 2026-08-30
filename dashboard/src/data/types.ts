// ---------------------------------------------------------------------------
// rounds
//
// A "round" is a scoring epoch (ADR 0019), not a run: the score is mean − λ·std of *per-epoch* log
// returns, so the epoch is the unit a result is actually earned in. A run is a sequence of rounds;
// summary.json's valueSeries.epochSeries carries their boundaries and the per-agent value at each
// one, and epochScores[agent].logReturns carries the return the score is built from.

export interface RoundAgentResult {
  agent: string;
  /** Rank within this round alone, by the round's log return. */
  rank: number;
  /** Account-value change across the round, USDC. */
  deltaUsdc: number;
  /** The round's log return in bps — the quantity the score averages. */
  logReturnBps: number;
  /** Rank by cumulative gain since the run's first boundary, at this round's close. */
  cumulativeRank: number;
  /** Cumulative-rank change against the previous round's close. Positive = climbed. */
  move: number;
  /** True once the scorer froze this agent's series (G1/G2 bankruptcy floor). */
  bankrupt: boolean;
}

export interface RoundEpoch {
  /** 1-based position in the run. */
  index: number;
  fromBlock: number;
  toBlock: number;
  status: "done" | "live" | "upcoming";
  /** Empty for a round that has not been scored yet (live run, or a run with no epoch series). */
  results: RoundAgentResult[];
  /** Notable events that landed inside this round's block range. */
  events: { time: string; text: string }[];
  /** Transactions recorded in this round's block range. null = not counted rather than zero: a live
   * view holds only a recent window of the chain, and a round older than that window has no count
   * to report. A round that has not started yet is a real 0. */
  txCount: number | null;
}

/** Replay transport state, present on the round only while this run is being replayed. */
export interface ReplayInfo {
  block: number;
  fromBlock: number;
  toBlock: number;
  playing: boolean;
  speed: number;
}

export interface RoundInfo {
  /** The run directory's id — what replay is armed against. */
  runId: string;
  /** 1-based position of the run among runs/, oldest = 1. Labelled "Run" in the UI. */
  /** "replay" is an archived run walked forward: the views show it as of `replay.block`. */
  status: "live" | "archived" | "replay";
  startsAt: number;
  endsAt: number;
  blockNumber: number;
  /** The run's rounds. Empty when the run recorded no epoch series (run.epochBlocks: 0). */
  epochs: RoundEpoch[];
  /** Epoch length in blocks, as the run was configured. 0 = no epoch series. */
  epochBlocks: number;
  /** Set only while this run is being replayed. */
  replay?: ReplayInfo;
}

export type StrategyCategory = "arb" | "mm" | "dir";

export interface AgentStanding {
  rank: number;
  agent: string;
  score: number;
  /** summary.json's netPnlUsdc, in USDC rather than as a share of starting value. The share is not
   * a useful figure here: the gas endowment (100 ETH by default, ~78% of an agent's mark) sits in
   * the denominator, so every real trading result rounds to 0.0% however many decimals it is given. */
  netPnlUsdc: number;
  sharpe: number;
  strategy: string;
  strategyCategory: StrategyCategory;
  maxDrawdownPercent: number;
  /** Rank change over the run's final round, on cumulative value gain. Positive = climbed. */
  move: number;
}

export interface MarketTicker {
  symbol: string;
  price: string;
  delta: string;
  direction: "up" | "down";
  points: number[];
}

export type TapeTone = "up" | "down" | "accent" | "purple" | "neutral";

export interface TapeEvent {
  id: number;
  time: string;
  kind: string;
  body: string;
  value: string;
  tone: TapeTone;
}

export interface TopPageSnapshot {
  round: RoundInfo;
  leaderboard: AgentStanding[];
  marketTickers: MarketTicker[];
  blocks: ExplorerBlock[];
  tape: TapeEvent[];
}

export interface ExplorerBlock {
  number: string;
  time: string;
  txCount: number;
  /** Raw block number for explorer deep links (absent in seed data). */
  blockNumber?: number;
}

export type TxMethodTone = "default" | "danger";

export interface ExplorerTransaction {
  seq: number;
  hash: string;
  agent: string;
  method: string;
  amount: string;
  time: string;
  methodTone: TxMethodTone;
  /** Full tx hash for explorer deep links (absent in seed data). */
  fullHash?: string;
  /** Sender address, for the address deep link (absent in seed data). */
  fullAddress?: string;
  blockNumber?: number;
}

export interface ExplorerStats {
  latestBlockNumber: string;
  /** null = not counted rather than zero — a live view holds only a recent window of the chain, so
   * a round older than that window has no count to report. */
  txCountThisRound: number | null;
  activeAgents: number;
  avgBlockTimeSeconds: number;
  /** Blockscout's indexed height in live mode, when it differs from the RPC height (skew display). */
  indexerBlockNumber?: string;
}

/** The block window a view is showing: the whole run, or one round of it. */
export interface BlockScope {
  /** null = the whole run. */
  roundIndex: number | null;
  fromBlock: number;
  toBlock: number;
}

export interface ExplorerSnapshot {
  round: RoundInfo;
  scope: BlockScope;
  stats: ExplorerStats;
  blocks: ExplorerBlock[];
  transactions: ExplorerTransaction[];
  /** Every agent in the run, so a name search can resolve to a wallet address. */
  agents: { id: string; address?: string }[];
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** One AMM venue's depth, replacing the fictional order book (issue #63 Phase 4): every venue is
 * an AMM, so what exists is pool depth and an executable two-sided quote, not resting orders. */
export interface VenueDepthView {
  id: string;
  label: string;
  color: string;
  /** Current pool depth in USD, formatted. */
  depthUsd: string;
  /** Depth change over the run, percent (liquidityPull makes this move). */
  deltaPercent: number;
  /** Depth series over the run, for the sparkline. */
  points: number[];
  /** Current executable quotes at probe size, formatted. */
  buy?: string;
  sell?: string;
}

export interface MarketFeedItem {
  id: number;
  text: string;
}

export interface VenuePricePoint {
  time: number;
  price: number;
}

export interface VenueSeries {
  id: string;
  label: string;
  color: string;
  points: VenuePricePoint[];
}

export interface ArbSpreadPoint {
  time: number;
  spreadBps: number;
}

export type ArbTradeSide = "buy" | "sell";

export interface ArbTradeMarker {
  time: number;
  venue: string;
  side: ArbTradeSide;
}

/** Cross-venue price divergence for one market: same base asset, priced by several venues. */
export interface ArbitrageSnapshot {
  fair: VenuePricePoint[];
  venues: VenueSeries[];
  spread: ArbSpreadPoint[];
  /** Round-trip cost (bps) below which a spread does not pay to close — matches venue-arb's ROUND_TRIP_COST. */
  thresholdBps: number;
  trades: ArbTradeMarker[];
}

// ---------------------------------------------------------------------------
// venue state (the /markets page)
//
// The page's subject is what each deployed application is doing, not one price line: an AMM's depth
// and cross-venue spread, a perp's open interest and funding, a lender's utilization and health
// factors, a CDP's peg and collateral ratio, an LST's redemption rate against its market price.
// The provider does the artifact-specific work and hands the page this shape.

export type StatTone = "up" | "down" | "neutral" | "warn";

export interface VenueStat {
  label: string;
  value: string;
  tone?: StatTone;
  /** Second line: a delta, the start-of-run reference, or why the number is missing. */
  sub?: string;
}

export interface SeriesPoint {
  time: number;
  value: number;
}

export interface SeriesLine {
  id: string;
  label: string;
  color: string;
  points: SeriesPoint[];
  /** Dashed = a reference (fair, par), not a measurement. */
  dashed?: boolean;
}

export type ChartUnit = "usd" | "bps" | "ratio" | "percent" | "count" | "eth";

export interface VenueChart {
  id: string;
  title: string;
  unit: ChartUnit;
  /** Draw the block-number axis. Off by default: most panels stack charts that share one window. */
  showBlockAxis?: boolean;
  /** What the axes measure, spelled out — a series over blocks is not self-evidently either. */
  xLabel?: string;
  yLabel?: string;
  lines: SeriesLine[];
  /** Dotted horizontal reference (par, a liquidation threshold). */
  reference?: { value: number; label: string };
  height?: number;
}

export interface VenueTableCell {
  text: string;
  tone?: StatTone | "link";
}

export interface VenueTable {
  id: string;
  title: string;
  /** `width` is a grid track (e.g. "110px", "1.6fr"). Without it every column gets an equal share,
   * which collides once a table has more than four or five of them. */
  columns: { label: string; align?: "left" | "right"; width?: string }[];
  rows: VenueTableCell[][];
  empty: string;
}

/** "scenario" is not a venue: it is what the environment did to all of them, and it leads the page
 * because it is the frame the rest is read in. */
export type VenuePanelId =
  | "scenario"
  | "amm"
  | "perp"
  | "lending"
  | "stable"
  | "lst";

export interface VenuePanel {
  id: VenuePanelId;
  label: string;
  /** True for a panel that always describes the whole run, whatever round is selected. */
  runWide?: boolean;
  /** The protocols this panel covers, as the run enabled them. */
  protocols: string[];
  /** What this venue's state means for the competition. */
  caption: string;
  stats: VenueStat[];
  charts: VenueChart[];
  tables: VenueTable[];
  /** Set when the protocol ran but its series is missing (a run older than the artifact, or a
   * failed read) — never a silent empty panel. */
  note?: string;
}

export interface MarketSnapshot {
  round: RoundInfo;
  /** The block window every series, stat and table on the page covers. */
  scope: BlockScope;
  /** enabledProtocols, as the coordinator recorded them at run start. */
  protocols: string[];
  /** Markets the run actually trades (drives the base selector). */
  pairs: { label: string; value: string }[];
  base: string;
  fairPrice: number;
  fairDirection: "up" | "down";
  candles: Candle[];
  arbitrage: ArbitrageSnapshot;
  /** AMM depth per venue, for the AMM panel's sparkline cards. */
  venueDepths: VenueDepthView[];
  panels: VenuePanel[];
  leaderboard: AgentStanding[];
  feed: MarketFeedItem[];
}

export type PositionSide = "long" | "short";

/** One position an agent still held when the run ended.
 *
 * Deliberately not perp-shaped. The table used to have long/short/entry/PnL columns and was fed
 * only by GMX, so an agent whose whole run was staking or borrowing showed an empty table — which
 * reads as "the view is broken", not as "this agent held nothing". A position here is whatever the
 * venue's own end-of-run read says it is, marked against whatever that venue marks against. */
export interface AgentPosition {
  /** Venue and instrument: "GMX WETH/USDC", "LST vault", "Liquity Trove", "Aave account". */
  market: string;
  /** What kind of exposure it is: LONG / SHORT / STAKE / DEBT / DEPOSIT / SUPPLY. */
  kind: string;
  tone: "up" | "down" | "neutral";
  /** Size in the unit the venue measures it in. */
  size: string;
  /** What the position is marked against: an entry price, a redemption rate, an ICR, an HF. */
  mark: string;
  /** The part of the position that is a decision rather than a number — a queue, a liquidation line. */
  note?: string;
  /** Only where the concept applies (a perp). */
  pnlPercent?: number;
}

export interface AgentTrade {
  hash: string;
  block: string;
  method: string;
  amount: string;
  time: string;
  /** Full tx hash / raw block number for explorer deep links (absent in seed data). */
  fullHash?: string;
  blockNumber?: number;
}

export type LogTone = "info" | "success" | "danger" | "warning";

export interface AgentLogLine {
  time: string;
  text: string;
  tone: LogTone;
}

/** One agent's result in one round, for the agent page's per-round breakdown. */
export interface AgentRoundResult {
  index: number;
  fromBlock: number;
  toBlock: number;
  deltaUsdc: number;
  logReturnBps: number;
  rank: number;
  cumulativeRank: number;
  move: number;
  txCount: number;
}

export interface AgentDetail {
  rank: number;
  agent: string;
  address: string;
  /** Full wallet address for explorer deep links (absent in seed data). */
  fullAddress?: string;
  strategy: string;
  score: number;
  netPnlUsdc: number;
  sharpe: number;
  maxDrawdownPercent: number;
  /** Account value at each scored block — the same cross-sections the score is computed from.
   * Carries the block so the chart can label its x axis with what it actually is. */
  portfolioSeries: SeriesPoint[];
  positions: AgentPosition[];
  trades: AgentTrade[];
  recentLog: AgentLogLine[];
  fullLog: AgentLogLine[];
  rounds: AgentRoundResult[];
}

export interface AgentDetailSnapshot {
  round: RoundInfo;
  agent: AgentDetail;
}
