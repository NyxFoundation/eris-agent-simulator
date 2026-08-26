// Run-artifact data provider (issue #63 Phase 1+2): builds every snapshot the UI
// consumes from runs/<id>/ files only — summary.json, events.jsonl, blocks.csv,
// agents/<id>.jsonl, and (when the run has one) the reconstructed market.json
// with per-venue prices, venue state, and tx notionals. No sim reads at view
// time; runs without market.json degrade to the Phase 1 rendering.

import { liveAgentLog, loadLiveRun } from "./liveRun";
import {
  loadAllAgentLogs,
  loadRun,
  listRuns,
  type AgentLogEntry,
  type LoadedRun,
  type MarketSeriesFile,
  type RunEvent,
} from "./runArtifacts";
import { getSelectedRunId } from "./runSelection";
import type {
  AgentDetail,
  AgentDetailSnapshot,
  AgentLogLine,
  AgentPosition,
  AgentStanding,
  AgentTrade,
  ArbitrageSnapshot,
  ArbTradeMarker,
  ArchiveEvent,
  ArchiveSnapshot,
  Candle,
  ExplorerBlock,
  ExplorerSnapshot,
  ExplorerTransaction,
  MarketFeedItem,
  MarketPosition,
  MarketSnapshot,
  MarketTicker,
  MarketTrade,
  RoundInfo,
  StrategyCategory,
  TapeEvent,
  TopPageSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// run resolution

interface ResolvedRun extends LoadedRun {
  /** 1-based position of this run in chronological order across runs/. */
  roundNumber: number;
}

async function resolveRun(): Promise<ResolvedRun> {
  const runs = await listRuns();
  if (runs.length === 0) {
    throw new Error(
      "no runs found under runs/ — complete a `npm run sim:realtime` first",
    );
  }
  const selected = getSelectedRunId();
  const index = Math.max(
    0,
    runs.findIndex((r) => r.id === selected),
  );
  const entry = runs[index === -1 ? 0 : index];
  // A live run has no summary.json yet — its state is tailed and read from the chain instead of
  // loaded from artifacts (issue #63 Phase 3), and nothing about it is cached across refreshes.
  const run = entry.live
    ? await loadLiveRun(entry.id)
    : await loadRun(entry.id);
  // runs are sorted newest-first; number them oldest = 1 so newer runs count up
  return { ...run, roundNumber: runs.length - runs.indexOf(entry) };
}

// The tailed in-memory logs for a live run; the on-disk artifacts otherwise. The artifact loader
// caches whole files, which is exactly wrong while they are still being appended to.
async function agentLogsFor(
  run: LoadedRun,
): Promise<Map<string, AgentLogEntry[]>> {
  const ids = (run.summary.agents ?? []).map((a) => a.id);
  if (run.live) return new Map(ids.map((id) => [id, liveAgentLog(run.id, id)]));
  return loadAllAgentLogs(run.id, ids);
}

// ---------------------------------------------------------------------------
// shared derivations

function eventOfType(events: RunEvent[], type: string): RunEvent | undefined {
  return events.find((e) => e.type === type);
}

interface RegisteredAgent {
  id: string;
  address: string;
  baseline?: boolean;
  description?: string;
}

function registeredAgents(run: LoadedRun): Map<string, RegisteredAgent> {
  const event = eventOfType(run.events, "agents_registered");
  const list = (event?.agents as RegisteredAgent[] | undefined) ?? [];
  return new Map(list.map((a) => [a.id, a]));
}

interface PricePoint {
  block: number;
  fair: number;
  pool: number;
}

interface ObservationSeries {
  prices: PricePoint[];
  valuesByAgent: Map<string, { block: number; value: number }[]>;
}

const observationCache = new WeakMap<LoadedRun & object, ObservationSeries>();

function observationSeries(run: LoadedRun): ObservationSeries {
  const cached = observationCache.get(run);
  if (cached) return cached;

  const priceByBlock = new Map<number, PricePoint>();
  const valuesByAgent = new Map<string, { block: number; value: number }[]>();
  for (const event of run.events) {
    if (event.type !== "observation") continue;
    const obs = event.observation as
      | {
          blockNumber?: number | string; // serialized as a string in events.jsonl
          fairPriceUsdcPerWeth?: number;
          poolPriceUsdcPerWeth?: number;
          inventory?: { valueUsdc?: number };
        }
      | undefined;
    const block = Number(obs?.blockNumber);
    if (!Number.isFinite(block)) continue;
    const fair = obs?.fairPriceUsdcPerWeth;
    const pool = obs?.poolPriceUsdcPerWeth;
    if (typeof fair === "number" && typeof pool === "number") {
      priceByBlock.set(block, { block, fair, pool });
    }
    const agentId = event.agentId as string | undefined;
    const value = obs?.inventory?.valueUsdc;
    if (agentId && typeof value === "number") {
      let series = valuesByAgent.get(agentId);
      if (!series) valuesByAgent.set(agentId, (series = []));
      series.push({ block, value });
    }
  }
  const prices = [...priceByBlock.values()].sort((a, b) => a.block - b.block);
  for (const series of valuesByAgent.values())
    series.sort((a, b) => a.block - b.block);

  const result = { prices, valuesByAgent };
  observationCache.set(run, result);
  return result;
}

function firstBlock(run: LoadedRun): number {
  return (
    run.summary.valueSeries?.fromBlock ?? run.blockRows[0]?.blockNumber ?? 0
  );
}

function lastBlock(run: LoadedRun): number {
  return (
    run.summary.valueSeries?.toBlock ??
    run.blockRows[run.blockRows.length - 1]?.blockNumber ??
    0
  );
}

function buildRound(run: ResolvedRun): RoundInfo {
  if (run.live) {
    const startsAt = run.live.startedAtMs ?? Date.now();
    // The run ends at whichever bound bites first: the block count or the wall-clock cap.
    const blockTimeSec = run.summary.blockTimeSec ?? 2;
    const bounds = [
      run.live.runBlocks !== null ? run.live.runBlocks * blockTimeSec : null,
      run.live.runSeconds,
    ].filter((s): s is number => s !== null && s > 0);
    const durationSec = bounds.length > 0 ? Math.min(...bounds) : 0;
    return {
      roundNumber: run.roundNumber,
      status: "live",
      startsAt,
      endsAt: startsAt + durationSec * 1000,
      blockNumber: run.live.chainHeight ?? lastBlock(run),
    };
  }
  const started =
    eventOfType(run.events, "run_started_realtime")?.ts ?? run.events[0]?.ts;
  const completed =
    eventOfType(run.events, "run_completed")?.ts ??
    run.events[run.events.length - 1]?.ts;
  const startsAt = started ? Date.parse(started) : Date.now();
  const endsAt = completed ? Date.parse(completed) : startsAt;
  return {
    roundNumber: run.roundNumber,
    status: "archived",
    startsAt,
    endsAt,
    blockNumber: lastBlock(run),
  };
}

function maxDrawdownPercent(values: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, ((value - peak) / peak) * 100);
  }
  return worst;
}

