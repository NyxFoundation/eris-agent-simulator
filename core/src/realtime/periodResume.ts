// Resuming a practice period after the coordinator restarts.
//
// Every start of the coordinator used to be a new period: it reverted the chain to the setup
// snapshot, funded everyone again, deployed a new PriceFeed and opened a new competition directory.
// That is right for a run that is one world of its own (a scenario, a smoke run) and wrong for a
// period that is weeks of one world. On 2026-10-08 a disk-full crash and systemd's restart turned
// into a revert of 2.5 days of chain; and a config change -- the priority-fee cap -- could only
// land by throwing the standings away.
//
// The chain already survives a restart (anvil --state). What did not was the environment's own
// state, which lived only in this process's memory. So the coordinator writes it down at the end of
// every pass -- resume/state.json in the competition directory -- and a start that finds an
// unfinished period continues it instead of opening a new one:
//
//   price walk     the OU levels and each stream's position (counter mode makes that exact)
//   period clock   runStartBlock, runBlocks and the instant the day grid was cut from
//   roster         who is registered, at what address, funded with what (V_0's floor)
//   scorer         its bookkeeping; the boundary values themselves are the intervals.jsonl lines
//   stress         the baselines a depeg or liquidity pull measured at the start (measured again
//                  mid-window they would be the depegged peg and the pulled depth)
//   artifacts      how far each file the coordinator appends to had got
//
// Which checkpoint: the newest one whose block is on the chain with the same hash. A coordinator
// crash leaves the chain at or ahead of state.json, and the first pass catches up. An anvil restart
// brings the chain back up to five minutes (its --state-interval) -- behind state.json -- and the
// history kept every CHECKPOINT_HISTORY_EVERY_BLOCKS blocks has one at or before the head: the
// period resumes from there with every artifact cut back to it. A chain none of them is on (reset,
// redeployed, another chain) is refused, never silently started over.
//
// What may change across a restart is a short list (MUTABLE_CONFIG_KEYS). Everything else that
// describes the world has to be the same, and a refusal names what differs.
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { AgentSpec, BalanceSnapshot } from "@eris/sdk/types.js";
import type { RngSnapshot } from "@eris/sdk/rng.js";
import type { LiveScorerSnapshot } from "./liveScoring.js";
import type { DerivedSender } from "./derivedSenders.js";
import type { StressAudit } from "./stressAudit.js";
import type { SegmentedRunState, SegmentIndexEntry } from "../segments.js";
import { INTERVALS_FILENAME } from "../intervalSeries.js";

/** The directory inside a competition directory that holds its checkpoints. */
export const RESUME_DIR = "resume";
const STATE_FILE = "state.json";
const HISTORY_DIR = "history";
const CLOSED_FILE = "closed.json";

/**
 * A file in the run root (`run.reportDir`) that asks the next start for a new period. For the
 * systemd unit, whose command line is fixed: `touch runs/NEW_PERIOD` and restart. Removed once the
 * new period has written its first checkpoint, so a crash during its setup tries the new period
 * again rather than resuming the one it replaced.
 */
export const NEW_PERIOD_MARKER = "NEW_PERIOD";

/** How often (in blocks) state.json is also kept in the history a rewind picks from. */
export const CHECKPOINT_HISTORY_EVERY_BLOCKS = 30;
/** How many of those are kept: 40 x 30 blocks is 40 minutes at the practice cadence. */
export const CHECKPOINT_HISTORY_KEEP = 40;

export const CHECKPOINT_SCHEMA = 1;

// The files the coordinator appends to in a segment directory. blocks.csv, intervals.jsonl and
// market.jsonl are derived from the chain for every block the loop processes, so whatever was
// written past the checkpoint would be written again: they are always cut back to it. events.jsonl
// is the run's log; it is cut only when the chain itself went back, because past that point it
// describes blocks that no longer exist. Otherwise it keeps whatever the crash left in it.
export const REDERIVED_FILES = [
  "blocks.csv",
  INTERVALS_FILENAME,
  "market.jsonl",
] as const;
export const LOG_FILES = ["events.jsonl"] as const;

export type CheckpointAgent = {
  id: string;
  // Where the entry came from: the config's roster, or the registrations file. The config's roster
  // has to be the same on a resume; the file's entries are whatever registered.
  origin: "config" | "file";
  spec: AgentSpec;
  address: string;
  external: boolean;
  initial: BalanceSnapshot;
  included: number;
  reverted: number;
  exitedEarly?: string;
};

