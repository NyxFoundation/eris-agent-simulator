// Run-artifact data provider (issue #63): builds every snapshot the UI consumes from runs/<id>/
// files only — summary.json, events.jsonl, blocks.csv, agents/<id>.jsonl, and (when the run has
// one) the reconstructed market.json with per-venue prices, venue state and tx notionals. No sim
// reads at view time; runs without market.json degrade to the earlier rendering.
//
// Two things this file owns that are worth naming:
//
//   rounds       A round is an evaluation interval of the rules (§0.1), not a run. summary.json's
//                valueSeries.epochSeries carries the boundaries and the per-agent value at each,
//                so a per-round result is a read of the recorded series, not a re-derivation. The
//                score itself is one number per run (rules §4.4.1: P = V_K − V_0, standardised
//                over the field), imported from core.
//   venue panels What each deployed application is doing. The AMM quotes and depth, GMX open
//                interest and funding, and the Aave reserve totals come from market.json; the LST
//                vault and the Liquity system are emitted per block by the coordinator into
//                events.jsonl (lst_block / liquity_block) and are read from there.

import { scoreEpoch } from "@core/scoring/deviationScore";
import { coversWindow } from "./liveBlocks";
import { liveAgentLog, loadLiveRun } from "./liveRun";
import { getMode, loadMode } from "./mode";
import { scenarioAgentP } from "./scenarioP";
import {
  loadAllAgentLogs,
  loadRun,
  listRuns,
  runEntries,
  type AgentLogEntry,
  type LoadedRun,
  type MarketSeriesFile,
  type RunEvent,
} from "./runArtifacts";
import {
  blockSeriesOf,
  downsample,
  enabledProtocols,
  eventOfType,
  lastEventOfType,
  formatUsd,
  fromWei,
  num,
  shortAddress,
  str,
  VENUE_COLORS,
  VENUE_LABELS,
  type TxInfo,
} from "./artifactHelpers";
import { t } from "@/i18n/messages";
import { buildScenarioPanel, buildVenuePanels } from "./venuePanels";
import { getReplay, replayHeadFor } from "./replay";
import { venueOfTx, WORLD_VENUES } from "./worldVenues";
import { getSelectedRound } from "./roundSelection";
import { getSelectedRunId } from "./runSelection";
import type {
  AgentDetail,
  AgentDetailSnapshot,
  AgentLogLine,
  AgentPosition,
  AgentRoundResult,
  AgentStanding,
  AgentTrade,
  ArbitrageSnapshot,
  ArbTradeMarker,
  Candle,
  ExplorerBlock,
  ExplorerSnapshot,
  ExplorerTransaction,
  MarketFeedItem,
  MarketSnapshot,
  RoundAgentResult,
  RoundEpoch,
  RoundInfo,
  StrategyCategory,
  TapeTone,
  VenueDepthView,
  WorldAgentNode,
  WorldBoundary,
  WorldFrame,
  WorldLogLine,
  WorldSnapshot,
  WorldTx,
  WorldVenueNode,
} from "./types";

// ---------------------------------------------------------------------------
// run resolution

type ResolvedRun = LoadedRun;

async function resolveRun(): Promise<ResolvedRun> {
  // The mode decides what the builders below may read (decision logs, the chain); until the server
  // has said, the restricted reading applies, and a first snapshot built under it would carry a
  // stale answer for as long as its key lasts.
  await loadMode();
  // Matrix dirs share the index with runs but hold no run artifacts, so they are never a candidate
  // here — loading one as a run would 404 on summary.json.
  const runs = runEntries(await listRuns());
  if (runs.length === 0) {
    throw new Error(t("err.noRuns"));
  }
  const selected = getSelectedRunId();
  const index = Math.max(
    0,
    runs.findIndex((r) => r.id === selected),
  );
  const entry = runs[index === -1 ? 0 : index];
  // A live run has no summary.json yet — its state is tailed and read from the chain instead of
  // loaded from artifacts (issue #63 Phase 3), and nothing about it is cached across refreshes.
  return entry.live ? loadLiveRun(entry.id) : loadRun(entry.id);
}

// The tailed in-memory logs for a live run; the on-disk artifacts otherwise. The artifact loader
// caches whole files, which is exactly wrong while they are still being appended to.
async function agentLogsFor(
  run: LoadedRun,
): Promise<Map<string, AgentLogEntry[]>> {
  const ids = (run.summary.agents ?? []).map((a) => a.id);
  // The public view is not served decision logs (server/runsApi.ts audience mode), and a field of
  // hundreds of agents would be hundreds of 404s per snapshot. Everything built off the logs -- the
  // venue label on a trade, the arbitrage markers -- degrades to nothing, as it already does for a
  // self-hosted participant.
  if (getMode().audience) return new Map(ids.map((id) => [id, []]));
  if (run.live) return new Map(ids.map((id) => [id, liveAgentLog(run.id, id)]));
  return loadAllAgentLogs(run.id, ids);
}

// ---------------------------------------------------------------------------
// shared derivations

interface RegisteredAgent {
  id: string;
  address: string;
  baseline?: boolean;
  description?: string;
  /**
   * ADR 0021 §2: a participant who runs the agent on their own machine. Their decision log and
   * their mempool self-reports are on that machine and never reach here, so the panels fed by
   * those say so rather than rendering empty (§4 / axis C2).
   */
  external?: boolean;
}

