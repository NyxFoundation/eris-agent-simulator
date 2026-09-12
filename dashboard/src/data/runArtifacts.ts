// Low-level loader for runs/<id>/ artifacts, served by the Vite dev-server
// runs plugin (see vite.config.ts): /runs/index.json lists runs, /runs/<id>/<file>
// serves the raw artifact. Parsing is deliberately defensive — older runs predate
// several summary.json fields and must degrade to empty views, not crash them.

export interface RunIndexEntry {
  id: string;
  mtimeMs: number;
  /** True while the run is in progress (no summary.json yet, events.jsonl still moving). */
  live?: boolean;
  /** A competition rather than a single world: the dir holds matrix.json and no run artifacts. */
  kind?: "matrix";
}

/** Index entries that are actual runs. A competition dir has no summary.json and cannot be loaded as one. */
export function runEntries(entries: RunIndexEntry[]): RunIndexEntry[] {
  return entries.filter((e) => e.kind !== "matrix");
}

export function competitionEntries(entries: RunIndexEntry[]): RunIndexEntry[] {
  return entries.filter((e) => e.kind === "matrix");
}

export interface RunEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export interface BlockRow {
  blockNumber: number;
  txIndex: number;
  hash: string;
  from: string;
  priorityFeeWei: string;
  status: string;
  ownerId: string;
  role: string;
  actionType: string;
  /**
   * The function the tx called, decoded by the coordinator from the tx's own calldata
   * (ADR 0021 §4). Empty for a run recorded before the column existed, and for a selector this
   * deployment has no ABI for — an unnamed method rather than a guessed one.
   */
  method: string;
}

export interface SummaryAgent {
  id: string;
  address: string;
  /** The benchmark (rules §4.3): valued and shown, never in the population. */
  baseline?: boolean;
  /** Rules §2.2: the participant unit this agent is one submission of. */
  participant?: string;
  /**
   * ADR 0021 §2: the participant runs the agent themselves (the coordinator's roster says so).
   * Absent on a run recorded before the field, and on agents the coordinator started.
   */
  external?: boolean;
  /** Absent for an agent a segment did not place: no V_0 in it (issue #84 X2). */
  initialValueUsdc?: number;
  finalValueUsdc?: number;
  netPnlUsdc?: number;
  /** P of rules §4.4.1 — V_K − V_0 off the epoch boundaries, each end at its own marks. Absent on
   * a run recorded before the coordinator wrote it, and on an agent the run did not place. */
  pnlUsdc?: number;
  /** Written by the segment writer (core/src/segments.ts): false = in the record, not placed. */
  scored?: boolean;
  unscoredReason?: string;
  alphaUsdc?: number;
  includedTxCount: number;
  revertCount: number;
}

export interface RunSummary {
  runId: string;
  mode?: string;
  resetUnit?: string;
  /** A period's segment: its index and block window (core/src/realtime/coordinator.ts). */
  segment?: number;
  fromBlock?: number;
  toBlock?: number;
  blockTimeSec?: number;
  blocksProcessed?: number;
  finalFairPriceUsdcPerWeth?: number;
  valueSeries?: {
    fromBlock?: number;
    toBlock?: number;
    failedReads?: number;
    epochSeries?: {
      epochBlocks?: number;
      epochs?: number;
      boundaryBlocks?: number[];
      // A boundary the scorer could not read is null, not 0 — a failed read must not become a loss.
      valuesByAgent?: Record<string, Array<number | null>>;
    };
  };
  agents?: SummaryAgent[];
  violations?: unknown[];
}