export type PeriodCheckpoint = {
  schema: number;
  writtenAt: string;
  competitionId: string;
  chainId: number;
  // The pass this was written after, and the chain block that pass ended on.
  lastProcessedBlock: number;
  lastProcessedHash: string;
  // The period's clock, as it was declared at the first start.
  runStartBlock: number;
  runBlocks: number;
  endBlock: number | null;
  runStartedAtMs: number;
  // What the period is (configWorld) and what was allowed to differ at the last start.
  world: Record<string, unknown>;
  mutable: Record<string, unknown>;
  // Whether this period can be resumed at all, and if not why (resumeUnsupportedReasons).
  resumable: { ok: boolean; reasons: string[] };
  // Starts of this period so far, the first included. Names the flow bot's stream after a resume.
  starts: number;
  priceFeed: string;
  walk: {
    baseFair: number;
    fairAnchor: number;
    extraBaseFair: Record<string, number>;
    extraAnchor: Record<string, number>;
    latestFairPrice: number;
    fairPrices: Record<string, number>;
    rng: Record<string, RngSnapshot>;
  };
  agents: CheckpointAgent[];
  loggedThroughBlock: number;
  derivedSenders: DerivedSender[];
  stressAudit: ReturnType<StressAudit["snapshot"]>;
  scorer: LiveScorerSnapshot;
  segments: SegmentedRunState;
  // Sizes, in bytes, of the current segment's appended files when this was written.
  files: Record<string, number>;
  liquidityPull: {
    seededShares: Record<string, bigint>;
    restoreReported: boolean;
  } | null;
  depegs: Array<{
    symbol: string;
    seededPoolStableWei: bigint;
    startStableWei: bigint;
    cappedReported: boolean;
  }>;
  lstExhaustedReported: boolean;
};

// ---- encoding: JSON with tagged bigints, so every bigint comes back a bigint ----

const BIGINT_TAG = "$bigint";

export function encodeCheckpoint(cp: PeriodCheckpoint): string {
  return `${JSON.stringify(
    cp,
    (_key, value) =>
      typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value,
    1,
  )}\n`;
}

export function decodeCheckpoint(text: string): PeriodCheckpoint {
  const cp = JSON.parse(text, (_key, value) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof value[BIGINT_TAG] === "string"
    )
      return BigInt(value[BIGINT_TAG]);
    return value;
  }) as PeriodCheckpoint;
  if (cp.schema !== CHECKPOINT_SCHEMA)
    throw new Error(
      `checkpoint schema ${cp.schema} is not the one this coordinator writes (${CHECKPOINT_SCHEMA})`,
    );
  return cp;
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function resumeDir(competitionDir: string): string {
  return join(competitionDir, RESUME_DIR);
}

function historyFiles(
  competitionDir: string,
): Array<{ block: number; path: string }> {
  const dir = join(resumeDir(competitionDir), HISTORY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => ({ block: Number(f.slice(0, -5)), path: join(dir, f) }))
    .sort((a, b) => a.block - b.block);
}

/** Writes state.json every pass, and keeps a copy every CHECKPOINT_HISTORY_EVERY_BLOCKS blocks. */
export class CheckpointWriter {
  private lastHistoryBlock: number;

  constructor(readonly competitionDir: string) {
    mkdirSync(join(resumeDir(competitionDir), HISTORY_DIR), {
      recursive: true,
    });
    this.lastHistoryBlock =
      historyFiles(competitionDir).at(-1)?.block ?? Number.NEGATIVE_INFINITY;
  }

  write(cp: PeriodCheckpoint): void {
    const text = encodeCheckpoint(cp);
    atomicWrite(join(resumeDir(this.competitionDir), STATE_FILE), text);
    if (
      cp.lastProcessedBlock - this.lastHistoryBlock <
      CHECKPOINT_HISTORY_EVERY_BLOCKS
    )
      return;
    const name = `${String(cp.lastProcessedBlock).padStart(12, "0")}.json`;
    atomicWrite(join(resumeDir(this.competitionDir), HISTORY_DIR, name), text);
    this.lastHistoryBlock = cp.lastProcessedBlock;
    const kept = historyFiles(this.competitionDir);
    for (const old of kept.slice(
      0,
      Math.max(0, kept.length - CHECKPOINT_HISTORY_KEEP),
    ))
      rmSync(old.path, { force: true });
  }
}

// ---- which periods are open ----

export type OpenPeriod = {
  competitionDir: string;
  competitionId: string;
  state: PeriodCheckpoint;
};

