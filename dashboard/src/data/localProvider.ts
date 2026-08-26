import { countValues, getAll, getValue, putValue, STORES } from "./db";
import {
  buildAgentDetail,
  createSeedRound,
  seedAgents,
  seedArbitrage,
  seedArchiveClosingPrices,
  seedArchiveEvents,
  seedArchiveFinalStandings,
  seedArchivePodium,
  seedArchiveRound,
  seedArchiveStats,
  seedVenueDepths,
  seedBlocks,
  seedCandles,
  seedExplorerStats,
  seedFeed,
  seedMarketStats,
  seedMarketTickers,
  seedOrders,
  seedPositions,
  seedTape,
  seedTrades,
  seedTransactions,
} from "./seed";
import type {
  AgentDetailSnapshot,
  AgentStanding,
  ArchiveSnapshot,
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
const ARCHIVE_KEY = "round-13";
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
    stats,
    blocks: blocks.sort((a, b) => b.number.localeCompare(a.number)),
    transactions: transactions.sort((a, b) => a.seq - b.seq),
  };
}

// The stored blob predates the Phase 4 shape (venueDepths/pairs replaced the fictional order
// book), so those fields are attached at read time instead of persisted — an old IndexedDB blob
// from a previous session then still renders.
type MarketSnapshotBlob = Omit<
  MarketSnapshot,
  "round" | "leaderboard" | "venueDepths" | "pairs"
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
      stats: seedMarketStats,
      candles: seedCandles,
      positions: seedPositions,
      orders: seedOrders,
      trades: seedTrades,
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
    leaderboard: agents.sort((a, b) => a.rank - b.rank),
    ...snapshot,
    venueDepths: seedVenueDepths,
    pairs: [{ label: "WETH/USDC", value: "WETH" }],
  };
}

async function ensureArchiveSeeded(): Promise<void> {
  const existingArchive = await getValue<ArchiveSnapshot>(
    STORES.archive,
    ARCHIVE_KEY,
  );
  if (existingArchive) return;
  const archive: ArchiveSnapshot = {
    round: seedArchiveRound,
    stats: seedArchiveStats,
    podium: seedArchivePodium,
    finalStandings: seedArchiveFinalStandings,
    closingPrices: seedArchiveClosingPrices,
    events: seedArchiveEvents,
  };
  await putValue(STORES.archive, archive, ARCHIVE_KEY);
}

/**
 * Mock data provider backed by IndexedDB. Seeds once on first run so the
 * archived round's final standings and stats persist across reloads.
 */
export async function fetchArchiveSnapshot(): Promise<ArchiveSnapshot> {
  await ensureArchiveSeeded();
  const archive = await getValue<ArchiveSnapshot>(STORES.archive, ARCHIVE_KEY);

  if (!archive) {
    throw new Error("Archive data missing after seeding");
  }

  return archive;
}
