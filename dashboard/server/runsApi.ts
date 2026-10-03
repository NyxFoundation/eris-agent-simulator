// The runs API: the dashboard's only source of run artifacts.
//
//   /runs/index.json                 run dirs, newest first; `live: true` marks one in progress
//   /runs/mode.json                  how this server is configured to show them (audience / standings)
//   /runs/manifest.json              the environment manifest of the run to connect to (issue #156)
//   /runs/<id>/<artifact>            the artifact file itself
//   /runs/<id>/tail/<file>?offset=N  incremental tail of a jsonl/csv artifact (live mode)
//
// It lived inside vite.config.ts, as a dev-server plugin, on the assumption that the dashboard is a
// local viewer over local output. ADR 0021 §5 breaks that assumption: on the practice devnet the
// artifacts are on the coordinator's machine and the participants are not, so the operator hosts
// the dashboard. Same handler, two mounts -- the vite dev server for development, and a small static
// server for hosting (server/serve.ts).
//
// Audience mode (2026-09-06: the dashboard is public during the trial period and the live week).
// The run directory is the complete record and stays that way -- it is what rules §7.2 publishes
// after the results. What a competition in progress must not publish is removed *here*, at the one
// place every reader goes through, rather than in the UI: a panel that does not render a file is
// not the same as a file nobody can fetch.
//   - files: only the artifacts the pages need. Decision logs (a participant's own reasoning and
//     their not-yet-included bids -- rules §2.6 is a priority-fee auction) and raw LLM exchanges are
//     never served; neither is anything not on the list
//   - events.jsonl: the seeds (§3.3, §7.2), the calibration warning (it names crash magnitudes), the
//     ground truth of regime-7 pools (§3.2: whether a pool is rigged is the participant's to find
//     out), a participant's stderr, and the *future* half of the stress schedule are stripped. Past
//     windows stay: they already happened to everyone. The same rule covers every other `stress_*`
//     event, not just the schedule: a scenario epoch serves none of them (each one names its
//     regime -- `stress_whale`, `stress_token_launch`, `stress_event_summary`), and a continuous
//     world serves one only once the window it belongs to has closed. `stress_event_applied` is
//     written when the oracle tx is *sent*, so a live tail of it read the next block's price, and
//     `stress_token_launch_setup` / `_funded` listed future windows and which launches were duds
//     All of this sits inside an allowlist of event types (`AUDIENCE_EVENTS`, issue #210): a type
//     nobody has put on it is not served. The environment's own submissions (`tx_submitted`) are on
//     it but held until mined -- written at send time, they named a pending tx a block early -- and
//     a tail stops in front of a held line instead of skipping it
//   - blocks.csv: for a scenario epoch, the senders that exist only in some regimes (the whale's,
//     the token launches', a liquidity pull's) are collapsed to their class (`scenarioOwner`)
//   - matrix.json / standings.json / summary.json: regime becomes "hidden" and seed null while the
//     competition is a scenario matrix (§3.3: the scenario of an epoch is not announced; equal
//     regime counts would let the remaining ones be inferred). A practice period's segments are not
//     scenarios and keep their date labels. Null, not 0: a redacted seed, a segment's placeholder
//     seed and a real published seed 0 have to stay tellable apart, and only the server knows which
//     one it is serving
//   - the index: with ERIS_DASHBOARD_COMPETITIONS set, only the listed competitions and the runs
//     that belong to them are served -- as index entries, as files and as tails alike. A hosted
//     box keeps every smoke and test run the operator ever made under runs/, and without the list
//     the picker offered all of them to participants under their internal names (issue #84 K).
//     Membership is what the competition's own index names or contains, never a guess: an earlier
//     draft also admitted "whatever is live" while a listed matrix had epochs left, which admitted
//     every live directory under runs/ -- including the operator's smoke run -- for as long as the
//     competition was in progress, which is the whole event
// `standings: false` is the trial environment's rule §4.7 ("posts no standings"); the server only
// reports it and the UI honours it, because the numbers behind a standing are the same numbers
// the scenario pages show.
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGzip } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

// A run dir without summary.json is either in progress or dead: summary.json is written at the very
// end of a run, so "no summary but the artifacts still moving" is the live signal. The teardown
// phase (bulk blocks.csv recording, then the reconstruction sweeps) can leave events.jsonl silent
// for tens of seconds while blocks.csv is the file being written — so freshness is judged on the
// newest of the two, with a window generous enough to bridge the quiet stretches. A run that
// briefly dropped off the index mid-teardown would flip the dashboard to the neighboring run and
// strand it there (the live refresh loop stops with the run it lost).
const LIVE_FRESHNESS_MS = 120_000;

// How far into events.jsonl to look for the stress schedule (written before the first block).
const SCHEDULE_HEAD_BYTES = 4 * 1024 * 1024;

// Chunk cap for a tail request: a first tail of a large log would otherwise buffer the whole file
// in memory at once. The client keeps polling with the returned offset until it catches up.
const TAIL_CHUNK_BYTES = 4 * 1024 * 1024;

// The index walks runs/ with a stat per directory. One viewer polling it is nothing; an audience
// polling it every few seconds is the same walk repeated for the same answer, so it is held for a
// moment. Short enough that a run appearing or going live shows up within a poll interval.
const INDEX_CACHE_MS = 3_000;

// Bytes of events.jsonl read back from a point to find the newest block the coordinator had
// processed by then (it writes several lines per block, a few hundred bytes each).
const HEAD_LOOKBACK_BYTES = 64 * 1024;

// Bytes read off the end of blocks.csv to learn the current block of a live run. A row is ~150
// bytes; this is dozens of rows, which is plenty to find one complete line.
const BLOCKS_TAIL_BYTES = 8 * 1024;

// Cache lifetimes. A finished run's artifacts never change (immutable); a competition index and a
// live run's files are rewritten while it runs; the index and the tail are the poll targets.
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_SHORT = "public, max-age=5";
const CACHE_NONE = "no-store";

/**
 * Runs are not always at the top of runs/. A run collected from a remote box arrives as a tarball of
 * that box's whole runs/ directory, so it lands at runs/<collection>/runs/<id>/ — every artifact
 * present, one or two levels deeper than a local run. A practice period's segments (ADR 0021 §6)
 * are one level deep for the same reason: runs/<period>/<day>/.
 */