/** Periods under `root` that have a checkpoint and were neither finished nor superseded, newest first. */
export function openPeriods(root: string): OpenPeriod[] {
  if (!existsSync(root)) return [];
  const out: OpenPeriod[] = [];
  for (const name of readdirSync(root)) {
    const competitionDir = join(root, name);
    const state = join(resumeDir(competitionDir), STATE_FILE);
    if (!existsSync(state)) continue;
    if (existsSync(join(resumeDir(competitionDir), CLOSED_FILE))) continue;
    out.push({
      competitionDir,
      competitionId: name,
      state: decodeCheckpoint(readFileSync(state, "utf8")),
    });
  }
  return out.sort((a, b) => b.state.runStartedAtMs - a.state.runStartedAtMs);
}

/** Mark a period as not to be resumed: it finished, or a new period replaced it. */
export function closePeriod(competitionDir: string, reason: string): void {
  const dir = resumeDir(competitionDir);
  if (!existsSync(dir)) return;
  writeFileSync(
    join(dir, CLOSED_FILE),
    `${JSON.stringify({ closedAt: new Date().toISOString(), reason }, null, 1)}\n`,
  );
}

export function newPeriodRequested(root: string): boolean {
  return existsSync(join(root, NEW_PERIOD_MARKER));
}

export function clearNewPeriodRequest(root: string): void {
  rmSync(join(root, NEW_PERIOD_MARKER), { force: true });
}

// ---- which checkpoint the chain is on ----

export type ChainView = {
  head: number;
  hashAt(block: number): Promise<string | null>;
};

export type CheckpointChoice =
  | { kind: "match"; checkpoint: PeriodCheckpoint; rewound: boolean }
  | { kind: "refused"; reason: string };

/**
 * The newest checkpoint of `period` whose block is on the chain with the hash it was written with.
 * `rewound` is true when that is not state.json: the chain went back past the latest pass.
 */
export async function chooseCheckpoint(
  period: OpenPeriod,
  chain: ChainView,
): Promise<CheckpointChoice> {
  const candidates: PeriodCheckpoint[] = [period.state];
  for (const h of historyFiles(period.competitionDir).reverse()) {
    if (h.block >= period.state.lastProcessedBlock) continue;
    try {
      candidates.push(decodeCheckpoint(readFileSync(h.path, "utf8")));
    } catch {
      // A history file that does not parse is one fewer place to go back to, not a reason to stop.
    }
  }
  const tried: string[] = [];
  for (const cp of candidates) {
    if (cp.lastProcessedBlock > chain.head) {
      tried.push(`${cp.lastProcessedBlock} (past the head)`);
      continue;
    }
    const hash = await chain.hashAt(cp.lastProcessedBlock);
    if (
      hash !== null &&
      hash.toLowerCase() === cp.lastProcessedHash.toLowerCase()
    )
      return {
        kind: "match",
        checkpoint: cp,
        rewound: cp.lastProcessedBlock < period.state.lastProcessedBlock,
      };
    tried.push(
      `${cp.lastProcessedBlock} (hash ${hash ?? "none"} != ${cp.lastProcessedHash})`,
    );
  }
  return {
    kind: "refused",
    reason:
      `the chain (head ${chain.head}) holds none of period ${period.competitionId}'s checkpoints: ` +
      `${tried.join(", ")}. The chain was reset, redeployed or replaced since the period last ran`,
  };
}

// ---- what the period is, and what may change ----

/**
 * Config keys that may differ when a period resumes: the fee rule (the change that motivated this),
 * the flow wallets' refill cadence, and operational knobs that do not describe the world.
 */
export const MUTABLE_CONFIG_KEYS = [
  "defaultPriorityFeeWei",
  "maxPriorityFeeWei",
  "economicGas",
  "flowTopUpEveryBlocks",
  "registrationsFile",
  "agentsReadyTimeoutSec",
  "agentStateQuotaBytes",
  "agentLogQuotaBytes",
  "agentDiskCheckEveryBlocks",
  "agentSandbox",
  "rosterTransferFlagBps",
] as const;

// Keys that belong to this process rather than to the period: endpoints, keys (the period records
// the addresses they derive, not the keys), paths, and the two run lengths -- runBlocks is the date
// converted at the first start (the checkpoint keeps it), runSeconds a ceiling on the process.
const PROCESS_KEYS = new Set([
  "rpcUrl",
  "readRpcUrl",
  "publicRpcUrl",
  "treasuryPrivateKey",
  "externalRoleEthWei",
  "forkUrl",
  "forkBlockNumber",
  "runSeconds",
  "runBlocks",
  "skipReset",
  "localSnapshotFile",
  "runMode",
  "agentTimeoutMs",
  "agentsConfigPath",
  "agentsDir",
  "flowBotCommand",
  "flowBotArgs",
  "privateKeys",
  "runDirRoot",
]);