function categorize(id: string, description: string): StrategyCategory {
  const text = `${id} ${description}`.toLowerCase();
  if (/arb|redemption|peg/.test(text)) return "arb";
  if (/lp|liquidity|provider|maker|underwriter/.test(text)) return "mm";
  return "dir";
}

function buildStandings(run: LoadedRun): AgentStanding[] {
  const registered = registeredAgents(run);
  const epochScores = run.summary.epochScores ?? {};
  const valuesByAgent =
    run.summary.valueSeries?.epochSeries?.valuesByAgent ?? {};
  const agents = run.summary.agents ?? [];

  const rows = agents.map((agent) => {
    const epochScore = epochScores[agent.id];
    const stdLogReturn = epochScore?.stdLogReturn ?? 0;
    const description = registered.get(agent.id)?.description ?? agent.id;
    return {
      rank: 0,
      agent: agent.id,
      // the run's official metric (M9: mean − λ·std of epoch log returns), scaled
      // to bps of log growth per epoch so it survives .toFixed(1) in the UI
      score: (epochScore?.score ?? 0) * 10_000,
      pnlPercent:
        agent.initialValueUsdc > 0
          ? (agent.netPnlUsdc / agent.initialValueUsdc) * 100
          : 0,
      sharpe:
        stdLogReturn > 0 ? (epochScore?.meanLogReturn ?? 0) / stdLogReturn : 0,
      strategy: description,
      strategyCategory: categorize(agent.id, description),
      maxDrawdownPercent: maxDrawdownPercent(valuesByAgent[agent.id] ?? []),
      move: 0, // no cross-round concept in a single run (issue #63 Phase 4)
      netPnlUsdc: agent.netPnlUsdc,
    };
  });

  rows.sort((a, b) => b.score - a.score || b.netPnlUsdc - a.netPnlUsdc);
  return rows.map(({ netPnlUsdc: _drop, ...row }, i) => ({
    ...row,
    rank: i + 1,
  }));
}

// ---------------------------------------------------------------------------
// formatting helpers

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
}

function formatDeltaPercent(
  from: number,
  to: number,
): { delta: string; direction: "up" | "down" } {
  const pct = from !== 0 ? ((to - from) / from) * 100 : 0;
  return {
    delta: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
    direction: pct >= 0 ? "up" : "down",
  };
}

function clockTime(ts: string | undefined): string {
  return ts ? ts.slice(11, 19) : "—";
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== points[points.length - 1])
    out.push(points[points.length - 1]);
  return out;
}

/** "t+42s" — block offset from the run's first block, in chain time. */
function blockClock(run: LoadedRun, blockNumber: number): string {
  const blockTimeSec = run.summary.blockTimeSec ?? 1;
  return `t+${(blockNumber - firstBlock(run)) * blockTimeSec}s`;
}

// ---------------------------------------------------------------------------
// tape / archive events

interface TapeRule {
  kind: string;
  tone: TapeEvent["tone"];
  body: (e: RunEvent) => string;
  value: (e: RunEvent) => string;
}

