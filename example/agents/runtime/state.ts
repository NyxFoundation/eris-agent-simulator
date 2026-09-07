/**
 * state.ts: the agent's own disk, and what the reference runtime keeps on it (#77).
 *
 * Every epoch used to start the agent from `agent.ts` as version 0. In-run self-improvement
 * (ADR 0018) was therefore worth at most the remainder of a 360-block epoch and was thrown away
 * forty times over a k = 40 competition. This is the other half of that: a directory only this
 * agent's container sees, mounted at a fixed path, created empty at the start of the competition
 * and surviving every epoch.
 *
 * What the reference runtime writes there is `versions.json` -- the strategies the model installed,
 * with the notes it wrote and the epoch each one went in. A participant's own runtime may write
 * whatever else it likes; the cap is the whole of the contract.
 *
 * Three rules the rest of the file exists to keep:
 *
 *   1. **Fail soft, always.** A state directory that is missing, unreadable, full or corrupt must
 *      never stop the agent trading. It logs and carries on from `agent.ts`, which is exactly the
 *      behavior of every epoch before this feature existed.
 *   2. **A persisted strategy is untrusted input.** It compiled last epoch under a check that has
 *      since been tightened, or it was written by a model, or the file was edited. It goes through
 *      the cheatcode static check and the vm compile again at load, every time.
 *   3. **Atomic writes.** The epoch can be killed at any block. A half-written versions.json that
 *      is then loaded as the starting strategy is the one failure mode worse than losing the file.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// The directory the environment mounts for this agent. Absent means the run has no persistence,
// which is every existing path: a single backtest, a practice devnet, a matrix without
// --agent-state-root. Absent is not an error.
export const STATE_DIR_ENV = "ERIS_AGENT_STATE_DIR";

// Total bytes the agent may keep, across epochs (rules appendix A). Total rather than per epoch:
// a per-epoch budget would let a patient agent accumulate without limit, and the number the
// organizer has to provision is the total anyway.
export const DEFAULT_STATE_CAP_BYTES = 64 * 1024 * 1024;

export const VERSIONS_FILE = "versions.json";

// Cap on the free-text memory the model may carry between epochs. It exists so the model has
// somewhere to put "what I concluded last epoch" that is not code; without a bound it is a place to
// put the whole observation log, which the state cap would then have to absorb.
export const MAX_MEMORY_CHARS = 4_000;

/// Bound the model's note wherever it is set, not only where it is written.
///
/// Truncating at persist time bounds the *file* and leaves the string unbounded inside the epoch --
/// where it is fed straight back into the next revision context. A model that writes 50 KB of
/// memory would then inflate its own context for the rest of the epoch and only discover the limit
/// after a restart.
export function clampMemory(memory: string): string {
  return memory.length <= MAX_MEMORY_CHARS
    ? memory
    : memory.slice(0, MAX_MEMORY_CHARS);
}

// How many epoch ids are kept. The list is there so the model can see how many epochs it has run
// and which one this is; forty is the whole competition, and a practice devnet that restarts an
// agent hundreds of times must not turn that into a growing file.
export const MAX_EPOCHS_KEPT = 200;

/// Parse the operator's cap. A malformed or negative value falls back to the default rather than
/// disabling the cap, which is the failure that matters: an unbounded state directory on a shared
/// box is one agent's problem becoming everybody's. An explicit 0 is honored -- it means "no
/// persistence", and refusing to honor it would ignore the operator.
export function capBytesFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_STATE_CAP_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STATE_CAP_BYTES;
}

/// One installed strategy, as it survives an epoch boundary.
///
/// `epochId` is what makes the history readable across the boundary: the model can see that a
/// version has now lost two epochs in a row, which is the case `revertTo` exists for and which is
/// invisible if the versions all look like they were installed in one run.
export type PersistedVersion = {
  language?: "typescript" | "python";
  version: number;
  source: string;
  notes: string;
  installedAtBlock: number;
  valueAtInstall: number | null;
  epochId: string;
};

export type PersistedState = {
  schema: 1;
  // Epoch ids in the order this agent saw them. The length is how many epochs it has run.
  epochs: string[];
  versions: PersistedVersion[];
  // The model's own note to its next self, if it wrote one.
  memory?: string;
};

export type StateLoad =
  | { ok: true; state: PersistedState }
  | { ok: false; reason: string }
  | { ok: "absent" };

function dirBytes(dir: string): number {
  let total = 0;
  const walk = (path: string): void => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      try {
        total += statSync(child).size;
      } catch {
        // a file that vanished between readdir and stat is not part of the total
      }
    }
  };
  walk(dir);
  return total;
}

function parseState(raw: string): PersistedState | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.schema !== 1) return null;
  if (!Array.isArray(o.versions)) return null;
  const versions: PersistedVersion[] = [];
  for (const v of o.versions) {
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    // Integers, and only integers. `parseRevision` holds `revertTo` to that standard and this file
    // is the same numbering: a persisted `1.5` would make the next version 2.5, and every version
    // number in the log and the context fractional from then on.
    if (
      !Number.isInteger(r.version) ||
      (r.version as number) < 0 ||
      typeof r.source !== "string"
    )
      return null;
    // Always written by this runtime, so its absence means the file did not come from here. Coercing
    // it to "unknown" would degrade the cross-epoch history to the state this feature exists to fix,
    // silently -- the model would see every version as belonging to no epoch and nothing would say
    // why.
    if (typeof r.epochId !== "string" || r.epochId === "") return null;
    if (r.language !== undefined && r.language !== "typescript" && r.language !== "python") return null;
    versions.push({
      ...(r.language !== undefined ? { language: r.language } : {}),
      version: r.version as number,
      source: r.source,
      notes: typeof r.notes === "string" ? r.notes : "",
      installedAtBlock:
        typeof r.installedAtBlock === "number" ? r.installedAtBlock : 0,
      valueAtInstall:
        typeof r.valueAtInstall === "number" ? r.valueAtInstall : null,
      epochId: r.epochId,
    });
  }
  return {
    schema: 1,
    epochs: Array.isArray(o.epochs)
      ? o.epochs
          .filter((e): e is string => typeof e === "string")
          .slice(-MAX_EPOCHS_KEPT)
      : [],
    versions,
    ...(typeof o.memory === "string" ? { memory: clampMemory(o.memory) } : {}),
  };
}

/// The agent's persistent directory, or nothing.
///
/// Constructed even when the directory is unusable: the caller asks `enabled` and gets a straight
/// answer, rather than having to distinguish "no persistence configured" from "persistence
/// configured and broken" by catching exceptions from every method.
export class AgentStateStore {
  private disabled: string | null = null;

  private constructor(
    readonly dir: string,
    private readonly capBytes: number,
    private readonly onProblem: (reason: string) => void,
  ) {}

  /// Open the store the environment configured, if it configured one.
  ///
  /// `null` means this run has no persistence, which is every path that existed before #77 and
  /// stays the default. A directory that cannot be created is reported through `onProblem` and also
  /// yields null -- the agent trades, it just does not remember.
  static open(opts: {
    dir: string | undefined;
    capBytes?: number;
    onProblem: (reason: string) => void;
  }): AgentStateStore | null {
    if (!opts.dir) return null;
    try {
      mkdirSync(opts.dir, { recursive: true });
      // An epoch killed between the write and the rename leaves the sibling behind. Nothing ever
      // reads it, but it counts against the cap, and one per killed epoch is a directory that fills
      // itself over a competition.
      const stale = join(opts.dir, `${VERSIONS_FILE}.tmp`);
      if (existsSync(stale)) unlinkSync(stale);
    } catch (error) {
      opts.onProblem(
        `state dir ${opts.dir} is not usable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    return new AgentStateStore(
      opts.dir,
      opts.capBytes ?? DEFAULT_STATE_CAP_BYTES,
      opts.onProblem,
    );
  }

  get enabled(): boolean {
    return this.disabled === null;
  }

  load(): StateLoad {
    const path = join(this.dir, VERSIONS_FILE);
    if (!existsSync(path)) return { ok: "absent" };
    try {
      const state = parseState(readFileSync(path, "utf8"));
      if (!state) return { ok: false, reason: `${VERSIONS_FILE} is not a state file this runtime wrote` };
      return { ok: true, state };
    } catch (error) {
      return {
        ok: false,
        reason: `${VERSIONS_FILE} unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /// Replace the persisted state. Atomic: written to a sibling and renamed, because the epoch can
  /// be killed between any two blocks and a truncated file would be loaded as a strategy.
  save(state: PersistedState): void {
    if (this.disabled !== null) return;
    const body = `${JSON.stringify(
      {
        ...state,
        epochs: state.epochs.slice(-MAX_EPOCHS_KEPT),
        ...(state.memory ? { memory: clampMemory(state.memory) } : {}),
      },
      null,
      2,
    )}\n`;
    const path = join(this.dir, VERSIONS_FILE);
    // Measured against the cap *including* what this write would replace, so rewriting the same
    // file forever cannot trip a cap it never actually exceeds.
    const existing = existsSync(path) ? statSync(path).size : 0;
    const projected = dirBytes(this.dir) - existing + Buffer.byteLength(body);
    if (projected > this.capBytes) {
      this.stop(
        `state dir would exceed its ${this.capBytes} byte cap (${projected}); persistence off for the rest of this epoch`,
      );
      return;
    }
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, path);
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // best effort; a stray tmp file is not worth failing the trade loop over
      }
      this.stop(
        `could not persist ${VERSIONS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /// Stop persisting, once, and say why. Never throws: a full disk is a degraded epoch, not a dead
  /// agent, and an agent that stops trading because it could not write a file has lost the epoch
  /// for a reason that has nothing to do with trading.
  private stop(reason: string): void {
    if (this.disabled !== null) return;
    this.disabled = reason;
    this.onProblem(reason);
  }
}