function plain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ) ?? "null",
  );
}

/**
 * What the period is, from its config. Every key but the mutable and process-local ones, so a
 * config field added later is part of the world until someone decides otherwise: a refusal that
 * names it costs a restart, a silent change of world costs the period.
 */
export function configWorld(
  config: Record<string, unknown>,
  extras: Record<string, unknown>,
): Record<string, unknown> {
  const mutable = new Set<string>(MUTABLE_CONFIG_KEYS);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(config).sort()) {
    if (mutable.has(key) || PROCESS_KEYS.has(key)) continue;
    out[key] = plain(config[key]);
  }
  for (const [key, value] of Object.entries(extras))
    out[`$${key}`] = plain(value);
  return out;
}

export function configMutable(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MUTABLE_CONFIG_KEYS) out[key] = plain(config[key]);
  return out;
}

/** The keys whose values differ, each as `key: saved -> now`. */
export function configDiff(
  saved: Record<string, unknown>,
  now: Record<string, unknown>,
): string[] {
  const keys = [
    ...new Set([...Object.keys(saved), ...Object.keys(now)]),
  ].sort();
  const show = (v: unknown): string => {
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  };
  return keys
    .filter((k) => JSON.stringify(saved[k]) !== JSON.stringify(now[k]))
    .map((k) => `${k}: ${show(saved[k])} -> ${show(now[k])}`);
}

/** A roster entry as it bears on the world: who, which key or address, what runs it. */
export function rosterIdentity(spec: AgentSpec): Record<string, unknown> {
  return plain({
    id: spec.id,
    wallet: spec.wallet ?? null,
    address: spec.address?.toLowerCase() ?? null,
    dir: spec.dir ?? null,
    command: spec.command ?? null,
    args: spec.args ?? null,
    env: spec.env ?? null,
    external: spec.external === true,
    baseline: spec.baseline === true,
    participant: spec.participant ?? null,
  }) as Record<string, unknown>;
}

/**
 * Why a period of this config cannot be resumed, if it cannot. These keep state the checkpoint does
 * not carry (a registry's queue, a launch's wave, victims staged on the fresh chain); none is in the
 * practice config, and a period that has one is refused at the restart rather than resumed wrong.
 */
export function resumeUnsupportedReasons(opts: {
  agentMarkets: boolean;
  tokenLaunch: boolean;
  vulnEvents: boolean;
  stressVictims: number;
  liquityVictims: number;
  prewarmBlocks: number;
}): string[] {
  const reasons: string[] = [];
  if (opts.agentMarkets)
    reasons.push(
      "agentMarkets (the registry's pending queue and sweep cursor are not checkpointed)",
    );
  if (opts.tokenLaunch)
    reasons.push(
      "tokenLaunch events (each launch's wave state is not checkpointed)",
    );
  if (opts.vulnEvents)
    reasons.push("vuln events (the pools' funding state is not checkpointed)");
  if (opts.stressVictims > 0)
    reasons.push("stress.victimCount (victims are staged on a fresh chain)");
  if (opts.liquityVictims > 0)
    reasons.push(
      "stress.liquityVictimCount (victims are staged on a fresh chain)",
    );
  if (opts.prewarmBlocks > 0)
    reasons.push(
      "run.prewarmBlocks (the warm-up trades before the period starts)",
    );
  return reasons;
}

// ---- artifacts ----

export function segmentFileSizes(segmentDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of [...REDERIVED_FILES, ...LOG_FILES]) {
    const path = join(segmentDir, name);
    out[name] = existsSync(path) ? statSync(path).size : 0;
  }
  return out;
}

export type CutReport = {
  cutDir: string;
  movedSegments: string[];
  movedFiles: string[];
  truncated: Array<{ file: string; fromBytes: number; toBytes: number }>;
};

const SEGMENT_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}-s(\d+)$/;

function copyTail(path: string, from: number, to: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    writeFileSync(to, buf);
  } finally {
    closeSync(fd);
  }
}

