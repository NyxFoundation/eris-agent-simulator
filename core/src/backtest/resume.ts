// Resuming a scenario matrix across invocations (rules §4.7.1).
//
// The live week is k epochs, and nothing says they run in one process: an anvil dies, a machine is
// rebooted, the operator runs the mornings and the evenings separately. Each `npm run backtest --
// --scenarios` used to open a fresh `runs/matrix-<timestamp>/`, so the standings of one competition
// were spread over as many directories as there were invocations, and no single standings.json
// ranked the whole week. `--resume <matrix-dir>` continues the stored matrix instead: the scenarios
// already complete are kept and skipped, the missing and failed ones are run, and flush() keeps
// writing into the same directory.
//
// Pure apart from the one file read, so the merge can be tested without anvil. What is refused is
// anything that would make the stored and the new epochs a different competition: another scenario
// set, another k (the weights of §4.4.1 are a function of it), another reset unit, another repeat,
// another field (issue #102, #91 F9: `--resume` with a different roster used to exit 0 and rewrite
// the artifact -- two fields across the epochs of one matrix average two competitions, which is the
// thing the guard's own message describes).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./shared.js";
import type { ScenarioResult } from "./standings.js";

/** matrix.json as the CLI writes it (schema 2), read back defensively. */
export type StoredMatrix = {
  schema?: unknown;
  createdAt?: string;
  resumedAt?: string;
  sourceCommit?: string;
  scenarioSet?: string;
  resetUnit?: string;
  k?: number;
  repeat?: number;
  // sha256 of the field the matrix was run with (rosterFingerprint). Absent on a matrix written
  // before it was recorded; such a matrix resumes with a warning rather than a refusal.
  rosterFingerprint?: string;
  scenariosPlanned?: number;
  scenarios?: ScenarioResult[];
  /** The --agent-state-root the matrix was run with, if any (issue #77). */
  agentStateRoot?: string;
};

/**
 * One value for "the field this matrix ranks": the roster entries in canonical JSON, sorted by id,
 * hashed. A roster names wallets by env-variable name or `AUTO` and never holds a key, so the whole
 * entry goes in -- an agent's `dir`, `env` and `baseline` are part of what was placed. When the
 * matrix ran on the regimes' own rosters (no --agents), the input is the map of regime -> roster.
 */
export function rosterFingerprint(roster: unknown): string {
  const normalized = Array.isArray(roster)
    ? [...roster].sort((a, b) => {
        const ia = String((a as { id?: unknown })?.id ?? "");
        const ib = String((b as { id?: unknown })?.id ?? "");
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      })
    : roster;
  return `sha256:${createHash("sha256").update(canonicalJson(normalized)).digest("hex")}`;
}

export function readStoredMatrix(dir: string): StoredMatrix {
  const path = join(dir, "matrix.json");
  if (!existsSync(path))
    throw new Error(
      `--resume: ${path} not found. Point --resume at a directory a previous ` +
        "`npm run backtest -- --scenarios` wrote (runs/matrix-<timestamp>/)",
    );
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`--resume: ${path} is not a JSON object`);
  const m = parsed as StoredMatrix;
  if (m.schema !== 2)
    throw new Error(
      `--resume: ${path} has schema ${String(m.schema)}; only schema 2 matrices can be resumed`,
    );
  if (m.scenarios !== undefined && !Array.isArray(m.scenarios))
    throw new Error(`--resume: ${path} "scenarios" is not an array`);
  return m;
}

export type ResumeTarget = {
  scenarioSet: string;
  k: number;
  resetUnit: string;
  repeat: number;
  agentStateRoot?: string;
  rosterFingerprint?: string;
};

/**
 * Refuse to append epochs of a different competition to a stored one. Paths are compared resolved,
 * so `./config/x.yaml` and `config/x.yaml` are the same set; a set whose *content* changed under the
 * same path is caught by mergeStoredResults, ordinal by ordinal.
 */
