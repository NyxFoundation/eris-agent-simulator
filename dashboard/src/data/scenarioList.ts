// The competition's scenarios as a list you can read, rather than as entries in a dropdown.
//
// A scenario is a world: a regime drawn at a seed, run to its end, with a leader and a set of
// things the environment did to it. The picker could only ever say `calm#101`, so choosing which
// world to open meant choosing from names alone — and the interesting question ("which one did the
// crash land in", "where did the leaderboard invert") was invisible until after you had opened it.
//
// Everything here obeys the round cursor for the same reason the standings do: at round k the
// leader is who leads through round k, not who finished first. The exception is the event column,
// which is the plan drawn from the seed before block one — it is what the world *will* do, and
// hiding the later windows would not be showing less of the future, it would be misdescribing the
// scenario.

import type { Competition } from "./competition";
import { scenarioAgents, scenarioLabel, scenarioRunId } from "./competition";
import { scenarioAgentP } from "./scenarioP";
import type { ScenarioSchedule } from "./schedule";
import type { ScenarioRounds } from "./standings";

export interface ScenarioListRow {
  /** Unique per scenario: a matrix may repeat (regime, seed) under --repeat. */
  key: string;
  /** Null for an epoch that failed before it had a run directory (out of S, §4.4.2). */
  runId: string | null;
  regime: string;
  seed: number | null;
  /** Why the epoch has no world to open, when the runner recorded one. */
  error?: string;
  /** `regime#seed`, with the shared `full-` prefix stripped. */
  label: string;
  /** Rounds this scenario has, at the full series length. */
  rounds: number;
  /** Rounds counted so far under the cursor — equal to `rounds` at the end. */
  roundsSoFar: number;
  /** True once the cursor has passed this scenario's last round: its world has ended. */
  ended: boolean;
  /** Who leads it through the cursor's round, and by what P (USDC). Within one scenario the
   * deviation score is monotone in P, so the leader by P is the leader by T. */
  leader: { id: string; pnlUsdc: number } | null;
  /** Distinct environment episode types scheduled in this world, in the order they open. */
  events: string[];
  /** No round series was collected for this scenario. */
  missing: boolean;
}

const shortLabel = (s: string) => s.replace(/^full-/, "");

/**
 * One row per scenario, ordered as the competition file lists them.
 *
 * `throughRound === null` means the finished result. A scenario shorter than the cursor is marked
 * `ended` rather than dropped, matching how the standings treat it: its world finished, so its last
 * value is its result.
 */
export function buildScenarioList(
  competition: Competition,
  rounds: Map<string, ScenarioRounds>,
  schedules: Map<string, ScenarioSchedule>,
  throughRound: number | null,
): ScenarioListRow[] {
  return competition.file.scenarios.map((s, i) => {
    const key = s.runDir ?? `#${s.s ?? i + 1}`;
    const series = rounds.get(key);
    const schedule = schedules.get(key);
    const agents = scenarioAgents(s);

    let total = 0;
    if (series)
      for (const values of Object.values(series.valuesByAgent))
        total = Math.max(total, values.length - 1);

    const roundsSoFar =
      throughRound === null ? total : Math.min(throughRound, total);
    const ended = throughRound !== null && total > 0 && total <= throughRound;

    // The leader by the same quantity the standings standardise inside a scenario: P = V_k − V_0
    // through the rounds counted so far (rules §4.4.1). The benchmark is not a leader (§4.3).
    const benchmarks = new Set(series?.baselineIds ?? []);
    for (const a of agents) if (a.baseline) benchmarks.add(a.id);
    let leader: ScenarioListRow["leader"] = null;
    if (series && roundsSoFar > 0) {
      for (const [id, values] of Object.entries(series.valuesByAgent)) {
        if (benchmarks.has(id)) continue;
        const upTo = Math.min(roundsSoFar, values.length - 1);
        if (upTo <= 0) continue;
        const start = values[0];
        const now = values[upTo];
        if (start === null || now === null) continue;
        const pnlUsdc = now - start;
        if (!leader || pnlUsdc > leader.pnlUsdc) leader = { id, pnlUsdc };
      }
    } else if (throughRound === null) {
      // No series collected, but matrix.json stored each agent's P (or, for an older matrix, the
      // final-marks net PnL, a per-run constant away from it).
      for (const agent of agents) {
        if (benchmarks.has(agent.id)) continue;
        const p = scenarioAgentP(agent, undefined);
        if (p === undefined) continue;
        if (!leader || p > leader.pnlUsdc) leader = { id: agent.id, pnlUsdc: p };
      }
    }

    const events: string[] = [];
    for (const w of schedule?.windows ?? [])
      if (!events.includes(w.type)) events.push(w.type);

    return {
      key,
      runId:
        typeof s.runDir === "string"
          ? scenarioRunId(competition.id, s.runDir)
          : null,
      regime: s.regime,
      seed: s.seed,
      ...(s.error !== undefined ? { error: s.error } : {}),
      label: shortLabel(scenarioLabel(s)),
      rounds: total,
      roundsSoFar,
      ended,
      leader,
      events,
      missing: series === undefined,
    };
  });
}
