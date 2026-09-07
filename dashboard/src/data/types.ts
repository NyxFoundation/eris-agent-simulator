// ---------------------------------------------------------------------------
// rounds
//
// A "round" is an evaluation interval of the rules (§0.1), not a run: the leaderboard's running
// progress inside an epoch. The score is one number per run (rules §4.4.1: P = V_K − V_0,
// standardised over the field), so rounds explain a result without being what it is earned in.
// summary.json's valueSeries.epochSeries carries their boundaries and the per-agent value at each.

export interface RoundAgentResult {
  agent: string;
  /** Rank within this round alone, by the round's log return. */
  rank: number;
  /** Account-value change across the round, USDC. */
  deltaUsdc: number;
  /** The round's log return of account value, in bps. Context only: the score is one number per
   * epoch (rules §4.4.1), not a function of the rounds. */
  logReturnBps: number;
  /** Rank by cumulative gain since the run's first boundary, at this round's close. */
  cumulativeRank: number;
  /** Cumulative-rank change against the previous round's close. Positive = climbed. */
  move: number;
  /** Asset value at or below zero at this round's close (rules §4.5: bankrupt; no floor, no freeze). */
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
  /** T(a, s) for this epoch (rules §4.4.1): 50 + 10 (P − μ) / σ over the field. Null for the
   * benchmark, which is valued but not in the population, and while the field has no spread. */
  score: number | null;
  /** summary.json's netPnlUsdc, in USDC rather than as a share of starting value. The share is not
   * a useful figure here: the gas endowment (100 ETH by default, ~78% of an agent's mark) sits in
   * the denominator, so every real trading result rounds to 0.0% however many decimals it is given.
   * Null for an agent this run did not place (no V_0 -- registered mid-way), which has no PnL here
   * rather than a PnL of zero. */
  netPnlUsdc: number | null;
  /** True when the agent is in the record but not in this epoch's population (rules §4.4.2). */
  unscored: boolean;
  strategy: string;
  strategyCategory: StrategyCategory;
  maxDrawdownPercent: number;
  /** Rank change over the run's final round, on cumulative value gain. Positive = climbed. */
  move: number;
}

export type TapeTone = "up" | "down" | "accent" | "purple" | "neutral";

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
  /** Every transaction in scope, newest first. The page pages them; a search runs over all. */
  transactions: ExplorerTransaction[];
  /**
   * Live: the lowest block the transaction list covers, or null when it covers none. A search that
   * finds nothing in a list that starts at block 1,400 has not shown the transaction is absent.
   */
  txCoveredFrom: number | null;
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
  /**
   * How many registered participants run their agent themselves (ADR 0021 §2). The feed above is
   * built from the agents' own mempool self-reports, which those participants file on their own
   * machines — so when this is non-zero the feed is a subset, and the panel says so rather than
   * letting a short list read as a quiet market (§4 / axis C2).
   */
  feedSelfHosted: number;
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
  /** Rank within the selected scenario (this epoch's field). The competition rank is the standings'. */
  rank: number;
  /** How many agents the scenario placed, so the rank reads as "N of M". */
  fieldSize: number;
  agent: string;
  address: string;
  /** Full wallet address for explorer deep links (absent in seed data). */
  fullAddress?: string;
  strategy: string;
  /** T(a, s) for this epoch; see AgentStanding.score. */
  score: number | null;
  /** Null when this epoch did not place the agent; see AgentStanding.netPnlUsdc. */
  netPnlUsdc: number | null;
  unscored: boolean;
  maxDrawdownPercent: number;
  /** Account value at each scored block — the same cross-sections the score is computed from.
   * Carries the block so the chart can label its x axis with what it actually is. */
  portfolioSeries: SeriesPoint[];
  positions: AgentPosition[];
  trades: AgentTrade[];
  recentLog: AgentLogLine[];
  fullLog: AgentLogLine[];
  rounds: AgentRoundResult[];
  /**
   * ADR 0021 §2/§4: the participant runs this agent themselves, so its decision log and its
   * mempool self-reports live on their machine. The panels fed by those are not shown — an empty
   * one would read as "this agent thought nothing", which is a different claim.
   */
  external?: boolean;
}

export interface AgentDetailSnapshot {
  round: RoundInfo;
  agent: AgentDetail;
}

// ---------------------------------------------------------------------------
// world (the competition map)
//
// The same three columns the conference demo is staged in — the agents on the left, the one thing
// they all have to go through in the middle, the contracts holding state on the right — but read
// off the run's own artifacts rather than scripted. A frame is a position on the block axis: which
// transactions were in that block, which of them reverted, and what each venue's number was there.
// The page walks the frames; nothing in here knows about playback.