export function assertResumable(
  stored: StoredMatrix,
  current: ResumeTarget,
  resolvePath: (p: string) => string = (p) => p,
): void {
  const problems: string[] = [];
  if (
    stored.scenarioSet === undefined ||
    resolvePath(stored.scenarioSet) !== resolvePath(current.scenarioSet)
  )
    problems.push(
      `scenarioSet: stored ${String(stored.scenarioSet)}, now ${current.scenarioSet}`,
    );
  if (stored.k !== current.k)
    problems.push(`k: stored ${String(stored.k)}, now ${current.k}`);
  if (stored.resetUnit !== current.resetUnit)
    problems.push(
      `resetUnit: stored ${String(stored.resetUnit)}, now ${current.resetUnit}`,
    );
  // Stored before --repeat was recorded reads as 1, which is what every scored matrix ran with.
  if ((stored.repeat ?? 1) !== current.repeat)
    problems.push(
      `repeat: stored ${stored.repeat ?? 1}, now ${current.repeat}`,
    );
  // State carrying is part of what the competition is: an epoch run with a carried strategy and
  // one run from version 0 are different experiments, and a resume that switched the root would
  // continue the epochs on top of some other matrix's state (or none).
  const storedRoot =
    stored.agentStateRoot === undefined ? undefined : resolvePath(stored.agentStateRoot);
  const currentRoot =
    current.agentStateRoot === undefined ? undefined : resolvePath(current.agentStateRoot);
  if (storedRoot !== currentRoot)
    problems.push(
      `agentStateRoot: stored ${storedRoot ?? "(none)"}, now ${currentRoot ?? "(none)"}`,
    );
  if (
    stored.rosterFingerprint !== undefined &&
    current.rosterFingerprint !== undefined &&
    stored.rosterFingerprint !== current.rosterFingerprint
  )
    problems.push(
      `roster: stored ${stored.rosterFingerprint.slice(0, 19)}…, now ` +
        `${current.rosterFingerprint.slice(0, 19)}… (a different field)`,
    );
  if (problems.length > 0)
    throw new Error(
      `--resume: the stored matrix is a different competition (${problems.join("; ")}). ` +
        "A resumed run has to continue the same scenario set with the same k, reset unit, " +
        "repeat, agent state root and roster, or its standings would average two competitions " +
        "(rules §4.4.1 / §4.7.1)",
    );
}

export type ResumePlan = {
  /** Stored results kept as they are: they have agents, so the epoch is complete. */
  preloaded: ScenarioResult[];
  /** Ordinals of those, for the run loop to skip. */
  complete: Set<number>;
  /** Ordinals the loop still has to run: never run, or stored without agents (an error). */
  rerun: number[];
};

/**
 * Merge the stored results into the current plan. A stored ordinal has to be the same (regime, seed)
 * as the plan's; anything else means the set file changed under the same path, and appending to it
 * would rank epochs of two different schedules as one -- so that is refused rather than merged.
 */
export function mergeStoredResults(
  plan: ReadonlyArray<{ s: number; regime: string; seed: number }>,
  stored: ReadonlyArray<ScenarioResult>,
): ResumePlan {
  const byOrdinal = new Map(plan.map((p) => [p.s, p]));
  const preloaded: ScenarioResult[] = [];
  const complete = new Set<number>();
  for (const r of stored) {
    const planned = byOrdinal.get(r.s);
    if (!planned)
      throw new Error(
        `--resume: stored s=${r.s} (${r.regime}#${r.seed}) is not in the current plan; ` +
          "the scenario set changed under the same path",
      );
    if (planned.regime !== r.regime || planned.seed !== r.seed)
      throw new Error(
        `--resume: stored s=${r.s} is ${r.regime}#${r.seed} but the plan says ` +
          `${planned.regime}#${planned.seed}; the scenario set changed under the same path`,
      );
    if (Array.isArray(r.agents) && r.agents.length > 0) {
      if (complete.has(r.s))
        throw new Error(`--resume: stored matrix has s=${r.s} twice`);
      preloaded.push(r);
      complete.add(r.s);
    }
    // Stored with an error and no agents: the epoch never produced a summary. It is re-run rather
    // than kept as an invalid epoch, because §4.4.2's re-execution is the remedy for exactly that.
  }
  const rerun = plan.filter((p) => !complete.has(p.s)).map((p) => p.s);
  return { preloaded, complete, rerun };
}

// ---- agent state across a resumed matrix (issue #77) ----
//
// With --agent-state-root the state travels from one scenario to the next in plan order, which is
// only right while the scenarios run in that order in one invocation. A resume re-runs the missing
// and failed ordinals, and a scenario re-run out of order must start from the state the plan says
// it starts from -- what the epoch before it ended with -- not from whatever the last thing that
// happened to run left behind. So every completed scenario snapshots the root under a label, and
// before running s the root is put back to the label of the latest complete ordinal below s, or to
// the matrix's initial (empty) state when there is none. Labels are never pruned (agentState.ts).
//
// What this does not do: re-run the scenarios *after* a re-run one. If s=3 was voided and 4 and 5
// completed on the state the first attempt of 3 left, they stay as they are; rules §4.4.2 re-runs
// the voided epoch, not the ones that followed it, and whether that is acceptable is the
// organizer's call to make, not the runner's.

/** The label under which the root is snapshotted before any scenario has run. */
export const STATE_LABEL_INITIAL = "initial";

/** The label of the state every agent ended ordinal `s` with. */
export function stateLabelAfter(s: number): string {
  return `end-s${s}`;
}

/**
 * The label ordinal `s` has to start from: the end of the latest complete ordinal below it, or the
 * initial state when nothing below it is complete.
 */
export function stateLabelBefore(
  s: number,
  complete: ReadonlySet<number>,
): string {
  let latest: number | undefined;
  for (const done of complete)
    if (done < s && (latest === undefined || done > latest)) latest = done;
  return latest === undefined ? STATE_LABEL_INITIAL : stateLabelAfter(latest);
}