function registeredAgents(run: LoadedRun): Map<string, RegisteredAgent> {
  // The last one: registrations that arrive mid-period re-emit the full roster (ADR 0021 §2).
  const event = lastEventOfType(run.events, "agents_registered");
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

/**
 * The run's first competition block.
 *
 * Order matters, because a live run has none of the first three. A scored run says so in its value
 * series; a closed segment in its summary; a segment that is not the first in its own header. A run
 * still going has only what it has already written -- the first block its event stream mentions --
 * and its block rows, which a live view may hold only the newest of. The old fall-through to 0 is
 * what printed `blocks 0-0` across the explorer and the board for a whole period (issue #84 A).
 */
function firstBlock(run: LoadedRun): number {
  return (
    run.summary.valueSeries?.fromBlock ??
    run.summary.fromBlock ??
    segmentStart(run) ??
    firstEventBlock(run) ??
    run.blockRows[0]?.blockNumber ??
    0
  );
}

/** The block a segment opened at, from its own header (absent on a run's first segment). */
function segmentStart(run: LoadedRun): number | undefined {
  const started = eventOfType(run.events, "run_started_realtime");
  const from = Number(started?.fromBlock);
  return Number.isFinite(from) && from > 0 ? from : undefined;
}

function lastBlock(run: LoadedRun): number {
  return (
    run.summary.valueSeries?.toBlock ??
    run.summary.toBlock ??
    run.live?.chainHeight ??
    run.blockRows[run.blockRows.length - 1]?.blockNumber ??
    0
  );
}

// ---------------------------------------------------------------------------
// rounds (= scoring epochs)

/** Rank ids by a value, descending; ids without a value are left out. */
function rankBy(
  ids: string[],
  valueOf: (id: string) => number | null,
): Map<string, number> {
  const scored = ids.flatMap((id) => {
    const value = valueOf(id);
    return value === null ? [] : [{ id, value }];
  });
  scored.sort((a, b) => b.value - a.value);
  return new Map(scored.map((s, i) => [s.id, i + 1]));
}

/**
 * The run's rounds. Archived runs read the scored epoch series; a live run only knows the epoch
 * length (the coordinator now records it at run start), so its rounds carry block ranges and a
 * progress status but no results — those are post-run artifacts by design (ADR 0006 §4).
 */
function buildEpochs(
  run: LoadedRun,
  chainHeight: number | null,
  // Replay head. When set, a round that has not closed by this block is not "done" and carries no
  // result: showing a scored round the replay has not reached yet would print the answer on every
  // frame of the walk.
  headBlock: number | null = null,
): RoundEpoch[] {
  const txPerBlock = new Map<number, number>();
  for (const row of run.blockRows)
    txPerBlock.set(row.blockNumber, (txPerBlock.get(row.blockNumber) ?? 0) + 1);
  // A live run's block rows cover a range -- the tail of blocks.csv, or a recent RPC window -- and
  // a round that starts before it has no count to report: reporting 0 would say "nothing happened
  // here", which is a different claim from "this view cannot see it". The range is what the view
  // fetched, not where its first transaction happens to sit (issue #84 I).
  //
  // No range at all on a live run (nothing flushed yet, no chain reachable) means *no* round has a
  // count — not that every round was quiet. Infinity puts every window before the held one.
  const covered = (fromBlock: number) =>
    coversWindow(fromBlock, run.live?.blocksFrom ?? null, run.live !== undefined);
  const txBetween = (
    from: number,
    to: number,
    started: boolean,
  ): number | null => {
    if (!started) return 0; // a round that has not begun really has no transactions
    if (!covered(from)) return null;
    let count = 0;
    for (const [block, n] of txPerBlock)
      if (block > from && block <= to) count += n;
    return count;
  };

  const notable = notableEvents(run);
  const eventsBetween = (from: number, to: number) =>
    notable
      .filter((e) => {
        const block = Number(e.blockNumber);
        return Number.isFinite(block) && block > from && block <= to;
      })
      .slice(0, 8)
      .map((e) => {
        const rule = TAPE_RULES[e.type];
        const value = rule.value(e);
        return {
          time: `blk ${Number(e.blockNumber).toLocaleString("en-US")}`,
          text: `${rule.body(e)}${value ? ` (${value})` : ""}`,
        };
      });

  const epochSeries = run.summary.valueSeries?.epochSeries;
  const boundaries = epochSeries?.boundaryBlocks ?? [];

  if (boundaries.length >= 2) {
    const valuesByAgent = epochSeries?.valuesByAgent ?? {};
    const ids = (run.summary.agents ?? []).map((a) => a.id);
    const valueAt = (id: string, boundary: number): number | null =>
      valuesByAgent[id]?.[boundary] ?? null;
    const cumulativeRankAt = (boundary: number) =>
      rankBy(ids, (id) => {
        const start = valueAt(id, 0);
        const now = valueAt(id, boundary);
        return start === null || now === null ? null : now - start;
      });

    const cumulativeRanks = boundaries.map((_, i) => cumulativeRankAt(i));

    return boundaries.slice(1).map((toBlock, i) => {
      const fromBlock = boundaries[i];
      const index = i + 1;
      const roundRank = rankBy(ids, (id) => {
        const before = valueAt(id, i);
        const after = valueAt(id, index);
        return before === null || after === null ? null : after - before;
      });
      const results: RoundAgentResult[] = ids.map((id) => {
        const before = valueAt(id, i);
        const after = valueAt(id, index);
        const previousRank = cumulativeRanks[i].get(id);
        const currentRank = cumulativeRanks[index].get(id);
        // Context, not the score: the raw log return of account value over this round.
        const logReturn =
          before !== null && after !== null && before > 0 && after > 0
            ? Math.log(after / before)
            : 0;
        return {
          agent: id,
          rank: roundRank.get(id) ?? ids.length,
          deltaUsdc: before !== null && after !== null ? after - before : 0,
          logReturnBps: logReturn * 10_000,
          cumulativeRank: currentRank ?? ids.length,
          // The first round has no previous close to move against, and the boundary-0 ranking is
          // an all-zero tie — reporting a move off it would be an artifact of the sort order.
          move:
            index > 1 && previousRank !== undefined && currentRank !== undefined
              ? previousRank - currentRank
              : 0,
          // Rules §4.5: asset value at or below zero. No floor and no freeze -- the agent keeps
          // trading and its later rounds count.
          bankrupt: after !== null && after <= 0,
        };
      });
      results.sort((a, b) => a.rank - b.rank);
      const status =
        headBlock === null || headBlock >= toBlock
          ? ("done" as const)
          : headBlock > fromBlock
            ? ("live" as const)
            : ("upcoming" as const);
      return {
        index,
        fromBlock,
        toBlock,
        status,
        results: status === "done" ? results : [],
        events:
          status === "upcoming"
            ? []
            : eventsBetween(fromBlock, Math.min(toBlock, headBlock ?? toBlock)),
        txCount: txBetween(
          fromBlock,
          Math.min(toBlock, headBlock ?? toBlock),
          status !== "upcoming",
        ),
      };
    });
  }

  // Live (or an unscored run): lay the rounds out from the configured epoch length.
  const started = eventOfType(run.events, "run_started_realtime");
  const epochBlocks = Number(started?.epochBlocks ?? 0);
  const runBlocks = Number(started?.runBlocks ?? 0);
  const start = firstEventBlock(run);
  if (!(epochBlocks >= 1) || !(runBlocks >= epochBlocks) || start === null)
    return [];
  const count = Math.floor(runBlocks / epochBlocks);
  const height = chainHeight ?? lastBlock(run);
  return Array.from({ length: count }, (_, i) => {
    const fromBlock = start + i * epochBlocks;
    const toBlock = fromBlock + epochBlocks;
    const status =
      height >= toBlock
        ? ("done" as const)
        : height > fromBlock
          ? ("live" as const)
          : ("upcoming" as const);
    return {
      index: i + 1,
      fromBlock,
      toBlock,
      status,
      results: [],
      events: eventsBetween(fromBlock, toBlock),
      txCount: txBetween(fromBlock, toBlock, status !== "upcoming"),
    };
  });
}

/**
 * The first block the run's own event stream mentions — the live stand-in for valueSeries.fromBlock.
 *
 * `round_timing` is written once per processed block from the first one on, so its earliest entry
 * is the run's first block. An epoch boundary is the fallback for a stream long enough that the
 * early lines have fallen off the tail's cap: boundary 0 sits on the run's first block.
 */
function firstEventBlock(run: LoadedRun): number | null {
  for (const event of run.events) {
    if (event.type !== "round_timing") continue;
    const block = Number(event.blockNumber);
    if (Number.isFinite(block)) return block;
  }
  for (const event of run.events) {
    if (event.type !== "epoch_boundary") continue;
    const block = Number(event.blockNumber);
    if (Number.isFinite(block) && Number(event.index) === 0) return block;
  }
  const first = run.blockRows[0]?.blockNumber;
  return first ?? null;
}

function buildRound(run: ResolvedRun): RoundInfo {
  const chainHeight = run.live?.chainHeight ?? null;
  const replay = replayHeadFor(run.id) === null ? null : getReplay();
  const epochs = buildEpochs(run, chainHeight, replay ? replay.block : null);
  const epochBlocks =
    run.summary.valueSeries?.epochSeries?.epochBlocks ??
    Number(eventOfType(run.events, "run_started_realtime")?.epochBlocks ?? 0);

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
      runId: run.id,
      status: "live",
      startsAt,
      endsAt: startsAt + durationSec * 1000,
      blockNumber: chainHeight ?? lastBlock(run),
      epochs,
      epochBlocks,
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
    runId: run.id,
    status: replay ? "replay" : "archived",
    startsAt,
    endsAt,
    blockNumber: replay ? replay.block : lastBlock(run),
    epochs,
    epochBlocks,
    ...(replay
      ? {
          replay: {
            block: replay.block,
            fromBlock: replay.fromBlock,
            toBlock: replay.toBlock,
            playing: replay.playing,
            speed: replay.speed,
          },
        }
      : {}),
  };
}

