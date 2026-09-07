// Live mode (issue #63 Phase 3): while a run is in progress, runs/<id>/ has no summary.json and no
// reconstructed observations yet — those are post-run artifacts. What does exist live:
//   - events.jsonl, appended every block (run meta, round_timing heights, tx_submitted, stress events)
//   - blocks.csv, appended within a block of the head while the run is segmented (a practice
//     period, ADR 0021 §6); written in one pass at the end otherwise
//   - epochs.jsonl / market.jsonl, one row per epoch boundary (the live scorer, ADR 0021 §3)
//   - agents/<id>.jsonl, appended per decision (reasons + submitted-tx self-reports, incl. rpcUrl)
//   - the chain itself (current-block state via JSON-RPC; anvil answers the browser directly)
// This module tails the files incrementally through the dev server's /runs/<id>/tail endpoint,
// reads current-block state over RPC where it may, and assembles a synthetic LoadedRun so the
// ordinary snapshot builders render it. Every reader is best-effort: a live view may be seconds
// behind and says so (each panel carries the block height it reflects).
//
// The public view reads no chain (the RPC an audience would need is the competition node, issue
// #74), and it used to read nothing else either: the explorer showed `blocks 0–0` and every venue
// `—` for the whole period, which is exactly when a self-hosted participant wants to know whether
// their transaction landed (issue #84 A). blocks.csv and market.jsonl are served to everyone and
// answer both, so they are tailed in every mode; the chain, where it can be read, only adds the
// last few blocks the coordinator has not flushed yet.

import { methodNameForCalldata } from "@sdk/methodSelectors";
import { mergeLiveBlocks } from "./liveBlocks";
import {
  loadRunHeader,
  marketFromSampleRows,
  parseBlocksCsv,
  type AgentLogEntry,
  type BlockRow,
  type LoadedRun,
  type MarketSeriesRow,
  type RunEvent,
  type RunSummary,
  type SummaryAgent,
} from "./runArtifacts";
import { getMode } from "./mode";

const EVENT_LIMIT = 5_000;
const AGENT_LOG_LIMIT = 500;
const RECENT_BLOCKS = 30;
// Rows of blocks.csv held for a live run. A day-long segment writes ~200k rows; the newest are
// what the explorer, the board and the round counts read, and the cap keeps the page's memory
// bounded. What falls off the front is reported as "not covered" (`blocksFrom`), never as empty.
const BLOCK_ROW_LIMIT = 60_000;
// How often the public view re-reads the head of events.jsonl for the stress schedule. The server
// serves a window only once it has closed, and the tail moves past the line the first time it is
// read -- so a schedule that was withheld at first was never seen again when its windows closed,
// and the landing said "nothing happened" for the rest of the period (issue #84 S).
const SCHEDULE_REFRESH_EVERY = 10;
// Written before the first block and read by every builder: kept whatever the cap does.
const HEADER_TYPES = new Set([
  "run_started_realtime",
  "agents_registered",
  "stress_schedule",
  "price_feed_deployed",
]);

interface TailState {
  offset: number;
}

async function tail(
  runId: string,
  file: string,
  state: TailState,
): Promise<string> {
  const res = await fetch(
    `/runs/${encodeURIComponent(runId)}/tail/${file}?offset=${state.offset}`,
  );
  if (!res.ok) return "";
  const body = (await res.json()) as { offset: number; text: string };
  state.offset = body.offset;
  return body.text;
}

function parseJsonlChunk<T>(text: string, carry: { partial: string }): T[] {
  const combined = carry.partial + text;
  const lines = combined.split("\n");
  // the final element is either "" (chunk ended on a newline) or a torn line to carry forward
  carry.partial = lines.pop() ?? "";
  const out: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // torn write; skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-RPC (plain fetch; anvil's CORS defaults allow the browser)

async function rpc<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T };
    return body.result ?? null;
  } catch {
    return null;
  }
}

const LATEST_ANSWER_SELECTOR = "0x50d25bcd"; // latestAnswer()
const PRICE_DECIMALS = 1e8;