const num = (v: unknown): number =>
  typeof v === "number" ? v : Number(v ?? 0);
const str = (v: unknown): string =>
  typeof v === "string" ? v : String(v ?? "");

const TAPE_RULES: Record<string, TapeRule> = {
  run_started_realtime: {
    kind: "RUN",
    tone: "neutral",
    body: (e) =>
      `run started · ${((e.enabledProtocols as string[]) ?? []).join(" ")}`,
    value: (e) => `${num(e.runBlocks)} blocks`,
  },
  stress_schedule: {
    kind: "SCENARIO",
    tone: "accent",
    body: (e) => {
      const events = (e.events as { type?: string }[] | undefined) ?? [];
      return `stress schedule: ${events.map((s) => s.type).join(", ")}`;
    },
    value: (e) => `${((e.events as unknown[]) ?? []).length} events`,
  },
  stress_victim_hf: {
    kind: "VICTIM HF",
    tone: "down",
    body: (e) =>
      `victim health factors at blk ${num(e.blockNumber).toLocaleString("en-US")}`,
    value: (e) => {
      const victims =
        (e.victims as { healthFactor?: string }[] | undefined) ?? [];
      const min = Math.min(
        ...victims.map((v) => Number(v.healthFactor ?? 0) / 1e18),
      );
      return Number.isFinite(min) ? `HF ${min.toFixed(3)}` : "";
    },
  },
  stress_liquidation: {
    kind: "LIQUIDATION",
    tone: "down",
    body: (e) =>
      `liquidation at blk ${num(e.blockNumber).toLocaleString("en-US")}`,
    value: () => "",
  },
  stress_liquidity_pull: {
    kind: "LIQUIDITY",
    tone: "down",
    body: (e) => `${str(e.venue)} ${str(e.market)} depth ${str(e.direction)}`,
    value: (e) => `×${num(e.depthMultiplier).toFixed(2)}`,
  },
  stress_liquidity_restored: {
    kind: "LIQUIDITY",
    tone: "up",
    body: (e) => `${str(e.venue)} depth restored`,
    value: () => "",
  },
  stress_eusd_depeg: {
    kind: "DEPEG",
    tone: "down",
    body: (e) =>
      `eUSD pool sell-off (blk ${num(e.blockNumber).toLocaleString("en-US")})`,
    value: () => "",
  },
  stress_depeg: {
    kind: "DEPEG",
    tone: "down",
    body: (e) =>
      `${str(e.stable)} pool sell-off (blk ${num(e.blockNumber).toLocaleString("en-US")})`,
    value: () => "",
  },
  no_arb_persistent_warning: {
    kind: "ARB WINDOW",
    tone: "purple",
    body: (e) =>
      `${str(e.base)} ${str(e.buyVenue)}→${str(e.sellVenue)} gap open`,
    value: (e) => `${num(e.profitBps).toFixed(0)}bps`,
  },
  run_completed: {
    kind: "RUN",
    tone: "neutral",
    body: () => "run completed, scoring reconstructed",
    value: () => "",
  },
};

const TAPE_PER_TYPE = 6;
const TAPE_TOTAL = 32;

function notableEvents(run: LoadedRun): RunEvent[] {
  const perType = new Map<string, number>();
  const picked: RunEvent[] = [];
  for (const event of run.events) {
    if (!(event.type in TAPE_RULES)) continue;
    const count = perType.get(event.type) ?? 0;
    if (count >= TAPE_PER_TYPE) continue;
    perType.set(event.type, count + 1);
    picked.push(event);
  }
  return picked.slice(0, TAPE_TOTAL);
}

function buildTape(run: LoadedRun): TapeEvent[] {
  return notableEvents(run).map((event, i) => {
    const rule = TAPE_RULES[event.type];
    return {
      id: i + 1,
      time: clockTime(event.ts),
      kind: rule.kind,
      body: rule.body(event),
      value: rule.value(event),
      tone: rule.tone,
    };
  });
}

function buildArchiveEvents(run: LoadedRun): ArchiveEvent[] {
  return notableEvents(run)
    .filter(
      (e) => e.type !== "run_started_realtime" && e.type !== "run_completed",
    )
    .slice(0, 12)
    .map((event) => {
      const rule = TAPE_RULES[event.type];
      const value = rule.value(event);
      const block =
        typeof event.blockNumber === "number"
          ? `blk ${event.blockNumber.toLocaleString("en-US")}`
          : clockTime(event.ts);
      return {
        time: block,
        text: `${rule.body(event)}${value ? ` (${value})` : ""}`,
      };
    });
}

// ---------------------------------------------------------------------------
// blocks / transactions