function maxDrawdownPercent(values: Array<number | null>): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of values) {
    if (value === null) continue;
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

function buildStandings(
  run: LoadedRun,
  epochs: RoundEpoch[],
  // Replay: P is read through this many closed rounds, and the field is standardised on that.
  // Reading the finished run's figure instead would show the outcome before the walk reaches it.
  replaying = false,
): AgentStanding[] {
  const registered = registeredAgents(run);
  const valuesByAgent =
    run.summary.valueSeries?.epochSeries?.valuesByAgent ?? {};
  const agents = run.summary.agents ?? [];

  const closed = epochs.filter((e) => e.status === "done").length;

  // The rank move over the last closed round. There is no cross-run concept here: one run is one
  // epoch of the competition.
  const lastClosed = epochs.filter((e) => e.status === "done").pop();
  const moves = new Map(
    (lastClosed?.results ?? []).map((r) => [r.agent, r.move]),
  );

  // P for this epoch (rules §4.4.1): the summary's own figure for the whole run, or V_closed − V_0
  // while replaying. An agent the run did not place -- no V_0, a mid-segment registration -- has
  // no P and no net PnL to show, and is not in the population (issue #84 X2).
  const pnlByAgent: Record<string, number> = {};
  const netPnl = new Map<string, number | null>();
  const drawdown = new Map<string, Array<number | null>>();
  for (const agent of agents) {
    const values = valuesByAgent[agent.id] ?? [];
    let p: number | undefined;
    let net: number | null =
      agent.scored === false ? null : (agent.netPnlUsdc ?? null);
    let dd: Array<number | null> = values;
    if (replaying) {
      const start = values[0];
      const now = values[closed];
      if (start != null && now != null) {
        p = now - start;
        net = p;
      } else if (closed === 0) net = start == null ? null : 0;
      else net = null;
      dd = values.slice(0, closed + 1);
    } else {
      p = scenarioAgentP(agent, values.length >= 2 ? values : undefined);
      if (p === undefined) net = null;
    }
    if (p !== undefined && Number.isFinite(p)) pnlByAgent[agent.id] = p;
    netPnl.set(agent.id, net);
    drawdown.set(agent.id, dd);
  }
  const benchmarkIds = agents.filter((a) => a.baseline).map((a) => a.id);
  // One run is one epoch, so T over its own field is exactly the rules' figure for it (§4.4.1).
  // The benchmark is valued and shown but not in the population (§4.3): its T is null.
  const epoch = scoreEpoch({ s: 1, pnlByAgent, benchmarkIds }, 1);

  const rows = agents.map((agent) => {
    const description = registered.get(agent.id)?.description ?? agent.id;
    return {
      rank: 0,
      agent: agent.id,
      score: epoch.tByAgent[agent.id] ?? null,
      netPnlUsdc: netPnl.get(agent.id) ?? null,
      unscored: agent.scored === false || !(agent.id in pnlByAgent),
      strategy: description,
      strategyCategory: categorize(agent.id, description),
      maxDrawdownPercent: maxDrawdownPercent(drawdown.get(agent.id) ?? []),
      move: moves.get(agent.id) ?? 0,
    };
  });

  rows.sort(
    (a, b) =>
      (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
      (b.netPnlUsdc ?? -Infinity) - (a.netPnlUsdc ?? -Infinity),
  );
  return rows.map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * Where a live run is in its rounds, for the competition header (issue #84 C): the round in
 * progress, how many the run has, and when the current one closes at the chain's cadence.
 */
export function liveProgress(run: LoadedRun): {
  round: number;
  rounds: number;
  /** Wall-clock estimate of the current round's close, from the chain height and cadence. */
  roundEndsAtMs: number | null;
  blockNumber: number;
} | null {
  if (!run.live) return null;
  const chainHeight = run.live.chainHeight;
  const epochs = buildEpochs(run, chainHeight, null);
  if (epochs.length === 0) return null;
  const current =
    epochs.find((e) => e.status === "live") ??
    epochs.filter((e) => e.status === "done").pop() ??
    epochs[0];
  const blockNumber = chainHeight ?? lastBlock(run);
  const blockTimeSec = run.summary.blockTimeSec ?? 2;
  const remaining = Math.max(0, current.toBlock - blockNumber);
  return {
    round: current.index,
    rounds: epochs.length,
    roundEndsAtMs: Date.now() + remaining * blockTimeSec * 1000,
    blockNumber,
  };
}

// ---------------------------------------------------------------------------
// formatting helpers

function clockTime(ts: string | undefined): string {
  return ts ? ts.slice(11, 19) : "—";
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

/** "t+42s" — block offset from the run's first block, in chain time. */
function blockClock(run: LoadedRun, blockNumber: number): string {
  const blockTimeSec = run.summary.blockTimeSec ?? 1;
  return `t+${(blockNumber - firstBlock(run)) * blockTimeSec}s`;
}

// ---------------------------------------------------------------------------
// tape / archive events

interface TapeRule {
  /** Resolved lazily so the ticker follows the current language. */
  kind: () => string;
  tone: TapeTone;
  body: (e: RunEvent) => string;
  value: (e: RunEvent) => string;
}

const TAPE_RULES: Record<string, TapeRule> = {
  run_started_realtime: {
    kind: () => t("tape.kind.run"),
    tone: "neutral",
    body: (e) =>
      t("tape.runStarted", {
        protocols: ((e.enabledProtocols as string[]) ?? []).join(" "),
      }),
    value: (e) => t("tape.blocksN", { n: num(e.runBlocks) }),
  },
  stress_schedule: {
    kind: () => t("tape.kind.scenario"),
    tone: "accent",
    body: (e) => {
      const events = (e.events as { type?: string }[] | undefined) ?? [];
      return t("tape.schedule", {
        types: events.map((s) => s.type).join(", "),
      });
    },
    value: (e) =>
      t("tape.eventsN", { n: ((e.events as unknown[]) ?? []).length }),
  },
  stress_victim_hf: {
    kind: () => t("tape.kind.victimHf"),
    tone: "down",
    body: (e) =>
      t("tape.victimHf", {
        block: num(e.blockNumber).toLocaleString("en-US"),
      }),
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
    kind: () => t("tape.kind.liquidation"),
    tone: "down",
    body: (e) =>
      t("tape.liquidation", {
        block: num(e.blockNumber).toLocaleString("en-US"),
      }),
    value: () => "",
  },
  stress_liquidity_pull: {
    kind: () => t("tape.kind.liquidity"),
    tone: "down",
    body: (e) =>
      t("tape.liquidityPull", {
        venue: str(e.venue),
        market: str(e.market),
        direction: str(e.direction),
      }),
    value: (e) => `×${num(e.depthMultiplier).toFixed(2)}`,
  },
  stress_liquidity_restored: {
    kind: () => t("tape.kind.liquidity"),
    tone: "up",
    body: (e) => t("tape.liquidityRestored", { venue: str(e.venue) }),
    value: () => "",
  },
  stress_eusd_depeg: {
    kind: () => t("tape.kind.depeg"),
    tone: "down",
    body: (e) =>
      t("tape.eusdDepeg", {
        block: num(e.blockNumber).toLocaleString("en-US"),
      }),
    value: () => "",
  },
  stress_depeg: {
    kind: () => t("tape.kind.depeg"),
    tone: "down",
    body: (e) =>
      t("tape.depeg", {
        stable: str(e.stable),
        block: num(e.blockNumber).toLocaleString("en-US"),
      }),
    value: () => "",
  },
  lst_slash: {
    kind: () => t("tape.kind.lstSlash"),
    tone: "down",
    body: (e) =>
      t("tape.lstSlash", {
        before: num(e.redemptionRateBefore).toFixed(4),
        after: num(e.redemptionRateAfter).toFixed(4),
      }),
    value: (e) => `${num(e.bps).toFixed(0)}bps`,
  },
  liquity_liquidation: {
    kind: () => t("tape.kind.trove"),
    tone: "down",
    body: (e) => t("tape.trove", { borrower: shortAddress(str(e.borrower)) }),
    value: (e) => `${(fromWei(e.debtEusdWei) ?? 0).toFixed(0)} eUSD`,
  },
  liquity_redemption: {
    kind: () => t("tape.kind.redemption"),
    tone: "purple",
    body: (e) =>
      t("tape.redemption", {
        block: num(e.blockNumber).toLocaleString("en-US"),
      }),
    value: (e) => `${(fromWei(e.actualEusdWei) ?? 0).toFixed(0)} eUSD`,
  },
  no_arb_persistent_warning: {
    kind: () => t("tape.kind.arbWindow"),
    tone: "purple",
    body: (e) =>
      t("tape.arbWindow", {
        base: str(e.base),
        buy: str(e.buyVenue),
        sell: str(e.sellVenue),
      }),
    value: (e) => `${num(e.profitBps).toFixed(0)}bps`,
  },
  run_completed: {
    kind: () => t("tape.kind.run"),
    tone: "neutral",
    body: () => t("tape.runCompleted"),
    value: () => "",
  },
};

const TAPE_PER_TYPE = 6;
const TAPE_TOTAL = 32;

/** The run's notable environment events, a few per kind: what a round's result panel lists. */
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

// ---------------------------------------------------------------------------
// blocks / transactions

function groupBlocks(
  rows: LoadedRun["blockRows"],
): { blockNumber: number; txCount: number }[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
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

/**
 * hash → the venue an agent said it was trading. Kept for the *venue* label only: the method now
 * comes off the chain (ADR 0021 §4), and this join is a nicety that simply produces nothing for a
 * participant who runs their own agent — where before it produced nothing and the method was blank
 * with it.
 */
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

/**
 * What a transaction did.
 *
 * The chain first (ADR 0021 §4): `method` is decoded from the tx's own calldata, so it is there for
 * every sender including a participant whose agent nobody here started. The self-reported action
 * type is the fallback, and it says something slightly different — what the sender *meant*, at the
 * level of an Eris action rather than a contract call ("swap" the intent, versus
 * "exactInputSingle" the function). Both are worth having; only one of them exists for everybody.
 */
function methodOf(
  row: { actionType: string; role: string; hash: string; method?: string },
  infoByHash: Map<string, TxInfo>,
): string {
  if (row.method) return row.method;
  return row.actionType === "direct"
    ? (infoByHash.get(row.hash.toLowerCase())?.method ?? "direct")
    : row.actionType || row.role;
}

function notionalAmount(run: LoadedRun, hash: string): string {
  return run.market?.notionals[hash.toLowerCase()]?.amount ?? "—";
}

function buildTransactions(
  run: LoadedRun,
  rows: LoadedRun["blockRows"],
  infoByHash: Map<string, TxInfo>,
  limit: number,
): ExplorerTransaction[] {
  return rows
    .slice(-limit)
    .reverse()
    .map((row, i) => {
      const method = methodOf(row, infoByHash);
      const failed = row.status !== "success";
      return {
        seq: i,
        hash: shortHash(row.hash),
        fullHash: row.hash,
        fullAddress: row.from,
        blockNumber: row.blockNumber,
        // A sender the coordinator does not know (a participant on the trial devnet who is not on
        // the roster) is recorded under its address (role "external"); shown short, the way the
        // live view already shows an unattributed sender.
        agent:
          row.role === "external"
            ? `${row.from.slice(0, 6)}…${row.from.slice(-4)}`
            : row.ownerId,
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

// matches venue-arb's ROUND_TRIP_COST: one venue fee in, one out, plus slippage
const ARB_THRESHOLD_BPS = 80;

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
  base = "WETH",
): ArbitrageSnapshot {
  if (run.market) {
    const fromMarket = buildArbitrageFromMarket(
      run,
      run.market,
      infoByHash,
      base,
    );
    if (fromMarket) return fromMarket;
  }
  // Phase 1 fallback (runs recorded before market.json existed): the one pool reference price the
  // reconstructed observations carry. WETH only — other bases exist only via market.json.
  const prices =
    base === "WETH" ? downsample(observationSeries(run).prices, 720) : [];
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
  const live = downsample(fairSeriesForBase(run, base), 720);
  return {
    fair: live.map((p) => ({ time: p.block, price: p.fair })),
    venues: [],
    spread: [],
    thresholdBps: ARB_THRESHOLD_BPS,
    trades: [],
  };
}

function buildFeed(
  logs: Map<string, AgentLogEntry[]>,
  // The agent logs are not part of the scoped run (they are files, not events), so the round window
  // is applied here — otherwise the feed would be the only panel still showing the whole run.
  epoch?: RoundEpoch,
  // Replay head: the same reason, for the same reason.
  headBlock?: number,
): MarketFeedItem[] {
  const submitted: { ts: string; text: string }[] = [];
  for (const [agentId, entries] of logs) {
    for (const entry of entries) {
      if (
        epoch &&
        (typeof entry.blockSeen !== "number" ||
          entry.blockSeen <= epoch.fromBlock ||
          entry.blockSeen > epoch.toBlock)
      )
        continue;
      if (
        headBlock !== undefined &&
        (typeof entry.blockSeen !== "number" || entry.blockSeen > headBlock)
      )
        continue;
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

// AMM depth per venue for the base — the order book replacement (issue #63 Phase 4): every venue
// is an AMM, so what exists is pool depth and an executable two-sided quote, not resting orders.
function buildVenueDepths(run: LoadedRun, base: string): VenueDepthView[] {
  const market = run.market;
  if (!market) return [];
  return market.venues.flatMap((venue) => {
    const rows = market.series.flatMap((r) => {
      const sample = r.venues?.[venue]?.[base];
      return sample?.depthUsd !== undefined
        ? [{ depthUsd: sample.depthUsd, buy: sample.buy, sell: sample.sell }]
        : [];
    });
    if (rows.length === 0) return [];
    const first = rows[0];
    const lastRow = rows[rows.length - 1];
    const deltaPercent =
      first.depthUsd > 0
        ? ((lastRow.depthUsd - first.depthUsd) / first.depthUsd) * 100
        : 0;
    return [
      {
        id: venue,
        label: VENUE_LABELS[venue] ?? venue,
        color: VENUE_COLORS[venue] ?? "#7c9eff",
        depthUsd: formatUsd(lastRow.depthUsd),
        deltaPercent: Math.round(deltaPercent * 10) / 10,
        points: downsample(rows, 60).map((r) => r.depthUsd),
        ...(lastRow.buy !== undefined ? { buy: formatUsd(lastRow.buy) } : {}),
        ...(lastRow.sell !== undefined
          ? { sell: formatUsd(lastRow.sell) }
          : {}),
      },
    ];
  });
}

// Fair series for an arbitrary base: WETH keeps the fine-grained observation series (with the live
// fallback); other bases exist only in the reconstructed market series.
function fairSeriesForBase(
  run: LoadedRun,
  base: string,
): { block: number; fair: number }[] {
  if (base === "WETH") return fairSeries(run);
  return (run.market?.series ?? []).flatMap((r) => {
    const fair = r.fair[base];
    return fair !== undefined && fair > 0 ? [{ block: r.block, fair }] : [];
  });
}

function candlesFor(prices: { block: number; fair: number }[]): Candle[] {
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

// ---------------------------------------------------------------------------
// per-agent positions

/** Every venue position market.json recorded for one agent at the run's final block. */
function buildAgentPositions(
  run: LoadedRun,
  agentId: string,
  lastFairByBase: Record<string, number>,
): AgentPosition[] {
  const market = run.market;
  if (!market) return [];
  const out: AgentPosition[] = [];

  // GMX perps: marked against their own base's final fair — a WBTC perp priced off the WETH fair
  // would be off by an order of magnitude.
  for (const p of market.gmxPositionsAtEnd) {
    if (p.agent !== agentId) continue;
    const lastFair = lastFairByBase[p.base] ?? 0;
    const pnlPercent =
      p.entryPriceUsd && p.entryPriceUsd > 0 && lastFair > 0
        ? Math.round(
            (lastFair / p.entryPriceUsd - 1) * 100 * (p.isLong ? 1 : -1) * 10,
          ) / 10
        : 0;
    out.push({
      market: `GMX ${p.base}/USDC`,
      kind: p.isLong ? t("vp.side.long") : t("vp.side.short"),
      tone: p.isLong ? "up" : "down",
      size: formatUsd(p.sizeUsd),
      mark: p.entryPriceUsd
        ? t("pos.entry", {
            v: p.entryPriceUsd.toLocaleString("en-US", {
              maximumFractionDigits: 1,
            }),
          })
        : t("pos.entryNone"),
      note: t("pos.collateralNote", { v: formatUsd(p.collateralUsd) }),
      pnlPercent,
    });
  }

  // The LST vault: the shares' par and the withdrawal queue behind it. The queue is the position's
  // real constraint — par you cannot reach yet is not the same asset as par you can.
  for (const p of market.lstPositionsAtEnd ?? []) {
    if (p.agent !== agentId) continue;
    const queued = p.claimableWeth + p.pendingWeth;
    out.push({
      market: "LST vault",
      kind: t("pos.kind.stake"),
      tone: "neutral",
      size: `${p.shares.toFixed(4)} LST`,
      mark: t("pos.par", { v: p.shareAssetsWeth.toFixed(4) }),
      note:
        queued > 0
          ? t(p.openRequests === 1 ? "pos.queueOne" : "pos.queue", {
              claimable: p.claimableWeth.toFixed(4),
              pending: p.pendingWeth.toFixed(4),
              n: p.openRequests,
            })
          : t("pos.noQueue"),
    });
  }

  // The CDP: a Trove is a debt against collateral with a liquidation line; the Stability Pool
  // deposit and a spot eUSD balance are separate claims on the same venue.
  for (const p of market.liquityPositionsAtEnd ?? []) {
    if (p.agent !== agentId) continue;
    if (p.troveDebtEusd > 0 || p.troveCollWeth > 0) {
      out.push({
        market: "Liquity Trove",
        kind: t("pos.kind.debt"),
        tone: p.icr !== null && p.icr < 1.1 ? "down" : "neutral",
        size: `${p.troveDebtEusd.toLocaleString("en-US", { maximumFractionDigits: 0 })} eUSD`,
        mark: p.icr !== null ? `ICR ${p.icr.toFixed(3)}` : t("pos.icrNone"),
        note: t("pos.troveNote", { coll: p.troveCollWeth.toFixed(3) }),
      });
    }
    if (p.stabilityDepositEusd > 0) {
      out.push({
        market: "Liquity Stability Pool",
        kind: t("pos.kind.deposit"),
        tone: "neutral",
        size: `${p.stabilityDepositEusd.toLocaleString("en-US", { maximumFractionDigits: 0 })} eUSD`,
        mark: t("pos.spMark"),
        note: t("pos.spNote"),
      });
    }
    if (p.eusdBalance > 0) {
      out.push({
        market: t("pos.eusdSpot"),
        kind: t("pos.kind.hold"),
        tone: "neutral",
        size: `${p.eusdBalance.toLocaleString("en-US", { maximumFractionDigits: 2 })} eUSD`,
        mark: `${(lastRowStable(run, "EUSD") ?? 1).toFixed(4)} USDC`,
        note: t("pos.eusdNote"),
      });
    }
  }

  // Aave: the account totals the pool itself reports, health factor included.
  for (const a of market.aaveAccountsAtEnd) {
    if (a.agent !== agentId) continue;
    out.push({
      market: t("pos.aave"),
      kind: a.debtUsd > 0 ? t("pos.kind.borrow") : t("pos.kind.supply"),
      tone:
        a.healthFactor !== null && a.healthFactor < 1.1 ? "down" : "neutral",
      size: formatUsd(a.collateralUsd),
      mark:
        a.healthFactor === null ? "HF ∞" : `HF ${a.healthFactor.toFixed(3)}`,
      note:
        a.debtUsd > 0
          ? t("pos.debtNote", { v: formatUsd(a.debtUsd) })
          : t("pos.noDebt"),
    });
  }

  return out;
}

/** The final market-priced quote for a stable, when the run recorded one. */
function lastRowStable(run: LoadedRun, symbol: string): number | undefined {
  const rows = run.market?.series ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const sample = rows[i].stables?.[symbol];
    if (sample?.quoted) return sample.priceUsdc;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// round scoping
//
// A round is the unit a result is earned in, so "what did the venues do in round 4" has to be
// answerable — the whole-run series answers a different question. Scoping is done by narrowing the
// run itself rather than by threading a block range through every builder: the builders already
// derive everything from run.events / run.blockRows / run.market.series, so a narrowed run gives
// them a narrowed window with no second code path to keep honest.

/** Where a run event's block number lives. Observations carry theirs inside the observation. */
function eventBlockOf(event: RunEvent): number | null {
  if (typeof event.blockNumber === "number") return event.blockNumber;
  const obs = event.observation as
    { blockNumber?: number | string } | undefined;
  const block = Number(obs?.blockNumber);
  return Number.isFinite(block) ? block : null;
}

/**
 * The same run, seen through one round's block window. Events without a block (run start, venue
 * setup) are kept: they describe the run, not a moment in it, and the panels need them to say what
 * the vault's APY or the withdrawal delay was.
 */
function scopeRunToBlocks(
  run: ResolvedRun,
  fromBlock: number,
  toBlock: number,
): ResolvedRun {
  const inRange = (b: number) => b > fromBlock && b <= toBlock;

  const blockRows = run.blockRows.filter((r) => inRange(r.blockNumber));
  const events = run.events.filter((e) => {
    const block = eventBlockOf(e);
    return block === null || inRange(block);
  });

  let market = run.market;
  if (market) {
    const series = market.series.filter((r) => inRange(r.block));
    // Notionals are keyed by hash with no block of their own, so they are narrowed through the
    // scoped rows — otherwise a round's "swap volume" would quietly be the whole run's.
    const hashes = new Set(blockRows.map((r) => r.hash.toLowerCase()));
    const notionals = Object.fromEntries(
      Object.entries(market.notionals).filter(([hash]) => hashes.has(hash)),
    );
    market = {
      ...market,
      fromBlock: series[0]?.block ?? fromBlock,
      toBlock: series[series.length - 1]?.block ?? toBlock,
      series,
      notionals,
    };
  }

  return { ...run, events, blockRows, market };
}

/**
 * The run as it stood at the replay head, or unchanged when this run is not being replayed.
 *
 * The end-of-run position cross-sections are dropped while the head is short of the end: they are a
 * single read taken when the run finished and are not knowable at an earlier block, so carrying them
 * through would put the run's closing positions on every frame of the walk.
 */
function clampToReplay(run: ResolvedRun): ResolvedRun {
  const head = replayHeadFor(run.id);
  if (head === null) return run;
  const clamped = scopeRunToBlocks(run, firstBlock(run) - 1, head);
  if (head >= lastBlock(run) || !clamped.market) return clamped;
  return {
    ...clamped,
    market: {
      ...clamped.market,
      gmxPositionsAtEnd: [],
      aaveAccountsAtEnd: [],
      lstPositionsAtEnd: [],
      liquityPositionsAtEnd: [],
    },
  };
}

// ---------------------------------------------------------------------------
// snapshots

export async function fetchExplorerSnapshot(): Promise<ExplorerSnapshot> {
  const full = await resolveRun();
  const round = buildRound(full);
  const run = clampToReplay(full);
  const infoByHash = await txInfoByHash(run);

  // The page is the *round* explorer: when a round is selected, everything it shows is that round's
  // block window. Selecting a round that this run does not have falls back to the whole run rather
  // than showing an empty explorer.
  const selected = getSelectedRound();
  const epoch = round.epochs.find((e) => e.index === selected);
  const from = epoch ? epoch.fromBlock : firstBlock(run);
  const to = epoch ? epoch.toBlock : lastBlock(run);
  const rows = epoch
    ? run.blockRows.filter(
        (r) =>
          r.blockNumber > epoch.fromBlock && r.blockNumber <= epoch.toBlock,
      )
    : run.blockRows;

  // Live: the block rows cover a range (the tail of blocks.csv, or a recent RPC window). A window
  // that starts before it has no count to report -- 0 would read as "this round was quiet". Without
  // a round selected and a range that does not reach the run's start, the coordinator's own
  // tx_submitted stream stands in.
  const covers = (fromBlock: number) =>
    coversWindow(fromBlock, run.live?.blocksFrom ?? null, run.live !== undefined);
  const txCountThisRound = !epoch
    ? run.live && !covers(from)
      ? run.events.filter((e) => e.type === "tx_submitted").length
      : rows.length
    : covers(epoch.fromBlock)
      ? rows.length
      : null;

  return {
    round,
    scope: {
      roundIndex: epoch ? epoch.index : null,
      fromBlock: from,
      toBlock: to,
    },
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
    blocks: groupBlocks(rows)
      .slice(0, 30)
      .map((b) => toExplorerBlock(run, b)),
    // Every row in scope, newest first: the page searches over all of them and shows a page at a
    // time. Cutting to the newest sixty here put a transaction older than that out of reach of a
    // search by its own hash (issue #84 P).
    transactions: buildTransactions(run, rows, infoByHash, rows.length),
    txCoveredFrom: run.live ? run.live.blocksFrom : null,
    agents: (run.summary.agents ?? []).map((a) => ({
      id: a.id,
      ...(a.address ? { address: a.address } : {}),
    })),
  };
}

export async function fetchMarketSnapshot(
  base = "WETH",
): Promise<MarketSnapshot> {
  const full = await resolveRun();
  const round = buildRound(full);
  // Replay wins over the round selection: the head is a prefix of the run and a round is a window
  // inside it, and showing a later round while the head is behind it would show the future.
  const replaying = round.status === "replay";
  const epoch = replaying
    ? undefined
    : round.epochs.find((e) => e.index === getSelectedRound());
  const run = replaying
    ? clampToReplay(full)
    : epoch
      ? scopeRunToBlocks(full, epoch.fromBlock, epoch.toBlock)
      : full;
  const prices = fairSeriesForBase(run, base);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const lastFair =
    last?.fair ??
    (base === "WETH" ? (run.summary.finalFairPriceUsdcPerWeth ?? 0) : 0);
  const logs = await agentLogsFor(run);
  const infoByHash = await txInfoByHash(run);
  const bases = full.market?.bases ?? ["WETH"];
  const arbitrage = buildArbitrage(run, infoByHash, base);
  const venueDepths = buildVenueDepths(run, base);

  return {
    round,
    scope: {
      roundIndex: epoch ? epoch.index : null,
      fromBlock: epoch ? epoch.fromBlock : firstBlock(full),
      toBlock: replaying
        ? round.blockNumber
        : epoch
          ? epoch.toBlock
          : lastBlock(full),
    },
    protocols: enabledProtocols(full),
    pairs: bases.map((b) => ({ label: `${b}/USDC`, value: b })),
    base,
    fairPrice: lastFair,
    fairDirection: last && first && last.fair < first.fair ? "down" : "up",
    candles: candlesFor(prices),
    arbitrage,
    venueDepths,
    panels: buildVenuePanels(
      run,
      base,
      arbitrage,
      venueDepths,
      infoByHash,
      // Built from `full`: the schedule is the run's, not the selected round's.
      buildScenarioPanel(full, round.epochs),
    ),
    leaderboard: buildStandings(full, round.epochs, replaying),
    feed: buildFeed(logs, epoch, replaying ? round.blockNumber : undefined),
    feedSelfHosted: [...registeredAgents(run).values()].filter(
      (a) => a.external,
    ).length,
  };
}

const LOG_LIMIT = 120;

/**
 * The block a log line belongs to: a decision or a revision record carries the chain block as
 * `round` (runtime/read.ts passes `round: bn`), a mempool self-report the block it was seen in.
 * Startup lines (runtime_start, preflight) carry neither and precede every block.
 */
function logEntryBlock(entry: AgentLogEntry): number | null {
  if (typeof entry.round === "number") return entry.round;
  if (typeof entry.blockSeen === "number") return entry.blockSeen;
  return null;
}

/** The log as it stood at the replay head; unchanged when the run is not being replayed. */
function clampLogToHead(
  entries: AgentLogEntry[],
  head: number | null,
): AgentLogEntry[] {
  if (head === null) return entries;
  return entries.filter((e) => {
    const block = logEntryBlock(e);
    return block === null || block <= head;
  });
}

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
  const full = await resolveRun();
  const round = buildRound(full);
  const run = clampToReplay(full);
  const standing = buildStandings(
    full,
    round.epochs,
    round.status === "replay",
  ).find((s) => s.agent === agentId);
  if (!standing) throw new Error(`agent ${agentId} not found in run ${run.id}`);

  const summaryAgent = (run.summary.agents ?? []).find((a) => a.id === agentId);
  const address = (summaryAgent?.address ?? "").toLowerCase();
  const { valuesByAgent } = observationSeries(run);
  // Keep the block with the value: the chart's x axis is block height, and an index would be a
  // different (and unlabelled) quantity.
  const portfolioSeries = downsample(
    (valuesByAgent.get(agentId) ?? []).map((p) => ({
      time: p.block,
      value: p.value,
    })),
    240,
  );
  const infoByHash = await txInfoByHash(run);
  // The decision log obeys the replay head like everything else on the page: a replay that shows
  // the trades as of block B but the reasons the agent wrote after B is a slideshow with the
  // answer printed on every frame (see replay.ts, "never show the future").
  const head = replayHeadFor(run.id);
  const logEntries = clampLogToHead(
    (await agentLogsFor(run)).get(agentId) ?? [],
    head,
  );

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

  // This agent's result in each round, straight off the run's rounds.
  const txByRound = new Map<number, number>();
  for (const row of run.blockRows) {
    if (row.from !== address) continue;
    const epoch = round.epochs.find(
      (e) => row.blockNumber > e.fromBlock && row.blockNumber <= e.toBlock,
    );
    if (epoch)
      txByRound.set(epoch.index, (txByRound.get(epoch.index) ?? 0) + 1);
  }
  const rounds: AgentRoundResult[] = round.epochs.flatMap((epoch) => {
    const result = epoch.results.find((r) => r.agent === agentId);
    if (!result) return [];
    return [
      {
        index: epoch.index,
        fromBlock: epoch.fromBlock,
        toBlock: epoch.toBlock,
        deltaUsdc: result.deltaUsdc,
        logReturnBps: result.logReturnBps,
        rank: result.rank,
        cumulativeRank: result.cumulativeRank,
        move: result.move,
        txCount: txByRound.get(epoch.index) ?? 0,
      },
    ];
  });

  // Every venue position the run's end-of-run reads recorded for this agent — not just the perps.
  // A run without GMX is the common case, and a table fed only by GMX renders empty for an agent
  // that spent the whole run staking or borrowing, which is indistinguishable from a broken view.
  const lastRow = run.market?.series[run.market.series.length - 1];
  const lastFairByBase = lastRow?.fair ?? {};
  const positions = buildAgentPositions(run, agentId, lastFairByBase);

  const fullLog = buildAgentLogLines(logEntries);
  // An empty log and an absent one are different facts, and the panel has to say which. A local
  // agent with no lines means it never logged a decision; an external one means the log exists, on
  // somebody else's disk (ADR 0021 §4).
  const external = registeredAgents(run).get(agentId)?.external === true;

  const agent: AgentDetail = {
    rank: standing.rank,
    fieldSize: (run.summary.agents ?? []).length,
    agent: standing.agent,
    address: shortAddress(summaryAgent?.address ?? ""),
    fullAddress: summaryAgent?.address,
    strategy: standing.strategy,
    score: standing.score,
    netPnlUsdc: standing.netPnlUsdc,
    unscored: standing.unscored,
    maxDrawdownPercent: standing.maxDrawdownPercent,
    portfolioSeries,
    positions,
    trades,
    recentLog: fullLog.slice(0, 8),
    fullLog,
    rounds,
    external,
  };

  return { round, agent };
}

// ---------------------------------------------------------------------------
// world (the competition map)
//
// The demo's three columns, read off the run instead of scripted: the agents, the chain they all
// go through, the contracts holding state. What this builder owes the page is a *walkable* run —
// one frame per block, each carrying that block's transactions and every venue's number at it — so
// the page can move a head over the frames and never has to ask the data layer for a moment again.
//
// Two things it will not do. It does not skip quiet blocks: a timeline whose steps are "blocks that
// happened to have traffic" is not a clock, and the pauses between bursts are the shape of a
// strategy. And it does not truncate a long window — past the frame cap the frames become groups of
// blocks, which the page labels as a range, because a walk that silently stops at block 900 of 14,400
// is a walk that lies about where the run ended.

/** The most frames one walk carries. Beyond this, a frame is a group of blocks. */
const WORLD_MAX_FRAMES = 900;
/** Transactions carried per frame. The rest are counted in the frame's total, not listed. */
const WORLD_MAX_TXS_PER_FRAME = 24;
/** Environment events placed on the block axis. */
const WORLD_MAX_EVENTS = 200;
/** Log lines carried per agent. The panel scrolls; the snapshot is not an archive of the run. */
const WORLD_MAX_LOG_LINES = 1000;

/** The last sample at or before `block`, over a series already in block order. */
function sampleAt<T extends { block: number }>(
  series: T[],
  block: number,
  cursor: { i: number },
): T | undefined {
  while (cursor.i + 1 < series.length && series[cursor.i + 1].block <= block)
    cursor.i += 1;
  const row = series[cursor.i];
  return row && row.block <= block ? row : undefined;
}

function worldPrice(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The venue nodes this run has: every protocol the coordinator enabled, plus any the transactions
 * name. A venue an agent deployed a market on (the lending singleton, issue #40) is in the second
 * group only — the environment never announced it.
 */
function worldVenues(run: LoadedRun, targeted: Set<string>): WorldVenueNode[] {
  const metrics: Record<string, () => string> = {
    uniswap: () => t("world.metric.price"),
    balancer: () => t("world.metric.price"),
    curve: () => t("world.metric.price"),
    gmx: () => t("world.metric.oi"),
    aave: () => t("world.metric.utilisation"),
    lst: () => t("world.metric.discount"),
    liquity: () => t("world.metric.peg"),
    lending: () => t("world.metric.markets"),
  };
  const ids = new Set<string>([...enabledProtocols(run), ...targeted]);
  return [...Object.keys(WORLD_VENUES)]
    .filter((id) => ids.has(id))
    .map((id) => ({
      id,
      label: VENUE_LABELS[id] ?? id,
      kind: WORLD_VENUES[id].kind,
      color: VENUE_COLORS[id] ?? WORLD_VENUES[id].color,
      metric: metrics[id](),
    }));
}

function worldAgents(run: LoadedRun): WorldAgentNode[] {
  const registered = registeredAgents(run);
  return (run.summary.agents ?? []).map((agent) => {
    const entry = registered.get(agent.id);
    return {
      id: agent.id,
      address: shortAddress(agent.address ?? ""),
      strategyCategory: categorize(agent.id, entry?.description ?? agent.id),
      baseline: agent.baseline === true,
      external: entry?.external === true,
    };
  });
}

/** What each epoch boundary's scored cross-section says every agent was worth, and had made. */
function worldBoundaries(run: LoadedRun): WorldBoundary[] {
  const series = run.summary.valueSeries?.epochSeries;
  const blocks = series?.boundaryBlocks ?? [];
  const values = series?.valuesByAgent ?? {};
  return blocks.map((block, i) => {
    const valueUsdc: Record<string, number> = {};
    const pnlUsdc: Record<string, number> = {};
    for (const [id, points] of Object.entries(values)) {
      const start = points[0];
      const now = points[i];
      // A boundary the scorer could not read is null, not 0: it is a missing mark, and carrying it
      // as a value would draw a wallet emptying itself.
      if (now != null) valueUsdc[id] = now;
      if (start != null && now != null) pnlUsdc[id] = now - start;
    }
    return { block, valueUsdc, pnlUsdc };
  });
}

/**
 * What each agent wrote, on the block axis.
 *
 * The runtime splits an agent's account of itself across two kinds of line, and the panel needs
 * both: a *decision* entry is written when the strategy stood down (`{action: noop, reason: "spread
 * too small"}` — the reason is the whole point of it), while an action it actually took is a
 * *mempool* entry naming the action type and the venue. Reading only the decisions, as this did at
 * first, shows an agent that spends the entire run declining to trade while the board behind it is
 * full of its transactions.
 */
function worldAgentLog(logs: Map<string, AgentLogEntry[]>, from: number, to: number): {
  byAgent: Record<string, WorldLogLine[]>;
  withheld: boolean;
} {
  const byAgent: Record<string, WorldLogLine[]> = {};
  for (const [id, entries] of logs) {
    const lines: WorldLogLine[] = [];
    for (const entry of entries) {
      const block = Number(entry.round ?? entry.blockSeen);
      if (!Number.isFinite(block) || block < from || block > to) continue;
      if (entry.kind === "mempool") {
        if (entry.event === "submitted") {
          lines.push({
            block,
            event: str(entry.actionType) || "submit",
            text: str(entry.protocol),
            tone: "success",
          });
        } else if (entry.event === "submit_failed") {
          lines.push({
            block,
            event: str(entry.actionType) || "submit",
            // The revert arrives as a viem error with the whole request dumped under it; the first
            // line is the reason, and the rest is calldata nobody reads off a panel this size.
            text: str(entry.error).split("\n")[0],
            tone: "danger",
          });
        }
        continue;
      }
      const action = (entry.action as { type?: string } | undefined)?.type;
      if (!action) continue;
      lines.push({
        block,
        event: action,
        text: str(entry.reason),
        tone: action === "noop" ? "info" : "success",
      });
    }
    // The tail, not the head, if an agent wrote more than the cap. Keeping the first N would leave
    // the panel silent for the whole back half of the run, which reads as an agent that stopped.
    if (lines.length > 0)
      byAgent[id] = lines.slice(-WORLD_MAX_LOG_LINES);
  }
  // Audience mode serves no decision logs at all (agentLogsFor returns empty lists), which is a
  // different fact from an agent that logged nothing, and the panel has to be able to say which.
  return { byAgent, withheld: getMode().audience };
}

/** The tape's events, kept on the block axis instead of collapsed into a ticker. */
function worldEvents(
  run: LoadedRun,
): Map<number, { kind: string; text: string; tone: TapeTone }[]> {
  const byBlock = new Map<
    number,
    { kind: string; text: string; tone: TapeTone }[]
  >();
  let taken = 0;
  for (const event of run.events) {
    if (taken >= WORLD_MAX_EVENTS) break;
    const rule = TAPE_RULES[event.type];
    if (!rule) continue;
    const block = Number(event.blockNumber);
    if (!Number.isFinite(block)) continue;
    const list = byBlock.get(block) ?? [];
    list.push({
      kind: rule.kind(),
      text: `${rule.body(event)} · ${rule.value(event)}`,
      tone: rule.tone,
    });
    byBlock.set(block, list);
    taken += 1;
  }
  return byBlock;
}

export async function fetchWorldSnapshot(
  base = "WETH",
): Promise<WorldSnapshot> {
  const full = await resolveRun();
  const round = buildRound(full);
  // Not clamped to the replay head. The board has a head of its own — the walk — and everything on
  // it reads up to that block; a run cut at the replay head would give the walk frames past it
  // with no transactions in them, a future that looks empty rather than unknown. A replay armed
  // for this run only tells the page where to open.
  const run = full;
  const [infoByHash, logs] = await Promise.all([
    txInfoByHash(run),
    agentLogsFor(run),
  ]);

  // Scoped like the explorer: a selected round is that round's block window, and no selection is
  // the whole run. A round the run does not have falls back to the run rather than to nothing.
  const selected = getSelectedRound();
  const epoch = round.epochs.find((e) => e.index === selected);
  const from = epoch ? epoch.fromBlock + 1 : firstBlock(run);
  const to = epoch ? epoch.toBlock : lastBlock(run);
  const span = Math.max(1, to - from + 1);
  const blocksPerFrame = Math.max(1, Math.ceil(span / WORLD_MAX_FRAMES));

  // Transactions, bucketed onto the frame their block falls in.
  const rowsByFrame = new Map<number, LoadedRun["blockRows"]>();
  const targeted = new Set<string>();
  for (const row of run.blockRows) {
    if (row.blockNumber < from || row.blockNumber > to) continue;
    const slot = Math.floor((row.blockNumber - from) / blocksPerFrame);
    const list = rowsByFrame.get(slot) ?? [];
    list.push(row);
    rowsByFrame.set(slot, list);
    const venue = venueOfTx({
      protocol: infoByHash.get(row.hash.toLowerCase())?.protocol,
      actionType: row.actionType,
      method: row.method,
    });
    if (venue) targeted.add(venue);
  }

  const venues = worldVenues(run, targeted);
  const venueIds = new Set(venues.map((v) => v.id));
  const marketSeries = (run.market?.series ?? []).filter((r) =>
    Number.isFinite(r.block),
  );
  const lstSeries = blockSeriesOf(run, "lst_block").map((e) => ({
    block: Number(e.blockNumber),
    discountBps: num(e.discountBps),
  }));
  const liquitySeries = blockSeriesOf(run, "liquity_block").map((e) => ({
    block: Number(e.blockNumber),
    tcr: num(e.tcr),
  }));
  const fairPoints = fairSeries(run);
  const eventsByBlock = worldEvents(run);

  const marketCursor = { i: 0 };
  const lstCursor = { i: 0 };
  const liquityCursor = { i: 0 };
  const fairCursor = { i: 0 };

  const frameCount = Math.ceil(span / blocksPerFrame);
  const frames: WorldFrame[] = [];
  for (let slot = 0; slot < frameCount; slot++) {
    const fromBlock = from + slot * blocksPerFrame;
    const block = Math.min(to, fromBlock + blocksPerFrame - 1);
    const rows = rowsByFrame.get(slot) ?? [];
    // Which rows the board carries, when a block has more than it can fly. Not the first N: the
    // environment's oracle writes the price at the top of every block and pays the most for it, so
    // "the first six" is six identical rows and the competition is the part that gets cut. The
    // sample prefers the field and keeps block order inside it; the counts below stay the block's.
    const sampled = new Set(
      [
        ...rows.filter((r) => r.role === "agent"),
        ...rows.filter((r) => r.role !== "agent"),
      ].slice(0, WORLD_MAX_TXS_PER_FRAME),
    );
    const txs: WorldTx[] = rows
      .filter((r) => sampled.has(r))
      .map((row) => ({
        hash: shortHash(row.hash),
        agent:
          row.role === "external"
            ? shortAddress(row.from)
            : (row.ownerId ?? row.from),
        kind: row.role === "agent" ? ("agent" as const) : ("environment" as const),
        method: methodOf(row, infoByHash),
        venue: venueOfTx({
          protocol: infoByHash.get(row.hash.toLowerCase())?.protocol,
          actionType: row.actionType,
          method: row.method,
        }),
        // blocks.csv carries the priority fee in wei; the chain panel reads it in gwei.
        fee: ((Number(row.priorityFeeWei) || 0) / 1e9).toFixed(2),
        ok: row.status === "success",
      }));

    const market = sampleAt(marketSeries, block, marketCursor);
    const venueValues: Record<string, string> = {};
    const priceUsd: Record<string, number> = {};
    for (const venue of market ? Object.keys(market.venues ?? {}) : []) {
      const mid = market?.venues?.[venue]?.[base]?.mid;
      if (mid !== undefined && mid > 0 && venueIds.has(venue)) {
        venueValues[venue] = worldPrice(mid);
        priceUsd[venue] = mid;
      }
    }
    if (venueIds.has("gmx") && market?.gmx?.[base]) {
      const gmx = market.gmx[base];
      venueValues.gmx = formatUsd(gmx.longOiUsd + gmx.shortOiUsd);
    }
    if (venueIds.has("aave") && market?.aave) {
      // Across the reserves, not whichever one comes first out of the object. A run can supply WETH
      // and borrow only USDC, and reading the first key then reports a lending market at 0%
      // utilisation while its USDC side is being borrowed against all run.
      let supplied = 0;
      let borrowed = 0;
      for (const reserve of Object.values(market.aave)) {
        supplied += reserve.suppliedUsd;
        borrowed += reserve.borrowedUsd;
      }
      if (supplied > 0)
        venueValues.aave = `${((borrowed / supplied) * 100).toFixed(1)}%`;
    }
    if (venueIds.has("lst")) {
      const lst = sampleAt(lstSeries, block, lstCursor);
      if (lst) venueValues.lst = `${lst.discountBps.toFixed(0)} bps`;
    }
    if (venueIds.has("liquity")) {
      const stable = market?.stables;
      const first = stable ? Object.values(stable)[0] : undefined;
      if (first?.quoted)
        venueValues.liquity = `$${first.priceUsdc.toFixed(4)}`;
      else {
        // A pool that would not quote leaves priceUsdc at par by fallback — rendering that as the
        // peg holding is the one thing this number must never claim (issue #27). The system's
        // collateral ratio is a real read, so it stands in.
        const liquity = sampleAt(liquitySeries, block, liquityCursor);
        if (liquity) venueValues.liquity = `TCR ${liquity.tcr.toFixed(2)}`;
      }
    }

    // The reconstructed series carries the fair price beside the venue quotes; the observations
    // the agents were handed are the fallback, for a run recorded before market.json existed.
    const observed = sampleAt(fairPoints, block, fairCursor);
    const fairValue = market?.fair?.[base] ?? observed?.fair ?? null;

    // Events land on their own block, which inside a grouped frame is not the frame's last one.
    const events: WorldFrame["events"] = [];
    for (let b = fromBlock; b <= block; b++)
      for (const e of eventsByBlock.get(b) ?? []) events.push(e);

    frames.push({
      block,
      fromBlock,
      clock: blockClock(run, block),
      round:
        round.epochs.find((e) => block > e.fromBlock && block <= e.toBlock)
          ?.index ?? 0,
      txCount: rows.length,
      senderCount: new Set(
        rows.filter((r) => r.role === "agent").map((r) => r.ownerId || r.from),
      ).size,
      txs,
      reverts: rows.filter((r) => r.status !== "success").length,
      venueValues,
      priceUsd,
      fairUsd: fairValue,
      fair: fairValue === null ? null : worldPrice(fairValue),
      events,
    });
  }

  // One field per closed-round count, so the panel beside the board can show the standings through
  // the walk's block. The same buildStandings reads P through the first k rounds as replay does;
  // there is no second scoring path here.
  const standingsThroughRound = Array.from(
    { length: round.epochs.length + 1 },
    (_, k) =>
      buildStandings(
        full,
        round.epochs.map((e, i) => ({
          ...e,
          status: (i < k ? "done" : "upcoming") as RoundEpoch["status"],
        })),
        true,
      ),
  );

  return {
    round,
    standingsThroughRound,
    scope: { roundIndex: epoch ? epoch.index : null, fromBlock: from, toBlock: to },
    agents: worldAgents(run),
    venues,
    frames,
    boundaries: worldBoundaries(run),
    ...(() => {
      const { byAgent, withheld } = worldAgentLog(logs, from, to);
      return { agentLog: byAgent, logsWithheld: withheld };
    })(),
    blocksPerFrame,
  };
}