/** One line of runs/<id>/agents/<agentId>.jsonl — a decision or a mempool self-report. */
export interface AgentLogEntry {
  ts: string;
  agentId?: string;
  kind?: string;
  event?: string;
  round?: number;
  reason?: string;
  action?: { type?: string };
  actionType?: string;
  protocol?: string;
  hash?: string;
  blockSeen?: number;
  error?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// runs/<id>/market.json — post-run market series reconstruction (issue #63 Phase 2).
// Shape defined by core/src/realtime/marketSeries.ts; absent for runs recorded before it existed.

export interface VenueQuoteSample {
  mid: number;
  buy?: number;
  sell?: number;
  depthUsd?: number;
}

export interface MarketSeriesRow {
  block: number;
  fair: Record<string, number>;
  venues?: Record<string, Record<string, VenueQuoteSample>>;
  gmx?: Record<
    string,
    // fundingPerHourBps is absent when its read failed (never a silent 0).
    { longOiUsd: number; shortOiUsd: number; fundingPerHourBps?: number }
  >;
  aave?: Record<
    string,
    { suppliedUsd: number; borrowedUsd: number; utilization: number }
  >;
  // Market-priced stables (issue #27). `quoted: false` means the pool would not quote and priceUsdc
  // is par by fallback — it must never be rendered as "the peg held".
  stables?: Record<
    string,
    {
      priceUsdc: number;
      sellPriceUsdc: number;
      buyPriceUsdc: number;
      quoted: boolean;
    }
  >;
}

export interface GmxPositionAtEnd {
  agent: string;
  base: string;
  isLong: boolean;
  sizeUsd: number;
  collateralUsd: number;
  entryPriceUsd: number | null;
}

export interface LstPositionAtEnd {
  agent: string;
  shares: number;
  shareAssetsWeth: number;
  claimableWeth: number;
  pendingWeth: number;
  openRequests: number;
}

export interface LiquityPositionAtEnd {
  agent: string;
  troveDebtEusd: number;
  troveCollWeth: number;
  icr: number | null;
  stabilityDepositEusd: number;
  eusdBalance: number;
}

export interface AaveAccountAtEnd {
  agent: string;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number | null;
}

export interface TxNotional {
  usd: number;
  amount: string;
  base?: string;
  side?: "buy" | "sell";
  /** Absolute net base flow in whole tokens (set together with base/side). */
  baseUnits?: number;
  /** Counter-leg USD per base unit. Present only when both legs really moved — the discriminator
   * between a swap and a one-sided transfer (Aave supply, GMX collateral). */
  priceUsd?: number;
}

export interface MarketSeriesFile {
  fromBlock: number;
  toBlock: number;
  granularityBlocks: number;
  failedReads: number;
  bases: string[];
  venues: string[];
  series: MarketSeriesRow[];
  gmxPositionsAtEnd: GmxPositionAtEnd[];
  aaveAccountsAtEnd: AaveAccountAtEnd[];
  // Absent in runs recorded before these venues were reported per agent.
  lstPositionsAtEnd?: LstPositionAtEnd[];
  liquityPositionsAtEnd?: LiquityPositionAtEnd[];
  notionals: Record<string, TxNotional>;
  /**
   * Where the series came from. `reconstructed` is market.json, the post-run sweep over every
   * block. `sampled` is market.jsonl, the rows the coordinator writes at each epoch boundary while
   * the run is going (core/src/realtime/liveScoring.ts) -- the only market series a practice
   * period's closed segments have, since the sweep needs a node history a day-long segment does not
   * fit in (ADR 0021 §3). Same row shape, coarser cadence, and no per-transaction notionals.
   */
  source?: "reconstructed" | "sampled";
}

/** A market series built from the boundary samples, for a run that has no market.json. */
export function marketFromSamples(text: string): MarketSeriesFile | null {
  return marketFromSampleRows(parseJsonl<MarketSeriesRow>(text));
}

/** The same, from rows already parsed (the live tail of market.jsonl). */
export function marketFromSampleRows(
  parsed: MarketSeriesRow[],
): MarketSeriesFile | null {
  const rows = parsed.filter((r) => typeof r.block === "number");
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.block - b.block);
  const venues = new Set<string>();
  const bases = new Set<string>();
  for (const r of rows) {
    for (const v of Object.keys(r.venues ?? {})) venues.add(v);
    for (const b of Object.keys(r.fair ?? {})) bases.add(b);
  }
  return {
    fromBlock: rows[0].block,
    toBlock: rows[rows.length - 1].block,
    granularityBlocks: rows.length > 1 ? rows[1].block - rows[0].block : 0,
    failedReads: 0,
    bases: [...bases],
    venues: [...venues],
    series: rows,
    gmxPositionsAtEnd: [],
    aaveAccountsAtEnd: [],
    notionals: {},
    source: "sampled",
  };
}

// Present only on a live run's synthetic LoadedRun (issue #63 Phase 3): what the current-block RPC
// reads reflect, so every live panel can carry the height it renders.
export interface LiveExtras {
  chainHeight: number | null;
  /**
   * The run's first competition block, pinned when it was first seen rather than re-derived. A
   * capped event tail loses the earliest lines on a long run, and re-deriving would answer with
   * the oldest surviving one — which lays every round boundary out from the wrong place.
   */
  firstBlock: number | null;
  /**
   * The lowest block the live block rows cover, or null when they cover none. Decides which rounds
   * have a transaction count: a round that starts before this block is outside what the view
   * holds, and its count is "not counted" rather than 0 (issue #84 A/I). Off the fetched range,
   * not off the first row's block -- a block with no transaction in it is still covered.
   */
  blocksFrom: number | null;
  /** Blockscout's indexed height when the explorer answers — the indexer lag stays visible. */
  indexerHeight: number | null;
  /** Fair-price samples accumulated while the page watches (one PriceFeed read per refresh). */
  fairSamples: { block: number; fair: number }[];
  startedAtMs: number | null;
  runSeconds: number | null;
  runBlocks: number | null;
}