// Pinned to the height the sample is stamped with — the block reads before this take long enough
// for a 2s chain to advance, and "latest" would attach block N+1's price to block N.
async function readFair(
  rpcUrl: string,
  priceFeed: string,
  blockNumber: number,
): Promise<number | null> {
  const result = await rpc<string>(rpcUrl, "eth_call", [
    { to: priceFeed, data: LATEST_ANSWER_SELECTOR },
    `0x${blockNumber.toString(16)}`,
  ]);
  if (!result || result === "0x") return null;
  const answer = Number(BigInt(result)) / PRICE_DECIMALS;
  return answer > 0 ? answer : null;
}

interface RpcBlock {
  number: string;
  // `input` is the calldata: what the tx actually asked the chain to do. ADR 0021 §4 makes it the
  // source for the method name, in place of a join against the agents' self-reported logs.
  transactions: { hash: string; from: string; input?: string }[];
}

// ---------------------------------------------------------------------------
// per-run live state

interface RegisteredAgent {
  id: string;
  address: string;
  baseline?: boolean;
  description?: string;
}

class LiveRunState {
  private readonly eventsTail: TailState = { offset: 0 };
  private readonly eventsCarry = { partial: "" };
  private readonly blocksTail: TailState = { offset: 0 };
  private readonly blocksCarry = { partial: "" };
  private readonly marketTail: TailState = { offset: 0 };
  private readonly marketCarry = { partial: "" };
  private readonly agentTails = new Map<
    string,
    { state: TailState; carry: { partial: string } }
  >();

  private events: RunEvent[] = [];
  /**
   * The run's header events, held apart from the capped stream. They are the first lines of the
   * file, and a viewer who opens a day-long segment at 15:00 folds forty thousand events at once;
   * with the cap keeping the newest, the header went first -- and with it the epoch length, so the
   * rounds bar was empty for the rest of the day.
   */
  private readonly header = new Map<string, RunEvent>();
  /** blocks.csv rows, oldest first, capped at BLOCK_ROW_LIMIT (the newest are kept). */
  private csvRows: BlockRow[] = [];
  /** The first block blocks.csv covered, kept even after the row that carried it was capped off. */
  private csvFrom: number | null = null;
  private marketRows: MarketSeriesRow[] = [];
  private refreshes = 0;
  private agentLogs = new Map<string, AgentLogEntry[]>();
  private agents: RegisteredAgent[] = [];
  private meta: {
    blockTimeSec: number;
    runSeconds: number | null;
    runBlocks: number | null;
    startedAtMs: number | null;
    priceFeed: string | null;
    rpcUrl: string | null;
  } = {
    blockTimeSec: 2,
    runSeconds: null,
    runBlocks: null,
    startedAtMs: null,
    priceFeed: null,
    rpcUrl: null,
  };
  private latestEventBlock: number | null = null;
  private fairSamples: { block: number; fair: number }[] = [];
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  private foldEvents(fresh: RunEvent[]): void {
    for (const event of fresh) {
      if (HEADER_TYPES.has(event.type)) this.header.set(event.type, event);
      switch (event.type) {
        case "run_started_realtime":
          this.meta.startedAtMs = event.ts ? Date.parse(event.ts) : Date.now();
          this.meta.blockTimeSec =
            typeof event.blockTimeSec === "number"
              ? event.blockTimeSec
              : this.meta.blockTimeSec;
          this.meta.runSeconds =
            typeof event.runSeconds === "number" ? event.runSeconds : null;
          this.meta.runBlocks =
            typeof event.runBlocks === "number" ? event.runBlocks : null;
          // ADR 0021 §4: the environment records the endpoint. This used to be discovered from an
          // agent's `runtime_start` line, which works only while the coordinator is the thing
          // starting the agents — on the practice devnet they are other people's processes on other
          // people's machines, and no line of theirs reaches here.
          if (typeof event.rpcUrl === "string") this.meta.rpcUrl = event.rpcUrl;
          break;
        case "price_feed_deployed":
          if (typeof event.address === "string")
            this.meta.priceFeed = event.address;
          break;
        case "agents_registered":
          if (Array.isArray(event.agents))
            this.agents = event.agents as RegisteredAgent[];
          break;
        case "round_timing":
          if (typeof event.blockNumber === "number")
            this.latestEventBlock = event.blockNumber;
          break;
      }
    }
    this.events.push(...fresh.filter((e) => !HEADER_TYPES.has(e.type)));
    if (this.events.length > EVENT_LIMIT)
      this.events = this.events.slice(-EVENT_LIMIT);
  }