const MAX_RUN_DEPTH = 2;

export type RunEntry = {
  id: string;
  mtimeMs: number;
  live?: boolean;
  /** A competition index (a scenario matrix, or a segmented period) rather than a single world. */
  kind?: "matrix";
};

/** What /runs/mode.json reports, so the UI can say why a panel is absent rather than render it empty. */
export type DashboardMode = {
  /** The server withholds what a competition in progress must not publish (see the header). */
  audience: boolean;
  /** False for the trial environment: rules §4.7, it posts no standings. */
  standings: boolean;
};

export type RunsApiOptions = Partial<DashboardMode> & {
  /**
   * Competition ids (directories under runs/) to serve, and nothing else. Undefined or empty =
   * everything under runs/ (the operator's own view). See `competitionsFromEnv`.
   */
  competitions?: readonly string[];
};

/**
 * ERIS_DASHBOARD_AUDIENCE=1   serve for people who are not the operator (default: off — a local
 *                             viewer over local output, the development path)
 * ERIS_DASHBOARD_STANDINGS=0  do not post standings (the trial environment, rules §4.7)
 */
export function modeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DashboardMode {
  const on = (v: string | undefined) => v === "1" || v === "true";
  const off = (v: string | undefined) => v === "0" || v === "false";
  return {
    audience: on(env.ERIS_DASHBOARD_AUDIENCE),
    standings: !off(env.ERIS_DASHBOARD_STANDINGS),
  };
}

/**
 * ERIS_DASHBOARD_COMPETITIONS=<id>[,<id>...]   the competitions a hosted server offers. An id is a
 * directory under runs/ holding a matrix.json (a scenario matrix, or a practice period). A run is
 * served when it is one of a listed competition's scenarios or segments, or a run in progress
 * while a listed scenario matrix is still being run (the epoch running now is not in matrix.json
 * until it completes). Unset = everything under runs/.
 */
export function competitionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const raw = env.ERIS_DASHBOARD_COMPETITIONS;
  if (raw === undefined) return undefined;
  const ids = raw
    .split(",")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

// The artifacts the pages read. Everything else under a run dir is either a participant's
// (agents/<id>.jsonl, agents/<id>.llm.jsonl), the environment's answer key (disclosures/), or
// something a future writer adds that nobody has decided to publish yet.
const AUDIENCE_FILES = new Set([
  "summary.json",
  "matrix.json",
  "standings.json",
  "market.json",
  "market.jsonl",
  "blocks.csv",
  "events.jsonl",
  "intervals.jsonl",
  // What intervals.jsonl was called before issue #140; a coordinator started earlier still writes it.
  "epochs.jsonl",
  "manifest.json",
  "current-segment",
]);

const HIDDEN_REGIME = "hidden";

function audienceAllows(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts.includes("agents") || parts.includes("disclosures")) return false;
  return AUDIENCE_FILES.has(base);
}

type Json = Record<string, unknown>;

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Whether a competition index describes scenarios (hide regime/seed) or a period's segments (keep). */
function hidesScenarios(file: Json): boolean {
  return file.resetUnit !== "continuous";
}

function redactScenario(s: Json, index: number): Json {
  const ordinal = typeof s.s === "number" ? s.s : index + 1;
  const { label: _label, ...rest } = s;
  return { ...rest, regime: HIDDEN_REGIME, seed: null, s: ordinal };
}

/** matrix.json for the audience: the epochs, without which scenario each one was. */
function redactMatrix(file: Json): Json {
  if (!hidesScenarios(file) || !Array.isArray(file.scenarios)) return file;
  return {
    ...file,
    scenarios: (file.scenarios as Json[]).map(redactScenario),
  };
}

