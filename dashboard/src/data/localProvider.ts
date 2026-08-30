import { countValues, getAll, getValue, putValue, STORES } from "./db";
import {
  buildAgentDetail,
  createSeedRound,
  seedAgents,
  seedArbitrage,
  seedVenueDepths,
  seedBlocks,
  seedCandles,
  seedExplorerStats,
  seedFeed,
  seedMarketTickers,
  seedTape,
  seedTransactions,
  seedVenuePanels,
} from "./seed";
import type {
  AgentDetailSnapshot,
  AgentStanding,
  ExplorerBlock,
  ExplorerSnapshot,
  ExplorerStats,
  ExplorerTransaction,
  MarketSnapshot,
  MarketTicker,
  RoundInfo,
  TapeEvent,
  TopPageSnapshot,
} from "./types";

const ROUND_KEY = "current";
const EXPLORER_STATS_KEY = "current";
const MARKET_SNAPSHOT_KEY = "current";
const TOP_EXTRAS_KEY = "current";

interface TopExtras {
  marketTickers: MarketTicker[];
  tape: TapeEvent[];
}

async function ensureSeeded(): Promise<void> {
  const [existingRound, agentCount, existingExtras] = await Promise.all([
    getValue<RoundInfo>(STORES.round, ROUND_KEY),
    countValues(STORES.agents),
    getValue<TopExtras>(STORES.topExtras, TOP_EXTRAS_KEY),
  ]);

  const tasks: Promise<void>[] = [];
  if (!existingRound)
    tasks.push(putValue(STORES.round, createSeedRound(), ROUND_KEY));
  if (!agentCount)
    tasks.push(...seedAgents.map((a) => putValue(STORES.agents, a)));
  if (!existingExtras) {
    const extras: TopExtras = {
      marketTickers: seedMarketTickers,
      tape: seedTape,
    };
    tasks.push(putValue(STORES.topExtras, extras, TOP_EXTRAS_KEY));
  }
  await Promise.all(tasks);
}

/**
 * Mock data provider backed by IndexedDB. Seeds once on first run so the
 * round countdown, leaderboard, market tickers, and event tape persist
 * across reloads. Reuses the explorer's block store for the "See what's
 * happening" preview so the top page and explorer never disagree.
 */
export async function fetchTopPageSnapshot(): Promise<TopPageSnapshot> {
  await Promise.all([ensureSeeded(), ensureExplorerSeeded()]);
  const [round, agents, extras, blocks] = await Promise.all([
    getValue<RoundInfo>(STORES.round, ROUND_KEY),
    getAll<AgentStanding>(STORES.agents),
    getValue<TopExtras>(STORES.topExtras, TOP_EXTRAS_KEY),
    getAll<ExplorerBlock>(STORES.blocks),
  ]);

  if (!round || !extras) {
    throw new Error("Round data missing after seeding");
  }

  return {
    round,
    leaderboard: agents.sort((a, b) => a.rank - b.rank),
    marketTickers: extras.marketTickers,
    blocks: blocks.sort((a, b) => b.number.localeCompare(a.number)).slice(0, 7),
    tape: extras.tape,
  };
}

/**
 * Mock data provider backed by IndexedDB. Reuses the shared agents store so
 * the detail view always matches the current leaderboard standing.
 */
export async function fetchAgentDetailSnapshot(
  agentId: string,
): Promise<AgentDetailSnapshot> {
  await ensureSeeded();
  const [round, agents] = await Promise.all([
    getValue<RoundInfo>(STORES.round, ROUND_KEY),
    getAll<AgentStanding>(STORES.agents),
  ]);

  if (!round) {
    throw new Error("Round data missing after seeding");
  }

  const standing = agents.find((a) => a.agent === agentId);
  if (!standing) {
    throw new Error(`Agent ${agentId} not found`);
  }

  return { round, agent: buildAgentDetail(standing) };
}

async function ensureExplorerSeeded(): Promise<void> {
  const [existingRound, existingStats, blockCount, txCount] = await Promise.all(
    [
      getValue<RoundInfo>(STORES.round, ROUND_KEY),
      getValue<ExplorerStats>(STORES.explorerStats, EXPLORER_STATS_KEY),
      countValues(STORES.blocks),
      countValues(STORES.transactions),
    ],
  );

  const tasks: Promise<void>[] = [];
  if (!existingRound)
    tasks.push(putValue(STORES.round, createSeedRound(), ROUND_KEY));
  if (!existingStats)
    tasks.push(
      putValue(STORES.explorerStats, seedExplorerStats, EXPLORER_STATS_KEY),
    );
  if (!blockCount)
    tasks.push(...seedBlocks.map((b) => putValue(STORES.blocks, b)));
  if (!txCount)
    tasks.push(
      ...seedTransactions.map((t) => putValue(STORES.transactions, t)),
    );
  await Promise.all(tasks);
}