export interface WorldAgentNode {
  id: string;
  /** Wallet address, short. Empty for a sender with none recorded. */
  address: string;
  strategyCategory: StrategyCategory;
  /** The benchmark (rules §4.3): valued, shown, never in the population. */
  baseline: boolean;
  /** ADR 0021 §2: the participant runs this agent themselves, so its self-reports never arrive. */
  external: boolean;
}

export interface WorldVenueNode {
  id: string;
  label: string;
  kind: "pool" | "perp" | "lending" | "stake" | "cdp";
  color: string;
  /** What the one number under the name measures ("pool price", "utilisation"). */
  metric: string;
}

export interface WorldTx {
  hash: string;
  /** Agent id, or a short address for a sender the roster does not know (role "external"). */
  agent: string;
  /**
   * Whether a competitor sent this, or the world did. The environment's own traffic — the oracle's
   * price writes, the background order flow — is most of every block and is not a decision anybody
   * is scored on, so the board has to be able to tell them apart.
   */
  kind: "agent" | "environment";
  method: string;
  /** The venue node this transaction reached; null when nothing on it names one. */
  venue: string | null;
  /** Priority fee, gwei, as the block recorded it. */
  fee: string;
  /** Mined and succeeded. A reverted transaction is still in the block — it paid and did nothing. */
  ok: boolean;
}

export interface WorldFrame {
  /** The block this frame is at; `fromBlock` differs only when frames were grouped to fit the cap. */
  block: number;
  fromBlock: number;
  /** Chain time from the run's first block ("t+42s"). */
  clock: string;
  /** 1-based round this frame falls in; 0 when the run recorded no epoch series. */
  round: number;
  /** Every transaction in the frame, counted. */
  txCount: number;
  /** Distinct competing agents that sent in the frame. The environment's own senders are not
   * counted: they are the world, not the field. */
  senderCount: number;
  /** The transactions the board animates and the chain panel lists — a sample once a frame carries
   * more than the dot pool can fly, which is why the counts above are separate from its length. */
  txs: WorldTx[];
  reverts: number;
  /** venue id -> the number that node shows here, already formatted. */
  venueValues: Record<string, string>;
  /** Fair price at this frame, formatted; null where the run has no observation for it. */
  fair: string | null;
  /** The same two, unformatted, for the charts — which need a scale, not a label. Only the venues
   * quoted in a price are here; a node whose number is a utilisation or a discount is not a line. */
  priceUsd: Record<string, number>;
  fairUsd: number | null;
  /** What the environment did at this frame — the tape's events, placed on the block axis. */
  events: { kind: string; text: string; tone: TapeTone }[];
}

/**
 * An epoch boundary's scored cross-section: what every agent was worth at that block.
 *
 * This is the only account value a run records — nothing is marked between boundaries, and the
 * board says so by holding the last one rather than drawing a line through the gap.
 */
export interface WorldBoundary {
  block: number;
  /** agent id -> account value in USDC at this boundary. */
  valueUsdc: Record<string, number>;
  /** agent id -> gain since the run's first boundary. */
  pnlUsdc: Record<string, number>;
}

/** One line an agent wrote, placed on the block axis so the panel can follow the head. */
export interface WorldLogLine {
  /** The block the agent was deciding about. */
  block: number;
  /** What it did: an action type, or the mempool event when the transaction itself is the story. */
  event: string;
  /** Why, in the agent's own words — the `reason` it logged, or the revert it got back. */
  text: string;
  tone: LogTone;
}

export interface WorldSnapshot {
  round: RoundInfo;
  /**
   * The ranking within this scenario after each closed round: index k is the field through k
   * closed rounds (k = 0 is the start, where nobody has a score yet), T(a, s) over this epoch's
   * field (rules §4.4.1) read through those rounds exactly as replay reads it. The page shows the
   * entry for the rounds closed by the walk's block, never the finished run's beside a walk.
   */
  standingsThroughRound: AgentStanding[][];
  /** The block window the frames cover: one round, or the whole run. */
  scope: BlockScope;
  agents: WorldAgentNode[];
  venues: WorldVenueNode[];
  frames: WorldFrame[];
  boundaries: WorldBoundary[];
  /**
   * agent id -> what it wrote, in block order. Absent for an agent that wrote nothing, and empty
   * for every agent in the public view, where decision logs are a participant's own and the server
   * does not serve them (ADR 0021 §4).
   */
  agentLog: Record<string, WorldLogLine[]>;
  /** True when the logs were withheld rather than absent, so the panel can say which. */
  logsWithheld: boolean;
  /** Blocks per frame. 1 unless the window was longer than the frame cap. */
  blocksPerFrame: number;
}