  /** The stream as the builders read it: the header first, then the capped tail. */
  private allEvents(): RunEvent[] {
    return [...this.header.values(), ...this.events];
  }

  private async refreshAgentLogs(): Promise<void> {
    await Promise.all(
      this.agents.map(async ({ id }) => {
        let entry = this.agentTails.get(id);
        if (!entry) {
          entry = { state: { offset: 0 }, carry: { partial: "" } };
          this.agentTails.set(id, entry);
        }
        const text = await tail(
          this.runId,
          `agents/${encodeURIComponent(id)}.jsonl`,
          entry.state,
        );
        if (!text) return;
        const fresh = parseJsonlChunk<AgentLogEntry>(text, entry.carry);
        if (fresh.length === 0) return;
        const existing = this.agentLogs.get(id) ?? [];
        const merged = [...existing, ...fresh];
        this.agentLogs.set(
          id,
          merged.length > AGENT_LOG_LIMIT
            ? merged.slice(-AGENT_LOG_LIMIT)
            : merged,
        );
        // Fallback only, for a run recorded before the coordinator started writing the endpoint
        // into run_started_realtime (ADR 0021 §4). A self-hosted agent leaves no log here at all,
        // so this can never be the primary source.
        if (!this.meta.rpcUrl) {
          const start = fresh.find(
            (e) => e.event === "runtime_start" && typeof e.rpcUrl === "string",
          );
          if (start) this.meta.rpcUrl = start.rpcUrl as string;
        }
      }),
    );
  }

  private async readChain(): Promise<{
    chainHeight: number | null;
    recentBlocks: RpcBlock[];
  }> {
    // The public view does not touch the chain: the RPC an audience would need is the competition
    // node itself (issue #74 keeps it closed), and the environment's log already says how far the
    // run is. Heights fall back to the latest round_timing event.
    if (getMode().audience) return { chainHeight: null, recentBlocks: [] };
    const url = this.meta.rpcUrl;
    if (!url) return { chainHeight: null, recentBlocks: [] };
    const heightHex = await rpc<string>(url, "eth_blockNumber", []);
    if (!heightHex) return { chainHeight: null, recentBlocks: [] };
    const height = Number(BigInt(heightHex));
    const wanted = Array.from(
      { length: Math.min(RECENT_BLOCKS, height + 1) },
      (_, i) => height - i,
    );
    const blocks = await Promise.all(
      wanted.map((n) =>
        rpc<RpcBlock>(url, "eth_getBlockByNumber", [
          `0x${n.toString(16)}`,
          true,
        ]),
      ),
    );
    // live fair sample rides the same refresh, pinned to the height it is stamped with
    if (
      this.meta.priceFeed &&
      this.fairSamples[this.fairSamples.length - 1]?.block !== height
    ) {
      const fair = await readFair(url, this.meta.priceFeed, height);
      if (fair !== null) {
        this.fairSamples.push({ block: height, fair });
        if (this.fairSamples.length > 720)
          this.fairSamples = this.fairSamples.slice(-720);
      }
    }
    return {
      chainHeight: height,
      recentBlocks: blocks.filter((b): b is RpcBlock => b !== null),
    };
  }

  private async readIndexerHeight(): Promise<number | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch("/blockscout/api/v2/blocks?type=block", {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const body = (await res.json()) as { items?: { height?: number }[] };
      const height = body.items?.[0]?.height;
      return typeof height === "number" ? height : null;
    } catch {
      return null;
    }
  }

  // The tail offsets are mutable shared state, so two concurrent refreshes would read the same
  // chunk twice and fold every event in it twice (StrictMode's double-mounted effects do exactly
  // this on page load). Concurrent callers share the in-flight refresh instead.
  private inFlight: Promise<LoadedRun> | null = null;

