// Live mode (issue #63 Phase 3): while a run is in progress, runs/<id>/ has no summary.json and no
// reconstructed observations yet — those are post-run artifacts. What does exist live:
//   - events.jsonl, appended every block (run meta, round_timing heights, tx_submitted, stress events)
//   - agents/<id>.jsonl, appended per decision (reasons + submitted-tx self-reports, incl. rpcUrl)
//   - the chain itself (current-block state via JSON-RPC; anvil answers the browser directly)
// This module tails the files incrementally through the dev server's /runs/<id>/tail endpoint,
// reads current-block state over RPC, and assembles a synthetic LoadedRun so the ordinary snapshot
// builders render it. Every reader is best-effort: a live view may be seconds behind and says so
// (each panel carries the block height it reflects).

import type {
  AgentLogEntry,
  BlockRow,
  LoadedRun,
  RunEvent,
  RunSummary,
  SummaryAgent,
} from "./runArtifacts";

const EVENT_LIMIT = 5_000;
const AGENT_LOG_LIMIT = 500;
const RECENT_BLOCKS = 30;

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

async function readFair(
  rpcUrl: string,
  priceFeed: string,
): Promise<number | null> {
  const result = await rpc<string>(rpcUrl, "eth_call", [
    { to: priceFeed, data: LATEST_ANSWER_SELECTOR },
    "latest",
  ]);
  if (!result || result === "0x") return null;
  const answer = Number(BigInt(result)) / PRICE_DECIMALS;
  return answer > 0 ? answer : null;
}

interface RpcBlock {
  number: string;
  transactions: { hash: string; from: string }[];
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
  private readonly agentTails = new Map<
    string,
    { state: TailState; carry: { partial: string } }
  >();

  private events: RunEvent[] = [];
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
    this.events.push(...fresh);
    if (this.events.length > EVENT_LIMIT)
      this.events = this.events.slice(-EVENT_LIMIT);
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
        // the runtime start line names the RPC endpoint every agent talks to
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
    // live fair sample rides the same refresh
    if (this.meta.priceFeed) {
      const fair = await readFair(url, this.meta.priceFeed);
      if (
        fair !== null &&
        this.fairSamples[this.fairSamples.length - 1]?.block !== height
      ) {
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

  // One refresh = tail the files, read the chain, assemble a synthetic LoadedRun the ordinary
  // snapshot builders can render.
  async refresh(): Promise<LoadedRun> {
    const text = await tail(this.runId, "events.jsonl", this.eventsTail);
    if (text)
      this.foldEvents(parseJsonlChunk<RunEvent>(text, this.eventsCarry));
    await this.refreshAgentLogs();
    const [{ chainHeight, recentBlocks }, indexerHeight] = await Promise.all([
      this.readChain(),
      this.readIndexerHeight(),
    ]);

    // tx attribution: agents by wallet address, methods/venues from tx_submitted events
    const agentByAddress = new Map(
      this.agents.map((a) => [a.address.toLowerCase(), a.id]),
    );
    const submittedByHash = new Map<
      string,
      { ownerId: string; role: string; actionType: string }
    >();
    for (const event of this.events) {
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

    // BlockRow synthesis from the chain's recent blocks. status is "success" optimistically —
    // receipts per tx are too chatty for a poll loop; the archived view corrects it after the run.
    const blockRows: BlockRow[] = [];
    for (const block of [...recentBlocks].reverse()) {
      const blockNumber = Number(BigInt(block.number));
      block.transactions.forEach((tx, txIndex) => {
        const submitted = submittedByHash.get(tx.hash.toLowerCase());
        const from = tx.from.toLowerCase();
        const agentId = agentByAddress.get(from);
        blockRows.push({
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
        });
      });
    }

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

    return {
      id: this.runId,
      summary,
      events: this.events,
      blockRows,
      market: null,
      live: {
        chainHeight: chainHeight ?? this.latestEventBlock,
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