/**
 * Put the competition directory back where the checkpoint was written. What is taken out is kept
 * under resume/cut-<time>/ rather than deleted: it is the record of what the chain no longer holds,
 * or of a pass that never finished.
 *
 *   - segments opened after the checkpoint's (a roll the checkpoint did not see) are moved out
 *   - the checkpoint's segment is open again, so a summary.json a roll wrote for it is moved out
 *   - the rederived files are cut to the checkpoint's sizes; events.jsonl too when `rewound`
 *   - history checkpoints past the one resumed from are dropped when `rewound` (a dead chain's)
 */
export function cutArtifactsToCheckpoint(
  competitionDir: string,
  cp: PeriodCheckpoint,
  opts: { rewound: boolean; at?: Date },
): CutReport {
  const stamp = (opts.at ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const cutDir = join(resumeDir(competitionDir), `cut-${stamp}`);
  const report: CutReport = {
    cutDir,
    movedSegments: [],
    movedFiles: [],
    truncated: [],
  };
  const ensureCutDir = (sub = ""): string => {
    const dir = join(cutDir, sub);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const current = cp.segments.segmentDirId;
  for (const name of readdirSync(competitionDir)) {
    const m = SEGMENT_DIR_PATTERN.exec(name);
    if (!m || name === current) continue;
    if (Number(m[1]) <= cp.segments.segment) continue;
    renameSync(join(competitionDir, name), join(ensureCutDir(), name));
    report.movedSegments.push(name);
  }

  const segmentDir = join(competitionDir, current);
  if (!existsSync(segmentDir))
    throw new Error(
      `the checkpoint's segment directory ${segmentDir} is missing: the period's artifacts were moved or deleted`,
    );
  const summary = join(segmentDir, "summary.json");
  if (existsSync(summary)) {
    renameSync(summary, join(ensureCutDir(current), "summary.json"));
    report.movedFiles.push(`${current}/summary.json`);
  }

  const files = [...REDERIVED_FILES, ...(opts.rewound ? LOG_FILES : [])];
  for (const name of files) {
    const path = join(segmentDir, name);
    if (!existsSync(path)) continue;
    const saved = cp.files[name] ?? 0;
    const size = statSync(path).size;
    if (size <= saved) continue;
    copyTail(path, saved, join(ensureCutDir(current), name));
    truncateSync(path, saved);
    report.truncated.push({
      file: `${current}/${name}`,
      fromBytes: size,
      toBytes: saved,
    });
  }

  if (opts.rewound)
    for (const h of historyFiles(competitionDir))
      if (h.block > cp.lastProcessedBlock) rmSync(h.path, { force: true });

  return report;
}

/** The segment index matrix.json holds, or [] when it has none. */
export function readSegmentIndex(competitionDir: string): SegmentIndexEntry[] {
  const path = join(competitionDir, "matrix.json");
  if (!existsSync(path)) return [];
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    scenarios?: SegmentIndexEntry[];
  };
  return Array.isArray(doc.scenarios) ? doc.scenarios : [];
}

/**
 * Every interval boundary the period has read, in order: the intervals.jsonl lines of each segment
 * up to and including the checkpoint's. Each line holds every agent's value at its boundary, so the
 * files are the series; the checkpoint only says how far into the current one to trust.
 */
export function readPeriodBoundaries(
  competitionDir: string,
  cp: PeriodCheckpoint,
): Array<{ blockNumber: number; values: Record<string, number | null> }> {
  const dirs = readSegmentIndex(competitionDir)
    .filter((e) => e.seed < cp.segments.segment)
    .sort((a, b) => a.seed - b.seed)
    .map((e) => basename(e.runDir));
  dirs.push(cp.segments.segmentDirId);
  const out: Array<{
    blockNumber: number;
    values: Record<string, number | null>;
  }> = [];
  for (const dir of dirs) {
    const path = join(competitionDir, dir, INTERVALS_FILENAME);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as {
        blockNumber: number;
        values: Record<string, number | null>;
      };
      out.push({ blockNumber: row.blockNumber, values: row.values ?? {} });
    }
  }
  return out;
}

/** Copy a checkpoint aside (the one a resume started from), for the record. */
export function keepResumedCheckpoint(
  competitionDir: string,
  cp: PeriodCheckpoint,
  cutDir: string,
): void {
  mkdirSync(cutDir, { recursive: true });
  const src = join(resumeDir(competitionDir), STATE_FILE);
  if (existsSync(src))
    copyFileSync(src, join(cutDir, "state.before-resume.json"));
  writeFileSync(join(cutDir, "resumed-from.json"), encodeCheckpoint(cp));
}