  refresh(): Promise<LoadedRun> {
    this.inFlight ??= this.refreshOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  // One refresh = tail the files, read the chain, assemble a synthetic LoadedRun the ordinary
  // snapshot builders can render.
  private async refreshBlocks(): Promise<void> {
    const text = await tail(this.runId, "blocks.csv", this.blocksTail);
    if (!text) return;
    const combined = this.blocksCarry.partial + text;
    const cut = combined.lastIndexOf("\n");
    // Whole rows only; a row still being written is carried into the next chunk.
    this.blocksCarry.partial = cut < 0 ? combined : combined.slice(cut + 1);
    if (cut < 0) return;
    const fresh = parseBlocksCsv(combined.slice(0, cut));
    if (fresh.length === 0) return;
    if (this.csvFrom === null) this.csvFrom = fresh[0].blockNumber;
    const merged = [...this.csvRows, ...fresh];
    this.csvRows =
      merged.length > BLOCK_ROW_LIMIT ? merged.slice(-BLOCK_ROW_LIMIT) : merged;
  }

  private async refreshMarket(): Promise<void> {
    const text = await tail(this.runId, "market.jsonl", this.marketTail);
    if (!text) return;
    const fresh = parseJsonlChunk<MarketSeriesRow>(text, this.marketCarry);
    if (fresh.length > 0) this.marketRows = [...this.marketRows, ...fresh];
  }

  /**
   * The public view's stress schedule, re-read from the head of the file: the server serves a
   * window only once it has closed, so the line changes under a reader who tailed past it.
   */
  private async refreshSchedule(): Promise<void> {
    const head = await loadRunHeader(this.runId);
    const served = head.filter((e) => e.type === "stress_schedule");
    if (served.length === 0) return;
    this.header.set("stress_schedule", served[served.length - 1]);
  }

  private async refreshOnce(): Promise<LoadedRun> {
    const text = await tail(this.runId, "events.jsonl", this.eventsTail);
    if (text)
      this.foldEvents(parseJsonlChunk<RunEvent>(text, this.eventsCarry));
    const audience = getMode().audience;
    this.refreshes += 1;
    if (audience && this.refreshes % SCHEDULE_REFRESH_EVERY === 1)
      await this.refreshSchedule();
    // Decision logs are not served to the public view (server/runsApi.ts), so there is nothing to
    // tail -- and one 404 per agent per refresh for a field of hundreds is not nothing.
    if (!audience) await this.refreshAgentLogs();
    const [{ chainHeight, recentBlocks }, indexerHeight] = await Promise.all([
      this.readChain(),
      this.readIndexerHeight(),
      this.refreshBlocks(),
      this.refreshMarket(),
    ]);

    // tx attribution: agents by wallet address, methods/venues from tx_submitted events
    const agentByAddress = new Map(
      this.agents.map((a) => [a.address.toLowerCase(), a.id]),
    );
    const submittedByHash = new Map<
      string,
      { ownerId: string; role: string; actionType: string }
    >();
    const events = this.allEvents();
    for (const event of events) {
      if (event.type !== "tx_submitted") continue;
      if (typeof event.hash !== "string") continue;
      submittedByHash.set(event.hash.toLowerCase(), {
        ownerId: str(event.ownerId),
        role: str(event.role),
        actionType: str(event.actionType),
      });
    }
    for (const entries of this.agentLogs.values()) {
      for (const entry of entries) {
        if (
          entry.kind === "mempool" &&
          entry.event === "submitted" &&
          entry.hash
        ) {
          const existing = submittedByHash.get(entry.hash.toLowerCase());
          if (!existing && entry.agentId) {
            submittedByHash.set(entry.hash.toLowerCase(), {
              ownerId: entry.agentId,
              role: "agent",
              actionType: entry.actionType ?? "direct",
            });
          }
        }
      }
    }

    // BlockRow synthesis from the chain's recent blocks, for the blocks blocks.csv has not flushed
    // yet (the coordinator writes it a block behind the head while segmenting, and in bulk at the
    // end otherwise). status is "success" optimistically — receipts per tx are too chatty for a
    // poll loop; the csv row, once written, carries the real one and replaces this.
    const chainRows: BlockRow[] = [];
    let chainFrom: number | null = null;
    for (const block of [...recentBlocks].reverse()) {
      const blockNumber = Number(BigInt(block.number));
      if (chainFrom === null || blockNumber < chainFrom) chainFrom = blockNumber;
      block.transactions.forEach((tx, txIndex) => {
        const submitted = submittedByHash.get(tx.hash.toLowerCase());
        const from = tx.from.toLowerCase();
        const agentId = agentByAddress.get(from);
        chainRows.push({
          blockNumber,
          txIndex,
          hash: tx.hash,
          from,
          priorityFeeWei: "",
          status: "success",
          ownerId:
            submitted?.ownerId ??
            agentId ??
            `${from.slice(0, 6)}…${from.slice(-4)}`,
          role: submitted?.role ?? (agentId ? "agent" : "system"),
          actionType: submitted?.actionType ?? "",
          // Decoded here rather than waiting for blocks.csv (ADR 0021 §4). Same table, so a tx
          // named live keeps its name once the csv row arrives.
          method: methodNameForCalldata(tx.input) ?? "",
        });
      });
    }
    // The csv rows first (they are the record), then whatever the chain adds past them.
    const { rows: blockRows, blocksFrom } = mergeLiveBlocks<BlockRow>({
      csvRows: this.csvRows,
      csvFrom: this.csvFrom,
      csvCapped: this.csvRows.length >= BLOCK_ROW_LIMIT,
      chainRows,
      chainFrom,
    });

    const summaryAgents: SummaryAgent[] = this.agents.map((a) => ({
      id: a.id,
      address: a.address,
      initialValueUsdc: 0,
      finalValueUsdc: 0,
      netPnlUsdc: 0,
      alphaUsdc: 0,
      includedTxCount: 0,
      revertCount: 0,
    }));
    const summary: RunSummary = {
      runId: this.runId,
      mode: "live",
      blockTimeSec: this.meta.blockTimeSec,
      finalFairPriceUsdcPerWeth:
        this.fairSamples[this.fairSamples.length - 1]?.fair,
      agents: summaryAgents,
    };

    // The height the view reflects: the chain when it may be read, else the newest block the files
    // mention -- the last csv row, or the last round_timing.
    const filesHeight = Math.max(
      this.latestEventBlock ?? 0,
      blockRows[blockRows.length - 1]?.blockNumber ?? 0,
    );
    return {
      id: this.runId,
      summary,
      events,
      blockRows,
      // The boundary samples the live scorer writes: coarser than the post-run sweep, but the
      // venue prices the board and the markets page need exist from the first boundary on.
      market: marketFromSampleRows(this.marketRows),
      live: {
        chainHeight: chainHeight ?? (filesHeight > 0 ? filesHeight : null),
        blocksFrom,
        indexerHeight,
        fairSamples: this.fairSamples,
        startedAtMs: this.meta.startedAtMs,
        runSeconds: this.meta.runSeconds,
        runBlocks: this.meta.runBlocks,
      },
    };
  }

  logsFor(agentId: string): AgentLogEntry[] {
    return this.agentLogs.get(agentId) ?? [];
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

const liveRuns = new Map<string, LiveRunState>();

function liveStateFor(runId: string): LiveRunState {
  let state = liveRuns.get(runId);
  if (!state) {
    state = new LiveRunState(runId);
    liveRuns.set(runId, state);
    if (liveRuns.size > 4) {
      const oldest = liveRuns.keys().next().value;
      if (oldest !== undefined && oldest !== runId) liveRuns.delete(oldest);
    }
  }
  return state;
}

/** Refresh and assemble the live run's synthetic LoadedRun (incremental tails + RPC reads). */
export function loadLiveRun(runId: string): Promise<LoadedRun> {
  return liveStateFor(runId).refresh();
}

/** The tailed agent log for a live run (already in memory after loadLiveRun). */
export function liveAgentLog(runId: string, agentId: string): AgentLogEntry[] {
  return liveStateFor(runId).logsFor(agentId);
}
