export interface RoundInfo {
  roundNumber: number;
  status: "live" | "archived";
  startsAt: number;
  endsAt: number;
  blockNumber: number;
}

export type StrategyCategory = "arb" | "mm" | "dir";

export interface AgentStanding {
  rank: number;
  agent: string;
  score: number;
  pnlPercent: number;
  sharpe: number;
  strategy: string;
  strategyCategory: StrategyCategory;
  maxDrawdownPercent: number;
  /** Rank change since the previous round; 0 = unchanged. */
  move: number;
}

export interface RoundProgressSegment {
  n: string;
  status: "done" | "live" | "upcoming";
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
}

export interface ExplorerStats {
  latestBlockNumber: string;
  txCountThisRound: number;
  activeAgents: number;
  avgBlockTimeSeconds: number;
  /** Blockscout's indexed height in live mode, when it differs from the RPC height (skew display). */
  indexerBlockNumber?: string;
}

export interface ExplorerSnapshot {
  round: RoundInfo;
  stats: ExplorerStats;
  blocks: ExplorerBlock[];
  transactions: ExplorerTransaction[];
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketStats {
  pair: string;
  price: number;
  direction: "up" | "down";
  volume24h: string;
  openInterest: string;
  openInterestLongPercent: number;
  openInterestShortPercent: number;
  availableLiquidity: string;
  totalLiquidity: string;
  fundingRate1h: string;
}

export type PositionSide = "long" | "short";

export interface MarketPosition {
  agent: string;
  side: PositionSide;
  size: string;
  entry: string;
  pnlPercent: number;
}

export interface MarketOrder {
  agent: string;
  side: PositionSide;
  size: string;
  trigger: string;
  status: string;
}

export interface MarketTrade {
  agent: string;
  side: PositionSide;
  size: string;
  price: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
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

export interface MarketSnapshot {
  round: RoundInfo;
  stats: MarketStats;
  candles: Candle[];
  leaderboard: AgentStanding[];
  positions: MarketPosition[];
  orders: MarketOrder[];
  trades: MarketTrade[];
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  feed: MarketFeedItem[];
  arbitrage: ArbitrageSnapshot;
}

export interface ArchiveRoundInfo {
  roundNumber: number;
  status: "archived";
  finalBlockNumber: number;
}

export interface ArchivePodiumEntry {
  rank: number;
  agent: string;
  pnlPercent: number;
}

export interface ArchiveFinalStanding {
  rank: number;
  agent: string;
  score: number;
  pnlPercent: number;
  sharpe: number;
}

export interface ArchiveStats {
  totalTx: number;
  agentsEntered: number;
  totalVolume: string;
  liquidations: number;
}

export interface ArchiveClosingPrice {
  pair: string;
  price: number;
}

export interface ArchiveEvent {
  time: string;
  text: string;
}

export interface ArchiveSnapshot {
  round: ArchiveRoundInfo;
  stats: ArchiveStats;
  podium: ArchivePodiumEntry[];
  finalStandings: ArchiveFinalStanding[];
  closingPrices: ArchiveClosingPrice[];
  events: ArchiveEvent[];
}

export interface AgentPosition {
  market: string;
  side: PositionSide;
  size: string;
  entry: string;
  pnlPercent: number;
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

export interface AgentDetail {
  rank: number;
  agent: string;
  address: string;
  /** Full wallet address for explorer deep links (absent in seed data). */
  fullAddress?: string;
  strategy: string;
  score: number;
  pnlPercent: number;
  sharpe: number;
  maxDrawdownPercent: number;
  portfolioPoints: number[];
  positions: AgentPosition[];
  trades: AgentTrade[];
  recentLog: AgentLogLine[];
  fullLog: AgentLogLine[];
}

export interface AgentDetailSnapshot {
  round: RoundInfo;
  agent: AgentDetail;
}