/**
 * Mock data provider backed by IndexedDB. Seeds once on first run so the
 * block/transaction feed persists across reloads.
 */
export async function fetchExplorerSnapshot(): Promise<ExplorerSnapshot> {
  await ensureExplorerSeeded();
  const [round, stats, blocks, transactions] = await Promise.all([
    getValue<RoundInfo>(STORES.round, ROUND_KEY),
    getValue<ExplorerStats>(STORES.explorerStats, EXPLORER_STATS_KEY),
    getAll<ExplorerBlock>(STORES.blocks),
    getAll<ExplorerTransaction>(STORES.transactions),
  ]);

  if (!round || !stats) {
    throw new Error("Explorer data missing after seeding");
  }

  return {
    round,
    scope: {
      roundIndex: null,
      fromBlock: round.epochs[0]?.fromBlock ?? 0,
      toBlock: round.epochs[round.epochs.length - 1]?.toBlock ?? 0,
    },
    stats,
    blocks: blocks.sort((a, b) => b.number.localeCompare(a.number)),
    transactions: transactions.sort((a, b) => a.seq - b.seq),
    agents: seedAgents.map((a) => ({ id: a.agent })),
  };
}

// Only the parts worth persisting are stored; everything the shape has gained since (venueDepths,
// pairs, the venue panels) is attached at read time, so an IndexedDB blob written by an older
// session still renders instead of failing to parse.
type MarketSnapshotBlob = Pick<
  MarketSnapshot,
  "candles" | "feed" | "arbitrage"
>;

async function ensureMarketSeeded(): Promise<void> {
  const [existingRound, existingSnapshot, agentCount] = await Promise.all([
    getValue<RoundInfo>(STORES.round, ROUND_KEY),
    getValue<MarketSnapshotBlob>(STORES.marketSnapshot, MARKET_SNAPSHOT_KEY),
    countValues(STORES.agents),
  ]);

  const tasks: Promise<void>[] = [];
  if (!existingRound)
    tasks.push(putValue(STORES.round, createSeedRound(), ROUND_KEY));
  if (!agentCount)
    tasks.push(...seedAgents.map((a) => putValue(STORES.agents, a)));
  if (!existingSnapshot) {
    const snapshot: MarketSnapshotBlob = {
      candles: seedCandles,
      feed: seedFeed,
      arbitrage: seedArbitrage,
    };
    tasks.push(putValue(STORES.marketSnapshot, snapshot, MARKET_SNAPSHOT_KEY));
  }
  await Promise.all(tasks);
}

/**
 * Mock data provider backed by IndexedDB. Seeds once on first run so the
 * chart, depth panel, and position feed persist across reloads.
 */
export async function fetchMarketSnapshot(
  _base?: string,
): Promise<MarketSnapshot> {
  await ensureMarketSeeded();
  const [round, snapshot, agents] = await Promise.all([
    getValue<RoundInfo>(STORES.round, ROUND_KEY),
    getValue<MarketSnapshotBlob>(STORES.marketSnapshot, MARKET_SNAPSHOT_KEY),
    getAll<AgentStanding>(STORES.agents),
  ]);

  if (!round || !snapshot) {
    throw new Error("Market data missing after seeding");
  }

  return {
    round,
    scope: {
      roundIndex: null,
      fromBlock: round.epochs[0]?.fromBlock ?? 0,
      toBlock: round.epochs[round.epochs.length - 1]?.toBlock ?? 0,
    },
    leaderboard: agents.sort((a, b) => a.rank - b.rank),
    ...snapshot,
    protocols: ["uniswap", "balancer", "curve", "gmx"],
    base: "WETH",
    fairPrice: snapshot.candles[snapshot.candles.length - 1]?.close ?? 0,
    fairDirection: "up",
    venueDepths: seedVenueDepths,
    panels: seedVenuePanels,
    pairs: [{ label: "WETH/USDC", value: "WETH" }],
  };
}