export interface LoadedRun {
  id: string;
  summary: RunSummary;
  events: RunEvent[];
  blockRows: BlockRow[];
  // null when the run predates the market series artifact — consumers fall back to Phase 1 behavior.
  market: MarketSeriesFile | null;
  // Set only while the run is live (assembled by liveRun.ts, not read from disk).
  live?: LiveExtras;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export async function listRuns(): Promise<RunIndexEntry[]> {
  const res = await fetch("/runs/index.json");
  if (!res.ok)
    throw new Error(
      `runs index unavailable (HTTP ${res.status}) — is the Vite dev server serving runs/?`,
    );
  return (await res.json()) as RunIndexEntry[];
}

export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // a torn tail line from a run killed mid-write; skip it
    }
  }
  return out;
}

// blocks.csv columns: round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex,method
// No field is quoted, so a plain split is safe. Header (and any repeated header) rows
// are dropped by the numeric blockNumber check.
export function parseBlocksCsv(text: string): BlockRow[] {
  const rows: BlockRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    const blockNumber = Number(cols[1]);
    if (!Number.isFinite(blockNumber)) continue;
    rows.push({
      blockNumber,
      txIndex: Number(cols[2]) || 0,
      hash: cols[3] ?? "",
      from: (cols[4] ?? "").toLowerCase(),
      priorityFeeWei: cols[5] ?? "",
      status: cols[6] ?? "",
      ownerId: cols[7] ?? "",
      role: cols[8] ?? "",
      actionType: cols[9] ?? "",
      method: cols[12] ?? "",
    });
  }
  return rows;
}

// The run-start and roster events are written before the first block, so they sit in the first
// few KB of events.jsonl. Reading 128KB of a file instead of the file costs nothing a competition
// of 35 scenarios would notice.
const HEAD_BYTES = 128 * 1024;

/**
 * The head of a run's event stream: enough for `run_started_realtime`, `agents_registered` and
 * `stress_schedule`. Works on a run in progress (no summary.json yet) and through the audience
 * redaction alike, and reads only the head. Empty when the run has no events file.
 */
export async function loadRunHeader(runId: string): Promise<RunEvent[]> {
  try {
    const res = await fetch(
      `/runs/${encodeURIComponent(runId)}/tail/events.jsonl?offset=0&limit=${HEAD_BYTES}`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { text?: string };
    return parseJsonl<RunEvent>(body.text ?? "");
  } catch {
    return [];
  }
}

const MAX_CACHED_RUNS = 2;
const runCache = new Map<string, Promise<LoadedRun>>();

export function loadRun(runId: string): Promise<LoadedRun> {
  const cached = runCache.get(runId);
  if (cached) return cached;

  const loading = (async (): Promise<LoadedRun> => {
    const base = `/runs/${encodeURIComponent(runId)}`;
    const [summaryText, eventsText, blocksText, marketText, samplesText] =
      await Promise.all([
        fetchText(`${base}/summary.json`),
        fetchText(`${base}/events.jsonl`).catch(() => ""),
        fetchText(`${base}/blocks.csv`).catch(() => ""),
        fetchText(`${base}/market.json`).catch(() => null),
        fetchText(`${base}/market.jsonl`).catch(() => null),
      ]);
    let market: MarketSeriesFile | null = null;
    if (marketText) {
      try {
        market = {
          ...(JSON.parse(marketText) as MarketSeriesFile),
          source: "reconstructed",
        };
      } catch {
        // a torn artifact from a killed run; the Phase 1 fallback still renders
      }
    }
    // A practice period's closed segments never get market.json (the post-run sweep needs more node
    // history than a day holds); the boundary samples are their market series.
    if (!market && samplesText) market = marketFromSamples(samplesText);
    return {
      id: runId,
      summary: JSON.parse(summaryText) as RunSummary,
      events: parseJsonl<RunEvent>(eventsText),
      blockRows: parseBlocksCsv(blocksText),
      market,
    };
  })();

  loading.catch(() => runCache.delete(runId));
  runCache.set(runId, loading);
  while (runCache.size > MAX_CACHED_RUNS) {
    const oldest = runCache.keys().next().value;
    if (oldest === undefined) break;
    runCache.delete(oldest);
  }
  return loading;
}

const agentLogCache = new Map<string, Promise<AgentLogEntry[]>>();

export function loadAgentLog(
  runId: string,
  agentId: string,
): Promise<AgentLogEntry[]> {
  const key = `${runId}/${agentId}`;
  const cached = agentLogCache.get(key);
  if (cached) return cached;
  const loading = fetchText(
    `/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}.jsonl`,
  )
    .then(parseJsonl<AgentLogEntry>)
    .catch(() => [] as AgentLogEntry[]);
  agentLogCache.set(key, loading);
  if (agentLogCache.size > 64) {
    const oldest = agentLogCache.keys().next().value;
    if (oldest !== undefined) agentLogCache.delete(oldest);
  }
  return loading;
}

export async function loadAllAgentLogs(
  runId: string,
  agentIds: string[],
): Promise<Map<string, AgentLogEntry[]>> {
  const logs = await Promise.all(agentIds.map((id) => loadAgentLog(runId, id)));
  return new Map(agentIds.map((id, i) => [id, logs[i]]));
}