// A flag line written before the standings keyed flags by ordinal: `<regime>#<seed>: <fact>`.
const SCENARIO_FLAG_PREFIX = /^([^\s:#]+)#(-?\d+): /;

/**
 * standings.json carries regime/seed per epoch too, and -- in files written before the flags were
 * keyed by ordinal -- at the head of every per-agent flag line. Any agent can raise a flag (exit
 * before the bell), so leaving those lines alone published a hidden epoch's `regime#seed` at will.
 * A prefix naming a known epoch becomes its ordinal; one that names none is dropped to `s=?`.
 */
function redactStandings(file: Json): Json {
  if (!Array.isArray(file.epochs)) return file;
  const ordinalOf = new Map<string, unknown>();
  for (const e of file.epochs as Json[])
    ordinalOf.set(`${String(e.regime)}#${String(e.seed)}`, e.s);
  const redactFlag = (f: unknown): unknown =>
    typeof f === "string"
      ? f.replace(SCENARIO_FLAG_PREFIX, (_m, regime: string, seed: string) => {
          const s = ordinalOf.get(`${regime}#${seed}`);
          return `s=${typeof s === "number" ? s : "?"}: `;
        })
      : f;
  return {
    ...file,
    epochs: (file.epochs as Json[]).map((e) => ({
      ...e,
      regime: HIDDEN_REGIME,
      seed: null,
    })),
    ...(Array.isArray(file.agents)
      ? {
          agents: (file.agents as Json[]).map((a) =>
            Array.isArray(a.flags)
              ? { ...a, flags: (a.flags as unknown[]).map(redactFlag) }
              : a,
          ),
        }
      : {}),
  };
}

/**
 * summary.json: the seeds, the per-window stress audit (`stressEvents` names every window's kind,
 * which is the regime), and a participant's stderr (their process, their words).
 */
function redactSummary(file: Json): Json {
  // rosterTransfers (issue #208) names which participant moved what to which other participant.
  // It is a recorded fact for the operator to judge under rules §8, not a finding -- nothing in it
  // has been adjudicated, and the same movement can be a trade or self-dealing depending on who
  // owns both ends. Published during the week it would read as an accusation the audience cannot
  // check, about people who cannot answer. The run-level list and the per-agent one both go.
  const {
    seed: _seed,
    flowSeed: _flowSeed,
    rosterTransfers: _rosterTransfers,
    stressEvents: _stressEvents,
    ...rest
  } = file;
  if (Array.isArray(rest.agents)) {
    rest.agents = (rest.agents as Json[]).map((a) => {
      const { stderrTail: _stderr, rosterTransfers: _agentTransfers, ...agent } = a;
      return agent;
    });
  }
  return rest;
}

const REDACTED_JSON: Record<string, (file: Json) => Json> = {
  "matrix.json": redactMatrix,
  "standings.json": redactStandings,
  "summary.json": redactSummary,
};

/**
 * How one events.jsonl (or blocks.csv) is redacted for the audience. `currentBlock` is the chain
 * height the run's blocks.csv has reached (null when unknown), which decides how much of the stress
 * schedule is history. `chainHeight` is the best evidence of how far the chain has been mined --
 * blocks.csv and the coordinator's own `round_timing` lines, Infinity once the run has finished --
 * and decides when an environment tx's submission may be shown (see TX_MINED_MARGIN). Unset = null:
 * nothing is known to be mined, and every submission is held.
 */
export type SchedulePolicy =
  /**
   * Keep windows that have closed by `currentBlock` (a practice period: the past is public).
   * `windows` are the schedule's windows in absolute blocks, indexed like `eventIndex`; null when
   * the file has no schedule line (then no stress event is attributable, and none is served).
   */
  | {
      kind: "past";
      currentBlock: number | null;
      windows?: ReadonlyArray<{ start: number; end: number }> | null;
      chainHeight?: number | null;
    }
  /**
   * Drop the schedule entirely: the run is one epoch of a scenario matrix, and even a closed
   * window's kind ("crash", "whale") names the regime rules §3.3 does not announce.
   */
  | { kind: "none"; chainHeight?: number | null };

/** Absolute windows of a `stress_schedule` event, indexed like the `eventIndex` the others carry. */
export function scheduleWindows(
  event: Json,
): Array<{ start: number; end: number }> | null {
  if (!Array.isArray(event.events)) return null;
  const base = typeof event.runStartBlock === "number" ? event.runStartBlock : 0;
  return (event.events as Json[]).map((w) => ({
    start: base + (typeof w.startBlock === "number" ? w.startBlock : 0),
    // A window without an end is never "closed": withhold rather than guess.
    end:
      typeof w.endBlock === "number"
        ? base + w.endBlock
        : Number.POSITIVE_INFINITY,
  }));
}

/**
 * A `stress_*` event other than the schedule. Served only when everything it says is about a window
 * that has closed -- the schedule's own rule, applied to the events that report on it.
 */
function redactStressEvent(event: Json, policy: SchedulePolicy): string | null {
  if (policy.kind === "none") return null;
  const { currentBlock } = policy;
  const windows = policy.windows ?? null;
  if (currentBlock === null || windows === null) return null;
  const closed = (i: unknown) =>
    typeof i === "number" && i >= 0 && i < windows.length && windows[i].end <= currentBlock;

  // One window's event: its window decides.
  if ("eventIndex" in event) return closed(event.eventIndex) ? JSON.stringify(event) : null;
  // The token-launch plan lists every launch with its window: keep the ones that are over.
  if (Array.isArray(event.launches)) {
    const past = (event.launches as Json[]).filter((l) => closed(l.eventIndex));
    if (past.length === 0) return null;
    return JSON.stringify({ ...event, launches: past, redacted: "future windows" });
  }
  // A block's event (a whale swap, a liquidation, a pull): mined, and not inside a window that is
  // still open -- while it is open, the event is the window's magnitude and timing, ahead of the
  // price series.
  if (typeof event.blockNumber === "number") {
    const b = event.blockNumber;
    if (b > currentBlock) return null;
    const insideOpen = windows.some((w) => w.start <= b && b <= w.end && w.end > currentBlock);
    return insideOpen ? null : JSON.stringify(event);
  }
  // Neither: setup, funding, teardown and stuck/reverted diagnostics. They describe the plan (how
  // many whales, what the victims are, how much liquidity will be pulled) or the operator's
  // machinery, never something an audience could not have seen on chain.
  return null;
}

/**
 * The event types the audience is served, and how. **An allowlist** (issue #210): a type not named
 * here is not served, including every type a future writer adds. The list used to be the other way
 * round -- everything was served except what had been named -- and each round of review found
 * another line that leaked: the stress events (#204), then the environment's own submissions
 * (`tx_submitted`, written when a flow or whale tx is *sent*, so a live tail read its hash one block
 * before it was mined and the gateway's refusal to show pending txs was moot), then the regime
 * names on non-`stress_` events. A new event now has to be argued onto the list, not off it.
 *
 * What is on it is what a page reads (dashboard/src: liveRun.ts, runsProvider.ts, venuePanels.ts,
 * schedule.ts, runArtifacts.ts) and is history by the time it is written:
 *   keep        written about a block that has already been mined, and true of every regime
 *   tx          the environment's submissions: only once mined (TX_MINED_MARGIN), and in a scenario
 *               epoch with a regime-naming owner collapsed (`scenarioOwner`)
 *   continuous  on-chain facts that only some regimes produce (a Trove liquidation or a redemption
 *               happens in cdp-incident, a slash only where lstSlash is scheduled): served for a
 *               continuous world, where they are history; dropped for a scenario epoch, where their
 *               presence names the regime (rules §3.3)
 * Stress events (`stress_*`) follow the schedule's rule above, and the schedule its own.
 *
 * Deliberately not on it, though written: the vuln regime's pool lifecycle (`pool_created`,
 * `vulnerability_disclosed`, `safe_pool_captured`, `vuln_factory_deployed`,
 * `vulnerability_exploited`: they name the regime, and `pool_created` carried the rigged flag), the
 * agent-market registry (`market_*`: only the launch regime turns it on), setup and calibration
 * audits (`initial_endowment`, `owner_guard_audit`, `no_arb_startup`, `deployment_check`, ...), the
 * flow wallets' own telemetry (`flow_balances`, `flow_guard`, `flow_wallet_*`: the environment's
 * inventory), process exits and sandbox notes (a participant's stderr, the operator's isolation),
 * and the post-run scoring audits. No page reads any of them, so dropping them changes nothing a
 * reader sees; serving them is a decision that has to be made when a page starts to.
 */
const AUDIENCE_EVENTS: Record<string, "keep" | "tx" | "continuous"> = {
  // The run's header (seed and flowSeed removed below), the roster and the clock.
  run_started_realtime: "keep",
  run_start_declared: "keep",
  price_feed_deployed: "keep",
  agents_registered: "keep",
  round_timing: "keep",
  run_completed: "keep",
  // The interval series, under its name and under the one before issue #140.
  interval_boundary: "keep",
  epoch_boundary: "keep",
  // The reconstructed value series (written after the run).
  observation: "keep",
  // Venue state per block, and the venue's own failures and arb windows: every regime has them.
  lst_setup: "keep",
  lst_block: "keep",
  lst_apy_changed: "keep",
  liquity_block: "keep",
  keeper_failed: "keep",
  no_arb_persistent_warning: "keep",
  tx_submitted: "tx",
  tx_submit_failed: "tx",
  liquity_liquidation: "continuous",
  liquity_redemption: "continuous",
  lst_slash: "continuous",
};

/**
 * Blocks past the coordinator's head at send time before a submission is shown. A tx sent while the
 * head was H can be mined in H+1 at the earliest; the second block absorbs the two ways it can be
 * later without the coordinator knowing -- a block mined in the moment between the head being
 * reported and the tx being sent, and a tx that reached the node after H+1's cut. It costs the
 * public live view about two blocks of delay on these lines (and, in a tail, on what follows them).
 */
export const TX_MINED_MARGIN = 2;

/** Event types written about the block the coordinator is processing: evidence of its head. */
const HEAD_EVIDENCE = new Set([
  "round_timing",
  "lst_block",
  "liquity_block",
  "interval_boundary",
  "epoch_boundary",
]);

/** A line the audience may see later but not yet: a tail stops in front of it and serves it again. */
export const HOLD: unique symbol = Symbol("hold");

/**
 * What a redaction pass has seen so far in the file: the newest block a head-evidence line named,
 * which dates a submission written by a coordinator from before `headBlock` existed. `lookback`
 * finds it before the first line of a tail chunk.
 */
export type RedactionCursor = {
  lastBlock: number | null;
  lookback?: () => number | null;
};

/**
 * Background flow is one wallet per venue and side, in every regime. The whale's wallet and the
 * token-launch wallets exist only in the regimes that have them, and the environment's system
 * senders other than the oracle and the keeper (a liquidity pull, a depeg seller, the market
 * registry) likewise -- so in a scenario epoch their owner id is the regime's name, and the audience
 * gets the class instead. Continuous worlds keep the name: the tx is on chain by then, from an
 * address anyone watching the chain has already seen do the same thing.
 */
export function scenarioOwner(ownerId: string, role: string): string {
  // `tx_submit_failed` carries no role; an agent's id can start with anything, so with a role only
  // a flow role qualifies.
  if ((role === "" || role.endsWith("-flow")) && /^flow-(whale|launch)/.test(ownerId))
    return "flow";
  if (role === "system" && ownerId !== "oracle" && ownerId !== "keeper")
    return "system";
  return ownerId;
}

function redactTxEvent(
  event: Json,
  policy: SchedulePolicy,
  cursor: RedactionCursor,
): string | typeof HOLD {
  let head: number | null =
    typeof event.headBlock === "number" ? event.headBlock : null;
  if (head === null) {
    // Written by a coordinator from before `headBlock`: dated by the newest block-processing line
    // in front of it. That block was the head at the latest, or the one after it if the tx went out
    // during the next block's pass -- so +1, which is the conservative side.
    if (cursor.lastBlock === null && cursor.lookback)
      cursor.lastBlock = cursor.lookback();
    if (cursor.lastBlock !== null) head = cursor.lastBlock + 1;
  }
  const height = policy.chainHeight ?? null;
  if (height === null) return HOLD;
  if (height !== Number.POSITIVE_INFINITY) {
    if (head === null || height < head + TX_MINED_MARGIN) return HOLD;
  }
  if (policy.kind === "none" && typeof event.ownerId === "string")
    return JSON.stringify({
      ...event,
      ownerId: scenarioOwner(
        event.ownerId,
        typeof event.role === "string" ? event.role : "",
      ),
    });
  return JSON.stringify(event);
}

/**
 * One events.jsonl line for the audience: the line to serve, null to drop it, or HOLD when it may be
 * served later (an environment submission not yet mined). `cursor` carries what the pass has seen
 * of the file so far; a fresh one is fine for a line on its own.
 */
export function redactEvent(
  line: string,
  policy: SchedulePolicy,
  cursor: RedactionCursor = { lastBlock: null },
): string | null | typeof HOLD {
  let event: Json;
  try {
    event = JSON.parse(line) as Json;
  } catch {
    // Not an event (a torn or foreign line): it cannot be inspected, so it is not served.
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (HEAD_EVIDENCE.has(type) && typeof event.blockNumber === "number")
    cursor.lastBlock = Math.max(cursor.lastBlock ?? 0, event.blockNumber);
  switch (type) {
    case "run_started_realtime": {
      // `scenarioRegime` (#187) names the epoch's regime, which rules §3.3 does not publish. The
      // record on disk keeps it (§7 audit and replay); only what is served drops it.
      const { seed: _s, flowSeed: _f, scenarioRegime: _r, ...rest } = event;
      return JSON.stringify(rest);
    }
    case "stress_schedule": {
      // The plan is drawn from the seed before block one. On a practice period what has already
      // happened is public in the price series anyway, and what has not is exactly what the
      // manifest withholds (ADR 0021 §1). In a scenario matrix the kind of a window names the
      // regime, which is what §3.3 keeps from the audience, so nothing of the plan is served.
      if (policy.kind === "none") return null;
      const currentBlock = policy.currentBlock;
      if (currentBlock === null || !Array.isArray(event.events)) return null;
      const start =
        typeof event.runStartBlock === "number" ? event.runStartBlock : 0;
      const past = (event.events as Json[]).filter(
        (w) =>
          typeof w.endBlock === "number" && start + w.endBlock <= currentBlock,
      );
      if (past.length === 0) return null;
      return JSON.stringify({
        ...event,
        events: past,
        redacted: "future windows",
      });
    }
    // It names crash magnitudes; on the list of stress events below anyway, but said outright.
    case "stress_calibration_warning":
      return null;
  }
  if (type.startsWith("stress_")) return redactStressEvent(event, policy);
  const rule = AUDIENCE_EVENTS[type];
  if (rule === undefined) return null;
  if (rule === "tx") return redactTxEvent(event, policy, cursor);
  if (rule === "continuous" && policy.kind === "none") return null;
  if ("stderrTail" in event) {
    const { stderrTail: _e, ...rest } = event;
    return JSON.stringify(rest);
  }
  return line;
}

/** `redactEvent` for a reader that cannot come back for a held line: held is dropped. */
export function redactEventLine(
  line: string,
  policy: SchedulePolicy,
  cursor?: RedactionCursor,
): string | null {
  const out = redactEvent(line, policy, cursor);
  return out === HOLD ? null : out;
}

// blocks.csv columns (core/src/logger.ts BLOCKS_CSV_COLUMNS; new columns are only ever appended).
const BLOCKS_OWNER_COL = 7;
const BLOCKS_ROLE_COL = 8;

/** One blocks.csv row for the audience of a scenario epoch: a regime-naming owner collapsed. */
export function redactBlocksRow(line: string): string {
  const cols = line.split(",");
  if (cols.length <= BLOCKS_ROLE_COL) return line;
  const owner = cols[BLOCKS_OWNER_COL];
  const collapsed = scenarioOwner(owner, cols[BLOCKS_ROLE_COL]);
  if (collapsed === owner) return line;
  cols[BLOCKS_OWNER_COL] = collapsed;
  return cols.join(",");
}

/**
 * A request path relative to runs/, with "." and ".." resolved, or null when it climbs out. Every
 * check on a request reads this one string: the allowlist and audience checks are prefix/segment
 * matches, and run against the raw path they passed "comp/../other-run/x" (it starts with "comp/")
 * while the file served was other-run's.
 */
/**
 * decodeURIComponent, or null when the path is not valid percent-encoding. A malformed escape
 * ("/runs/%") makes it throw, and the throw left the request handler: one unauthenticated request
 * ended the hosted process every viewer shares (issue #203).
 */
function decodeComponent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function normalizeRel(rel: string): string | null {
  const clean = path.posix.normalize(rel.replace(/^\/+/, ""));
  if (clean === ".." || clean.startsWith("../") || path.posix.isAbsolute(clean)) return null;
  return clean;
}

export function createRunsApi(runsDir: string, options: RunsApiOptions = {}) {
  const root = path.resolve(runsDir);
  const mode: DashboardMode = {
    audience: options.audience ?? false,
    standings: options.standings ?? true,
  };
  const allowlist =
    options.competitions && options.competitions.length > 0
      ? [...new Set(options.competitions)]
      : null;

  // Resolve a request path to a real file inside runs/, or null. The prefix check alone would let a
  // symlink under runs/ point anywhere on disk; realpath closes that.
  function resolveInside(rel: string): string | null {
    if (rel.includes("\0")) return null;
    const resolved = path.resolve(root, rel);
    const prefix = root + path.sep;
    if (!resolved.startsWith(prefix)) return null;
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null;
      return real;
    } catch {
      // nonexistent path: keep the prefix-checked resolution so callers can 404 on stat
      return resolved;
    }
  }

  /**
   * The runs/-relative path of a file `resolveInside` returned. Every check on a request reads this
   * rather than the path the request asked for: `resolveInside` follows symlinks (that is what keeps
   * a link from serving the rest of the disk), so a link inside an admitted competition used to point
   * at a run outside the allowlist while the allowlist saw only the asking path (issue #202).
   */
  function relOf(file: string): string {
    try {
      return path.relative(fs.realpathSync(root), file);
    } catch {
      return path.relative(root, file);
    }
  }

  /**
   * A directory is a run when it holds a summary.json, or fresh artifacts still being appended to.
   * A competition directory holds neither: it holds matrix.json, and its scenarios (or segments) are
   * separate run dirs beside it. Both go in the same index, tagged, because the picker offers both —
   * a competition is the outer unit results are read over (ADR 0020), and a run is one draw inside it.
   */
  function classify(rel: string): RunEntry | null {
    const dir = path.join(root, rel);
    try {
      const stat = fs.statSync(path.join(dir, "summary.json"));
      return { id: rel, mtimeMs: stat.mtimeMs };
    } catch {
      try {
        const stat = fs.statSync(path.join(dir, "matrix.json"));
        return { id: rel, mtimeMs: stat.mtimeMs, kind: "matrix" };
      } catch {
        // neither — fall through to the live check below
      }
      const freshest = ["events.jsonl", "blocks.csv"]
        .map((f) => {
          try {
            return fs.statSync(path.join(dir, f)).mtimeMs;
          } catch {
            return 0;
          }
        })
        .reduce((a, b) => Math.max(a, b), 0);
      if (freshest > 0 && Date.now() - freshest < LIVE_FRESHNESS_MS)
        return { id: rel, mtimeMs: freshest, live: true };
      return null;
    }
  }

  function collect(rel: string, depth: number): RunEntry[] {
    const dir = path.join(root, rel);
    const children = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    return children.flatMap((child) => {
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      const run = classify(childRel);
      // A competition dir is not a leaf: its segments live inside it, and they are runs.
      if (run && run.kind !== "matrix") return [run];
      if (depth >= MAX_RUN_DEPTH) return run ? [run] : [];
      let inner: RunEntry[] = [];
      try {
        inner = collect(childRel, depth + 1);
      } catch {
        inner = [];
      }
      return run ? [run, ...inner] : inner;
    });
  }

  /**
   * The run dir a competition's scenario resolves to, relative to runs/. The same two layouts the
   * dashboard's `scenarioRunId` knows: a matrix writes its scenarios beside its index
   * (`runs/<scenario>`), a practice period writes its segments inside it (`runs/<period>/<day>`).
   */
  function scenarioRunIdOf(competitionId: string, runDir: string): string {
    const rel = runDir.replace(/^\.?\/?runs\//, "").replace(/^\/+/, "");
    if (rel.startsWith(`${competitionId}/`)) return rel;
    const name = rel.split("/").filter(Boolean).pop() ?? rel;
    const cut = competitionId.lastIndexOf("/");
    return `${cut === -1 ? "" : competitionId.slice(0, cut + 1)}${name}`;
  }

  /**
   * Which entries the allowlist admits: a listed competition, every run its matrix.json names, and
   * anything nested inside its directory (a practice period's segments, its `current-segment`
   * pointer). Nothing else, and in particular nothing chosen by inference.
   *
   * A scenario matrix's *running* epoch is therefore not served until it completes, because it is a
   * sibling directory that nothing yet connects to the matrix -- `matrix.json` gains the entry when
   * the scenario finishes (core/src/cli/backtest.ts flushes after each one). Admitting "whatever is
   * live" instead would admit every live directory under runs/, since a 60-epoch matrix is
   * incomplete for the entire competition. A practice period is unaffected: its current segment
   * lives inside the period's own directory, so it is admitted by containment and the live view
   * works exactly as before.
   *
   * Read alongside the index walk, so it is held for the same three seconds.
   */
  function admitted(entries: RunEntry[]): RunEntry[] {
    if (!allowlist) return entries;
    const ids = new Set<string>();
    for (const comp of allowlist) {
      ids.add(comp);
      let file: Json;
      try {
        file = JSON.parse(
          fs.readFileSync(path.join(root, comp, "matrix.json"), "utf8"),
        ) as Json;
      } catch {
        // not a competition (yet): the id itself stays admitted, so a period whose first segment
        // has not opened is not a 404 for the seconds before it does
        continue;
      }
      const scenarios = Array.isArray(file.scenarios)
        ? (file.scenarios as Json[])
        : [];
      for (const s of scenarios)
        if (typeof s.runDir === "string")
          ids.add(scenarioRunIdOf(comp, s.runDir));
    }
    return entries.filter(
      (e) =>
        ids.has(e.id) ||
        allowlist.some((comp) => e.id.startsWith(`${comp}/`)),
    );
  }

  let indexCache: { at: number; entries: RunEntry[] } | null = null;
  function index(): RunEntry[] {
    if (indexCache && Date.now() - indexCache.at < INDEX_CACHE_MS)
      return indexCache.entries;
    let entries: RunEntry[];
    try {
      entries = admitted(
        collect("", 0).sort((a, b) => b.mtimeMs - a.mtimeMs),
      );
    } catch {
      // no runs/ directory yet — an empty index is the honest answer
      entries = [];
    }
    indexCache = { at: Date.now(), entries };
    return entries;
  }

  /**
   * The manifest a self-hosted participant starts an agent from (issue #156): the newest live run's,
   * else the newest run's that has one, among the runs this server admits. On the hosted box that is
   * the practice period's current segment. A fixed URL, because the file it resolves to moves -- a
   * new segment every day, a new competition (and a new PriceFeed) at every restart -- and the guide
   * has to be able to name one command that fetches the right file.
   */
  function currentManifest(): string | null {
    const withManifest = index().filter(
      (e) =>
        e.kind !== "matrix" &&
        fs.existsSync(path.join(root, e.id, "manifest.json")),
    );
    const pick = withManifest.find((e) => e.live) ?? withManifest[0];
    return pick ? resolveInside(`${pick.id}/manifest.json`) : null;
  }

  /** Whether a file path (relative to runs/) belongs to a run or competition the index admits. */
  function admitsPath(rel: string): boolean {
    if (!allowlist) return true;
    const clean = rel.replace(/^\/+/, "");
    return index().some(
      (e) => clean === e.id || clean.startsWith(`${e.id}/`),
    );
  }

  /** The run dir a file belongs to: the nearest ancestor that is a run or a competition. */
  function isFinishedRunFile(file: string): boolean {
    const dir = path.dirname(file);
    const base = path.basename(file);
    // A competition's own index is rewritten while it runs; a finished run's files are not.
    if (base === "matrix.json" || base === "standings.json") return false;
    try {
      fs.statSync(path.join(dir, "summary.json"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The current block of the run a file belongs to, off the end of its blocks.csv (columns:
   * round,blockNumber,...). Null when the file is missing or has no complete row yet. Used only to
   * split the stress schedule into past and future for the audience.
   */
  function currentBlockOf(file: string): number | null {
    const blocks = path.join(path.dirname(file), "blocks.csv");
    let fd: number | null = null;
    try {
      const size = fs.statSync(blocks).size;
      if (size === 0) return null;
      fd = fs.openSync(blocks, "r");
      const start = Math.max(0, size - BLOCKS_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split("\n");
      // The last element is "" (trailing newline) or a row still being written; the one before is
      // complete. A header row (round,blockNumber,...) yields NaN and is skipped.
      for (let i = lines.length - 1; i >= 0; i--) {
        const cols = lines[i].split(",");
        if (cols.length < 2) continue;
        const n = Number(cols[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  /**
   * Which run this file belongs to, and how much of its stress schedule the audience may see. A
   * scenario matrix's epoch (`resetUnit: scenario`, recorded in summary.json at the end and in
   * run_started_realtime from the start) gets none of it; a continuous world (a practice period)
   * gets the windows that have closed. A run that says neither is treated as a scenario: the
   * cautious default, since the cost of the other mistake is a published regime.
   */
  function schedulePolicyOf(file: string): SchedulePolicy {
    const dir = path.dirname(file);
    let resetUnit: string | undefined;
    let finished = false;
    try {
      const summary = JSON.parse(
        fs.readFileSync(path.join(dir, "summary.json"), "utf8"),
      ) as Json;
      finished = true;
      if (typeof summary.resetUnit === "string") resetUnit = summary.resetUnit;
    } catch {
      // no summary yet (live), or unreadable: fall through to the events header
    }
    if (resetUnit === undefined) {
      try {
        const fd = fs.openSync(path.join(dir, "events.jsonl"), "r");
        try {
          const buf = Buffer.alloc(64 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          const m = /"resetUnit":"([a-z]+)"/.exec(buf.subarray(0, n).toString("utf8"));
          if (m) resetUnit = m[1];
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // no events file either
      }
    }
    const currentBlock = currentBlockOf(file);
    const eventsFile = path.join(dir, "events.jsonl");
    // Mined as far as either record says. blocks.csv alone is not enough: a run that is not
    // segmented writes it in one pass at the end, so for its whole life it says nothing.
    const chainHeight = finished
      ? Number.POSITIVE_INFINITY
      : maxOrNull(currentBlock, headBlockBefore(eventsFile, null));
    return resetUnit === "continuous"
      ? {
          kind: "past",
          currentBlock,
          windows: windowsOf(eventsFile),
          chainHeight,
        }
      : { kind: "none", chainHeight };
  }

  /**
   * The newest block a head-evidence line (`round_timing`, a venue's per-block state, an interval
   * boundary) names in the 64KB of events.jsonl before `end` (null = the end of the file). Every
   * block writes several of them, so the window always holds one once the run is under way.
   */
  function headBlockBefore(eventsFile: string, end: number | null): number | null {
    let fd: number | null = null;
    try {
      const size = end ?? fs.statSync(eventsFile).size;
      const start = Math.max(0, size - HEAD_LOOKBACK_BYTES);
      if (size <= start) return null;
      fd = fs.openSync(eventsFile, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let best: number | null = null;
      for (const line of buf.toString("utf8").split("\n")) {
        const type = /"type":"([a-z_]+)"/.exec(line)?.[1];
        if (!type || !HEAD_EVIDENCE.has(type)) continue;
        const block = /"blockNumber":(\d+)/.exec(line)?.[1];
        if (block !== undefined) best = maxOrNull(best, Number(block));
      }
      return best;
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  // The schedule never changes within a file, so it is read once per file -- but only once it has
  // been found: a live run writes it a moment after starting, and caching "none yet" would withhold
  // that run's stress events for good.
  const windowsCache = new Map<string, Array<{ start: number; end: number }>>();
  /** The stress schedule's absolute windows, from the head of an events.jsonl; null if not (yet) there. */
  function windowsOf(
    eventsFile: string,
  ): Array<{ start: number; end: number }> | null {
    const hit = windowsCache.get(eventsFile);
    if (hit) return hit;
    let fd: number | null = null;
    try {
      fd = fs.openSync(eventsFile, "r");
      // Written before the first block, so within the head; a period's schedule of a few hundred
      // windows is ~100KB, hence the generous cap.
      const buf = Buffer.alloc(SCHEDULE_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
        if (!line.includes('"stress_schedule"')) continue;
        try {
          const event = JSON.parse(line) as Json;
          if (event.type !== "stress_schedule") continue;
          const windows = scheduleWindows(event);
          if (windows) windowsCache.set(eventsFile, windows);
          return windows;
        } catch {
          return null; // the line is still being written
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  function acceptsGzip(req: IncomingMessage): boolean {
    const accept = req.headers["accept-encoding"];
    const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
    return /\bgzip\b/.test(value);
  }

  /** Send a body (string or stream) with content type, cache policy and gzip when the client takes it. */
  function send(
    req: IncomingMessage,
    res: ServerResponse,
    body: string | NodeJS.ReadableStream,
    contentType: string,
    cacheControl: string,
  ): void {
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", cacheControl);
    res.setHeader("vary", "accept-encoding");
    const small = typeof body === "string" && body.length < 1024;
    if (!small && acceptsGzip(req)) {
      res.setHeader("content-encoding", "gzip");
      const gz = createGzip();
      gz.pipe(res);
      if (typeof body === "string") gz.end(body);
      else body.pipe(gz);
      return;
    }
    if (typeof body === "string") res.end(body);
    else body.pipe(res);
  }

  /** A file for the audience, line by line through `redact` (null drops the line). */
  function redactedLinesStream(
    file: string,
    redact: (line: string) => string | null,
  ): NodeJS.ReadableStream {
    let carry = "";
    // A multi-byte character can straddle two chunks; the decoder holds its first half back.
    const decoder = new StringDecoder("utf8");
    const transform = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        const text = carry + decoder.write(chunk);
        const lines = text.split("\n");
        carry = lines.pop() ?? "";
        const out: string[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const kept = redact(line);
          if (kept !== null) out.push(kept);
        }
        cb(null, out.length > 0 ? `${out.join("\n")}\n` : "");
      },
      flush(cb) {
        const rest = carry + decoder.end();
        if (rest.trim()) {
          const kept = redact(rest);
          cb(null, kept !== null ? `${kept}\n` : "");
        } else cb(null, "");
      },
    });
    return fs.createReadStream(file).pipe(transform);
  }

  /**
   * events.jsonl for the audience, through the redaction. A line held for later (a submission not
   * yet mined) is dropped here: a whole-file reader does not come back for it. The dashboard reads
   * whole files only for finished runs, where nothing is held; a live run is read by the tail.
   */
  function redactedEventsStream(file: string): NodeJS.ReadableStream {
    const policy = schedulePolicyOf(file);
    const cursor: RedactionCursor = { lastBlock: null };
    return redactedLinesStream(file, (line) =>
      redactEventLine(line, policy, cursor),
    );
  }

  /**
   * blocks.csv for the audience, when the run is a scenario epoch: the regime-naming owners
   * collapsed (`scenarioOwner`). Null for a continuous world, which is served as written.
   */
  function blocksRedactionOf(file: string): ((line: string) => string) | null {
    return schedulePolicyOf(file).kind === "none" ? redactBlocksRow : null;
  }

  /**
   * Handle a request whose path is relative to the /runs mount ("/index.json", "/<id>/summary.json").
   * Returns false when nothing here matched, so the caller can fall through to its own 404.
   */
  return function handle(
    urlPath: string,
    query: string | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    if (urlPath === "/index.json") {
      send(req, res, JSON.stringify(index()), "application/json", CACHE_SHORT);
      return true;
    }
    if (urlPath === "/manifest.json") {
      const file = currentManifest();
      if (!file) {
        res.statusCode = 404;
        res.end();
        return true;
      }
      // Short-lived: registrations rewrite it mid-segment, and a restart replaces it altogether.
      send(req, res, fs.createReadStream(file), "application/json", CACHE_SHORT);
      return true;
    }
    if (urlPath === "/mode.json") {
      send(
        req,
        res,
        JSON.stringify(mode),
        "application/json",
        "public, max-age=30",
      );
      return true;
    }

    // A run id can contain slashes (a collected remote run, or a period's segment), so the split is
    // on the last "/tail/" rather than on the first path segment.
    const tailAt = urlPath.lastIndexOf("/tail/");
    if (tailAt > 0) {
      const head = decodeComponent(urlPath.slice(1, tailAt));
      const name = decodeComponent(urlPath.slice(tailAt + "/tail/".length));
      if (head === null || name === null) {
        res.statusCode = 400;
        res.end();
        return true;
      }
      const rel = normalizeRel(`${head}/${name}`);
      if (rel === null) {
        res.statusCode = 403;
        res.end();
        return true;
      }
      const file = resolveInside(rel);
      const checked = file === null ? rel : relOf(file);
      const admitted = admitsPath(checked);
      if (
        !file ||
        !/\.(jsonl|csv)$/.test(file) ||
        (mode.audience && !audienceAllows(checked)) ||
        !admitted
      ) {
        res.statusCode = mode.audience || !admitted ? 404 : 403;
        res.end();
        return true;
      }
      const params = new URLSearchParams(query ?? "");
      const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);
      // An explicit cap, for readers that only want the head of a file. The run-start and
      // stress-schedule events are written before the first block, so they sit in the first few KB
      // of events.jsonl — reading 128KB of each of a matrix's 35 scenarios costs 4MB where reading
      // the files costs 102MB, for exactly the same answer.
      const limit = Math.min(
        TAIL_CHUNK_BYTES,
        Math.max(1, Number(params.get("limit") ?? 0) || TAIL_CHUNK_BYTES),
      );
      const redactEvents =
        mode.audience && path.basename(file) === "events.jsonl";
      const redactBlocks =
        mode.audience && path.basename(file) === "blocks.csv"
          ? blocksRedactionOf(file)
          : null;
      fs.stat(file, (err, stat) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", CACHE_NONE);
        if (err || !stat.isFile()) {
          res.end(JSON.stringify({ offset: 0, text: "", missing: true }));
          return;
        }
        const start = Math.min(offset, stat.size);
        if (start >= stat.size) {
          res.end(JSON.stringify({ offset: stat.size, text: "" }));
          return;
        }
        const end = Math.min(stat.size, start + limit) - 1;
        const chunks: Buffer[] = [];
        fs.createReadStream(file, { start, end })
          .on("data", (c) => chunks.push(c as Buffer))
          .on("end", () => {
            const raw = Buffer.concat(chunks);
            if (!redactEvents && !redactBlocks) {
              res.end(
                JSON.stringify({ offset: end + 1, text: raw.toString("utf8") }),
              );
              return;
            }
            // Whole lines only: a line cut mid-way cannot be inspected, and half of a schedule is
            // still a schedule. The client polls again from the returned offset.
            const cut = raw.lastIndexOf(0x0a);
            if (cut < 0) {
              res.end(JSON.stringify({ offset: start, text: "" }));
              return;
            }
            if (redactBlocks) {
              const rows = raw.subarray(0, cut).toString("utf8").split("\n");
              res.end(
                JSON.stringify({
                  offset: start + cut + 1,
                  text: `${rows.map(redactBlocks).join("\n")}\n`,
                }),
              );
              return;
            }
            const policy = schedulePolicyOf(file);
            const cursor: RedactionCursor = {
              lastBlock: null,
              lookback: () => headBlockBefore(file, start),
            };
            const kept: string[] = [];
            // Walked by byte offset, so that a held line can be the next request's start: the tail
            // stops in front of it (and of everything after it -- the stream is ordered) and the
            // client asks again from there. Skipping it instead would lose it for good.
            let next = start + cut + 1;
            let from = 0;
            while (from < cut) {
              const nl = raw.indexOf(0x0a, from);
              const stop = nl < 0 || nl > cut ? cut : nl;
              const line = raw.subarray(from, stop).toString("utf8");
              if (line.trim()) {
                const out = redactEvent(line, policy, cursor);
                if (out === HOLD) {
                  next = start + from;
                  break;
                }
                if (out !== null) kept.push(out);
              }
              from = stop + 1;
            }
            res.end(
              JSON.stringify({
                offset: next,
                text: kept.length > 0 ? `${kept.join("\n")}\n` : "",
              }),
            );
          })
          .on("error", () => {
            res.end(JSON.stringify({ offset: start, text: "" }));
          });
      });
      return true;
    }

    const decoded = decodeComponent(urlPath.replace(/^\//, ""));
    if (decoded === null) {
      res.statusCode = 400;
      res.end();
      return true;
    }
    const rel = normalizeRel(decoded);
    const file = rel === null ? null : resolveInside(rel);
    if (rel === null || !file) {
      res.statusCode = 403;
      res.end();
      return true;
    }
    const checked = relOf(file);
    if ((mode.audience && !audienceAllows(checked)) || !admitsPath(checked)) {
      // 404, not 403: for the audience an unpublished file does not exist, and a different status
      // for "exists but withheld" would confirm what is there to withhold. The same for a run
      // outside the allowlist: it is not on this server as far as a reader can tell.
      res.statusCode = 404;
      res.end();
      return true;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const contentType = file.endsWith(".json")
      ? "application/json"
      : "text/plain; charset=utf-8";
    const cache = isFinishedRunFile(file) ? CACHE_IMMUTABLE : CACHE_SHORT;
    const base = path.basename(file);

    if (mode.audience && base === "events.jsonl") {
      send(req, res, redactedEventsStream(file), contentType, cache);
      return true;
    }
    const blocksRedact =
      mode.audience && base === "blocks.csv" ? blocksRedactionOf(file) : null;
    if (blocksRedact) {
      send(req, res, redactedLinesStream(file, blocksRedact), contentType, cache);
      return true;
    }
    if (mode.audience && REDACTED_JSON[base]) {
      fs.readFile(file, "utf8", (err, text) => {
        if (err) {
          res.statusCode = 500;
          res.end();
          return;
        }
        let out = text;
        try {
          out = `${JSON.stringify(REDACTED_JSON[base](JSON.parse(text) as Json), null, 2)}\n`;
        } catch {
          // Not JSON after all (a half-written file): serve nothing rather than the raw text.
          res.statusCode = 503;
          res.end();
          return;
        }
        send(req, res, out, contentType, cache);
      });
      return true;
    }
    send(req, res, fs.createReadStream(file), contentType, cache);
    return true;
  };
}