function groupBlocks(
  run: LoadedRun,
): { blockNumber: number; txCount: number }[] {
  const counts = new Map<number, number>();
  for (const row of run.blockRows) {
    counts.set(row.blockNumber, (counts.get(row.blockNumber) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([blockNumber, txCount]) => ({ blockNumber, txCount }))
    .sort((a, b) => b.blockNumber - a.blockNumber);
}

function toExplorerBlock(
  run: LoadedRun,
  block: { blockNumber: number; txCount: number },
): ExplorerBlock {
  return {
    number: block.blockNumber.toLocaleString("en-US"),
    time: blockClock(run, block.blockNumber),
    txCount: block.txCount,
    blockNumber: block.blockNumber,
  };
}

type TxInfo = { method: string; protocol?: string };

/** hash → agent-submitted method + venue; blocks.csv only knows agents sent "direct" txs. */
async function txInfoByHash(run: LoadedRun): Promise<Map<string, TxInfo>> {
  const logs = await agentLogsFor(run);
  const byHash = new Map<string, TxInfo>();
  for (const entries of logs.values()) {
    for (const entry of entries) {
      if (
        entry.kind === "mempool" &&
        entry.event === "submitted" &&
        entry.hash &&
        entry.actionType
      ) {
        byHash.set(entry.hash.toLowerCase(), {
          method: entry.actionType,
          ...(entry.protocol ? { protocol: entry.protocol } : {}),
        });
      }
    }
  }
  return byHash;
}

function methodOf(
  row: { actionType: string; role: string; hash: string },
  infoByHash: Map<string, TxInfo>,
): string {
  return row.actionType === "direct"
    ? (infoByHash.get(row.hash.toLowerCase())?.method ?? "direct")
    : row.actionType || row.role;
}

function notionalAmount(run: LoadedRun, hash: string): string {
  return run.market?.notionals[hash.toLowerCase()]?.amount ?? "—";
}

function buildTransactions(
  run: LoadedRun,
  infoByHash: Map<string, TxInfo>,
  limit: number,
): ExplorerTransaction[] {
  const rows = run.blockRows.slice(-limit).reverse();
  return rows.map((row, i) => {
    const method = methodOf(row, infoByHash);
    const failed = row.status !== "success";
    return {
      seq: i,
      hash: shortHash(row.hash),
      fullHash: row.hash,
      agent: row.ownerId,
      method,
      amount: notionalAmount(run, row.hash),
      time: `blk ${row.blockNumber.toLocaleString("en-US")}`,
      methodTone:
        failed || method === "liquidationCall"
          ? ("danger" as const)
          : ("default" as const),
    };
  });
}

// ---------------------------------------------------------------------------
// market series

// Fair-price points per block: the reconstructed observations for a completed run, the accumulated
// live PriceFeed samples while one is running (Phase 3 — the series grows as the page watches).
function fairSeries(run: LoadedRun): { block: number; fair: number }[] {
  const { prices } = observationSeries(run);
  if (prices.length > 0) return prices;
  return run.live?.fairSamples ?? [];
}

function buildCandles(run: LoadedRun): Candle[] {
  const prices = fairSeries(run);
  if (prices.length === 0) return [];
  const bucketSize = Math.max(1, Math.ceil(prices.length / 48));
  const candles: Candle[] = [];
  for (let i = 0; i < prices.length; i += bucketSize) {
    const bucket = prices.slice(i, i + bucketSize);
    const values = bucket.map((p) => p.fair);
    candles.push({
      time: bucket[0].block,
      open: values[0],
      high: Math.max(...values),
      low: Math.min(...values),
      close: values[values.length - 1],
    });
  }
  return candles;
}

// matches venue-arb's ROUND_TRIP_COST: one venue fee in, one out, plus slippage
const ARB_THRESHOLD_BPS = 80;

const VENUE_COLORS: Record<string, string> = {
  uniswap: "#7c9eff",
  balancer: "#f5a623",
  curve: "#4fd1a5",
};

const VENUE_LABELS: Record<string, string> = {
  uniswap: "Uniswap v3",
  balancer: "Balancer",
  curve: "Curve",
};

// Cross-venue view from market.json (issue #63 Phase 2): per-venue executable mids, spread as the
// widest venue-to-venue gap, and trade markers from the agents' actual swap txs.
function buildArbitrageFromMarket(
  run: LoadedRun,
  market: MarketSeriesFile,
  infoByHash: Map<string, TxInfo>,
  base: string,
): ArbitrageSnapshot | null {
  const rows = downsample(
    market.series.filter((r) => (r.fair[base] ?? 0) > 0),
    720,
  );
  if (rows.length < 2) return null;
  const venueIds = market.venues.filter((v) =>
    rows.some((r) => r.venues?.[v]?.[base]),
  );
  if (venueIds.length === 0) return null;

  const venues = venueIds.map((venue) => ({
    id: venue,
    label: VENUE_LABELS[venue] ?? venue,
    color: VENUE_COLORS[venue] ?? "#7c9eff",
    points: rows.flatMap((r) => {
      const mid = r.venues?.[venue]?.[base]?.mid;
      return mid !== undefined && mid > 0
        ? [{ time: r.block, price: mid }]
        : [];
    }),
  }));

  const spread = rows.map((r) => {
    const mids = venueIds.flatMap((v) => {
      const mid = r.venues?.[v]?.[base]?.mid;
      return mid !== undefined && mid > 0 ? [mid] : [];
    });
    const fair = r.fair[base];
    const spreadBps =
      mids.length >= 2 && fair > 0
        ? ((Math.max(...mids) - Math.min(...mids)) / fair) * 10_000
        : 0;
    return { time: r.block, spreadBps: Math.round(spreadBps * 10) / 10 };
  });

  // Markers: agent swaps on the charted venues, sided by the decoded net base flow. Marker times
  // must exist in the (possibly thinned) spread series, so snap to the nearest sampled block.
  const sampledBlocks = rows.map((r) => r.block);
  const snap = (block: number) =>
    sampledBlocks.reduce((best, b) =>
      Math.abs(b - block) < Math.abs(best - block) ? b : best,
    );
  const seen = new Set<string>();
  const trades: ArbTradeMarker[] = [];
  for (const row of run.blockRows) {
    if (row.role !== "agent") continue;
    const hash = row.hash.toLowerCase();
    const venue = infoByHash.get(hash)?.protocol;
    if (!venue || !venueIds.includes(venue)) continue;
    const notional = market.notionals[hash];
    if (!notional || notional.base !== base || !notional.side) continue;
    const time = snap(row.blockNumber);
    const key = `${time}|${venue}|${notional.side}`;
    if (seen.has(key)) continue; // one marker per (block, venue, side) keeps the chart readable
    seen.add(key);
    trades.push({ time, venue, side: notional.side });
  }

  return {
    fair: rows.map((r) => ({ time: r.block, price: r.fair[base] })),
    venues,
    spread,
    thresholdBps: ARB_THRESHOLD_BPS,
    trades,
  };
}

function buildArbitrage(
  run: LoadedRun,
  infoByHash: Map<string, TxInfo>,
): ArbitrageSnapshot {
  if (run.market) {
    const fromMarket = buildArbitrageFromMarket(
      run,
      run.market,
      infoByHash,
      "WETH",
    );
    if (fromMarket) return fromMarket;
  }
  // Phase 1 fallback (runs recorded before market.json existed): the one pool reference price the
  // reconstructed observations carry.
  const prices = downsample(observationSeries(run).prices, 720);
  if (prices.length >= 2) {
    return {
      fair: prices.map((p) => ({ time: p.block, price: p.fair })),
      venues: [
        {
          id: "pool",
          label: "Pool",
          color: "#7c9eff",
          points: prices.map((p) => ({ time: p.block, price: p.pool })),
        },
      ],
      spread: prices.map((p) => ({
        time: p.block,
        spreadBps:
          p.fair > 0
            ? Math.round(Math.abs((p.pool - p.fair) / p.fair) * 10_000 * 10) /
              10
            : 0,
      })),
      thresholdBps: ARB_THRESHOLD_BPS,
      trades: [],
    };
  }
  // Live run: only the accumulated fair samples exist (per-venue series are post-run artifacts).
  const live = downsample(fairSeries(run), 720);
  return {
    fair: live.map((p) => ({ time: p.block, price: p.fair })),
    venues: [],
    spread: [],
    thresholdBps: ARB_THRESHOLD_BPS,
    trades: [],
  };
}

function buildTickers(run: LoadedRun): MarketTicker[] {
  const { prices } = observationSeries(run);
  const tickers: MarketTicker[] = [];

  if (prices.length >= 2) {
    const first = prices[0];
    const last = prices[prices.length - 1];
    const fairPoints = downsample(prices, 40).map((p) => p.fair);
    const poolPoints = downsample(prices, 40).map((p) => p.pool);
    tickers.push({
      symbol: "WETH/USDC FAIR",
      price: formatUsd(last.fair),
      ...formatDeltaPercent(first.fair, last.fair),
      points: fairPoints,
    });
    tickers.push({
      symbol: "WETH/USDC POOL",
      price: formatUsd(last.pool),
      ...formatDeltaPercent(first.pool, last.pool),
      points: poolPoints,
    });
  } else if (run.live && run.live.fairSamples.length >= 2) {
    // live: the PriceFeed samples accumulated while the page watches
    const samples = run.live.fairSamples;
    const first = samples[0];
    const last = samples[samples.length - 1];
    tickers.push({
      symbol: `WETH/USDC FAIR · blk ${last.block.toLocaleString("en-US")}`,
      price: formatUsd(last.fair),
      ...formatDeltaPercent(first.fair, last.fair),
      points: downsample(samples, 40).map((p) => p.fair),
    });
  }

  // Extra bases (WBTC, …) come from the reconstructed market series — the observation events only
  // carry the WETH pair.
  if (run.market) {
    const extraBases = run.market.bases.filter((b) => b !== "WETH");
    for (const base of extraBases) {
      const rows = run.market.series.filter((r) => (r.fair[base] ?? 0) > 0);
      if (rows.length < 2) continue;
      const firstFair = rows[0].fair[base];
      const lastFair = rows[rows.length - 1].fair[base];
      tickers.push({
        symbol: `${base}/USDC FAIR`,
        price: formatUsd(lastFair),
        ...formatDeltaPercent(firstFair, lastFair),
        points: downsample(rows, 40).map((r) => r.fair[base]),
      });
    }
  }

  const boundaryValues =
    run.summary.valueSeries?.epochSeries?.valuesByAgent ?? {};
  const agentSeries = Object.values(boundaryValues);
  if (agentSeries.length > 0 && agentSeries[0].length >= 2) {
    const totals = agentSeries[0].map((_, i) =>
      agentSeries.reduce((sum, s) => sum + (s[i] ?? 0), 0),
    );
    tickers.push({
      symbol: "Σ AGENT VALUE",
      price: formatUsd(totals[totals.length - 1]),
      ...formatDeltaPercent(totals[0], totals[totals.length - 1]),
      points: downsample(totals, 40),
    });
  }

  const blocks = groupBlocks(run);
  if (blocks.length >= 2) {
    const perBlock = [...blocks].reverse().map((b) => b.txCount);
    const avg = perBlock.reduce((a, b) => a + b, 0) / perBlock.length;
    tickers.push({
      symbol: "TX / BLOCK",
      price: avg.toFixed(1),
      delta: `${run.blockRows.length.toLocaleString("en-US")} tx`,
      direction: "up",
      points: downsample(perBlock, 40),
    });
  }

  return tickers;
}

function buildFeed(logs: Map<string, AgentLogEntry[]>): MarketFeedItem[] {
  const submitted: { ts: string; text: string }[] = [];
  for (const [agentId, entries] of logs) {
    for (const entry of entries) {
      if (
        entry.kind === "mempool" &&
        entry.event === "submitted" &&
        entry.actionType
      ) {
        const block =
          typeof entry.blockSeen === "number"
            ? ` · blk ${entry.blockSeen.toLocaleString("en-US")}`
            : "";
        submitted.push({
          ts: entry.ts,
          text: `${agentId} ${entry.actionType}${block}`,
        });
      }
    }
  }
  submitted.sort((a, b) => b.ts.localeCompare(a.ts));
  return submitted
    .slice(0, 24)
    .map((item, i) => ({ id: i + 1, text: item.text }));
}

// ---------------------------------------------------------------------------
// snapshots

export async function fetchTopPageSnapshot(): Promise<TopPageSnapshot> {
  const run = await resolveRun();
  return {
    round: buildRound(run),
    leaderboard: buildStandings(run),
    marketTickers: buildTickers(run),
    blocks: groupBlocks(run)
      .slice(0, 7)
      .map((b) => toExplorerBlock(run, b)),
    tape: buildTape(run),
  };
}

export async function fetchExplorerSnapshot(): Promise<ExplorerSnapshot> {
  const run = await resolveRun();
  const infoByHash = await txInfoByHash(run);
  // Live: blockRows only cover the recent chain window, so the round's tx count comes from the
  // coordinator's tx_submitted stream instead; the indexer height rides along so its lag is visible.
  const txCountThisRound = run.live
    ? run.events.filter((e) => e.type === "tx_submitted").length
    : run.blockRows.length;
  return {
    round: buildRound(run),
    stats: {
      latestBlockNumber: (
        run.live?.chainHeight ?? lastBlock(run)
      ).toLocaleString("en-US"),
      txCountThisRound,
      activeAgents: (run.summary.agents ?? []).length,
      avgBlockTimeSeconds: run.summary.blockTimeSec ?? 0,
      ...(run.live?.indexerHeight != null
        ? { indexerBlockNumber: run.live.indexerHeight.toLocaleString("en-US") }
        : {}),
    },
    blocks: groupBlocks(run)
      .slice(0, 30)
      .map((b) => toExplorerBlock(run, b)),
    transactions: buildTransactions(run, infoByHash, 60),
  };
}

// MarketStats venue-state fields from market.json's series (issue #63 Phase 2). Runs without the
// artifact keep the honest "n/a".
function buildMarketStats(
  run: LoadedRun,
  base: string,
): Pick<
  MarketSnapshot["stats"],
  | "volume24h"
  | "openInterest"
  | "openInterestLongPercent"
  | "openInterestShortPercent"
  | "availableLiquidity"
  | "totalLiquidity"
  | "fundingRate1h"
> {
  const market = run.market;
  const firstRow = market?.series[0];
  const lastRow = market?.series[market.series.length - 1];
  if (!market || !firstRow || !lastRow) {
    return {
      volume24h: "n/a",
      openInterest: "n/a",
      openInterestLongPercent: 0,
      openInterestShortPercent: 0,
      availableLiquidity: "n/a",
      totalLiquidity: "n/a",
      fundingRate1h: "n/a",
    };
  }

  // decoded swap flow in the base over the whole run
  let volume = 0;
  for (const notional of Object.values(market.notionals)) {
    if (notional.base === base && notional.side) volume += notional.usd;
  }

  const gmx = lastRow.gmx?.[base];
  const longOi = gmx?.longOiUsd ?? 0;
  const shortOi = gmx?.shortOiUsd ?? 0;
  const totalOi = longOi + shortOi;

  const depthAt = (row: typeof lastRow): number =>
    market.venues.reduce(
      (sum, v) => sum + (row.venues?.[v]?.[base]?.depthUsd ?? 0),
      0,
    );
  const depthNow = depthAt(lastRow);
  const depthStart = depthAt(firstRow);

  return {
    volume24h: volume > 0 ? formatUsd(volume) : "n/a",
    openInterest: gmx ? formatUsd(totalOi) : "n/a",
    openInterestLongPercent:
      totalOi > 0 ? Math.round((longOi / totalOi) * 100) : 0,
    openInterestShortPercent:
      totalOi > 0 ? Math.round((shortOi / totalOi) * 100) : 0,
    availableLiquidity: depthNow > 0 ? formatUsd(depthNow) : "n/a",
    totalLiquidity: depthStart > 0 ? formatUsd(depthStart) : "n/a",
    fundingRate1h: gmx ? `${gmx.fundingPerHourBps.toFixed(2)}bps` : "n/a",
  };
}

// GMX positions still open at the run's end, as the market page's positions table.
function buildGmxPositions(
  run: LoadedRun,
  base: string,
  lastFair: number,
): MarketPosition[] {
  return (run.market?.gmxPositionsAtEnd ?? [])
    .filter((p) => p.base === base)
    .map((p) => {
      const pnlPercent =
        p.entryPriceUsd && p.entryPriceUsd > 0 && lastFair > 0
          ? (lastFair / p.entryPriceUsd - 1) * 100 * (p.isLong ? 1 : -1)
          : 0;
      return {
        agent: p.agent,
        side: p.isLong ? ("long" as const) : ("short" as const),
        size: formatUsd(p.sizeUsd),
        entry: p.entryPriceUsd
          ? p.entryPriceUsd.toLocaleString("en-US", {
              maximumFractionDigits: 1,
            })
          : "—",
        pnlPercent: Math.round(pnlPercent * 10) / 10,
      };
    });
}

// The agents' decoded swaps in the base, newest first — the "Trades" tab.
function buildMarketTrades(run: LoadedRun, base: string): MarketTrade[] {
  const market = run.market;
  if (!market) return [];
  const trades: MarketTrade[] = [];
  for (const row of [...run.blockRows].reverse()) {
    if (row.role !== "agent") continue;
    const notional = market.notionals[row.hash.toLowerCase()];
    if (!notional || notional.base !== base || !notional.side) continue;
    trades.push({
      agent: row.ownerId,
      side: notional.side === "buy" ? "long" : "short",
      size: notional.amount,
      price: formatUsd(notional.usd),
    });
    if (trades.length >= 24) break;
  }
  return trades;
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const run = await resolveRun();
  const { prices } = observationSeries(run);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const lastFair = last?.fair ?? run.summary.finalFairPriceUsdcPerWeth ?? 0;
  const logs = await agentLogsFor(run);
  const infoByHash = await txInfoByHash(run);

  return {
    round: buildRound(run),
    stats: {
      pair: "WETH/USDC",
      price: lastFair,
      direction: last && first && last.fair < first.fair ? "down" : "up",
      ...buildMarketStats(run, "WETH"),
    },
    candles: buildCandles(run),
    leaderboard: buildStandings(run),
    positions: buildGmxPositions(run, "WETH", lastFair),
    orders: [], // trigger orders are not part of any current strategy (issue #63 Phase 4)
    trades: buildMarketTrades(run, "WETH"),
    asks: [],
    bids: [],
    feed: buildFeed(logs),
    arbitrage: buildArbitrage(run, infoByHash),
  };
}

export async function fetchArchiveSnapshot(): Promise<ArchiveSnapshot> {
  const run = await resolveRun();
  const standings = buildStandings(run);
  const { prices } = observationSeries(run);
  const last = prices[prices.length - 1];
  const infoByHash = await txInfoByHash(run);

  const liquidations =
    run.blockRows.filter(
      (row) => methodOf(row, infoByHash) === "liquidationCall",
    ).length + run.events.filter((e) => e.type === "stress_liquidation").length;

  // Every decoded tx's USD notional, summed — the run's total on-chain moved value.
  const decodedVolume = Object.values(run.market?.notionals ?? {}).reduce(
    (sum, n) => sum + n.usd,
    0,
  );

  const closingPrices = [];
  const lastMarketRow = run.market?.series[run.market.series.length - 1];
  if (lastMarketRow) {
    // multi-asset closing fairs from the reconstructed market series
    for (const [base, price] of Object.entries(lastMarketRow.fair)) {
      closingPrices.push({
        pair: `${base}/USDC fair`,
        price: Math.round(price * 100) / 100,
      });
    }
  } else {
    const finalFair = last?.fair ?? run.summary.finalFairPriceUsdcPerWeth;
    if (typeof finalFair === "number")
      closingPrices.push({
        pair: "WETH/USDC fair",
        price: Math.round(finalFair * 100) / 100,
      });
  }
  if (last)
    closingPrices.push({
      pair: "WETH/USDC pool",
      price: Math.round(last.pool * 100) / 100,
    });

  return {
    round: {
      roundNumber: run.roundNumber,
      status: "archived",
      finalBlockNumber: lastBlock(run),
    },
    stats: {
      totalTx: run.blockRows.length,
      agentsEntered: (run.summary.agents ?? []).length,
      totalVolume: decodedVolume > 0 ? formatUsd(decodedVolume) : "n/a",
      liquidations,
    },
    podium: standings
      .slice(0, 3)
      .map((s) => ({ rank: s.rank, agent: s.agent, pnlPercent: s.pnlPercent })),
    finalStandings: standings.map((s) => ({
      rank: s.rank,
      agent: s.agent,
      score: s.score,
      pnlPercent: s.pnlPercent,
      sharpe: s.sharpe,
    })),
    closingPrices,
    events: buildArchiveEvents(run),
  };
}

const LOG_LIMIT = 120;

function buildAgentLogLines(entries: AgentLogEntry[]): AgentLogLine[] {
  const lines: AgentLogLine[] = [];
  for (const entry of entries) {
    const time = clockTime(entry.ts);
    if (entry.kind === "mempool") {
      if (entry.event === "submitted") {
        lines.push({
          time,
          text: `submitted ${entry.actionType ?? "tx"}${entry.protocol ? ` (${entry.protocol})` : ""}`,
          tone: "success",
        });
      } else if (
        entry.event === "submit_failed" ||
        entry.event === "rejected"
      ) {
        lines.push({
          time,
          text: `${entry.event}: ${entry.actionType ?? "tx"}${entry.error ? ` — ${entry.error}` : ""}`,
          tone: "danger",
        });
      } else if (entry.event === "runtime_start") {
        lines.push({
          time,
          text: `runtime started (${str(entry.mode)})`,
          tone: "info",
        });
      }
      continue;
    }
    if (entry.reason || entry.action) {
      const actionType = entry.action?.type;
      const prefix =
        actionType && actionType !== "noop" ? `${actionType} — ` : "";
      lines.push({
        time,
        text: `${prefix}${entry.reason ?? "(no reason logged)"}`,
        tone: actionType && actionType !== "noop" ? "warning" : "info",
      });
    }
  }
  return lines.slice(-LOG_LIMIT).reverse(); // newest first, like the seed log stream
}

export async function fetchAgentDetailSnapshot(
  agentId: string,
): Promise<AgentDetailSnapshot> {
  const run = await resolveRun();
  const standing = buildStandings(run).find((s) => s.agent === agentId);
  if (!standing) throw new Error(`agent ${agentId} not found in run ${run.id}`);

  const summaryAgent = (run.summary.agents ?? []).find((a) => a.id === agentId);
  const address = (summaryAgent?.address ?? "").toLowerCase();
  const { valuesByAgent } = observationSeries(run);
  const portfolioPoints = downsample(
    (valuesByAgent.get(agentId) ?? []).map((p) => p.value),
    240,
  );
  const infoByHash = await txInfoByHash(run);
  const logEntries = (await agentLogsFor(run)).get(agentId) ?? [];

  const trades: AgentTrade[] = run.blockRows
    .filter((row) => row.from === address)
    .slice(-60)
    .reverse()
    .map((row) => ({
      hash: shortHash(row.hash),
      fullHash: row.hash,
      block: row.blockNumber.toLocaleString("en-US"),
      blockNumber: row.blockNumber,
      method: methodOf(row, infoByHash),
      amount: notionalAmount(run, row.hash),
      time: blockClock(run, row.blockNumber),
    }));

  // Venue positions still open at the run's end (market.json): GMX perps. The Aave account totals
  // exist in market.json too but do not fit this table's columns; a dedicated view is Phase 4 work.
  const lastFairWeth =
    run.market?.series[run.market.series.length - 1]?.fair.WETH ??
    run.summary.finalFairPriceUsdcPerWeth ??
    0;
  const positions: AgentPosition[] = (run.market?.gmxPositionsAtEnd ?? [])
    .filter((p) => p.agent === agentId)
    .map((p) => ({
      market: `${p.base}/USDC (GMX)`,
      side: p.isLong ? ("long" as const) : ("short" as const),
      size: formatUsd(p.sizeUsd),
      entry: p.entryPriceUsd
        ? p.entryPriceUsd.toLocaleString("en-US", { maximumFractionDigits: 1 })
        : "—",
      pnlPercent:
        p.entryPriceUsd && p.entryPriceUsd > 0 && lastFairWeth > 0
          ? Math.round(
              (lastFairWeth / p.entryPriceUsd - 1) *
                100 *
                (p.isLong ? 1 : -1) *
                10,
            ) / 10
          : 0,
    }));
  const fullLog = buildAgentLogLines(logEntries);

  const agent: AgentDetail = {
    rank: standing.rank,
    agent: standing.agent,
    address: shortAddress(summaryAgent?.address ?? ""),
    fullAddress: summaryAgent?.address,
    strategy: standing.strategy,
    score: standing.score,
    pnlPercent: standing.pnlPercent,
    sharpe: standing.sharpe,
    maxDrawdownPercent: standing.maxDrawdownPercent,
    portfolioPoints,
    positions,
    trades,
    recentLog: fullLog.slice(0, 8),
    fullLog,
  };

  return { round: buildRound(run), agent };
}
