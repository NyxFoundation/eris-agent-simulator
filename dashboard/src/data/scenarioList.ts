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
import { scenarioLabel, scenarioRunId } from "./competition";
import type { ScenarioSchedule } from "./schedule";
import { statsOf, type ScenarioRounds } from "./standings";

export interface ScenarioListRow {
  /** Unique per scenario: a matrix may repeat (regime, seed) under --repeat. */
  key: string;
  runId: string;
  regime: string;
  seed: number;
  /** `regime#seed`, with the shared `full-` prefix stripped. */
  label: string;
  /** Rounds this scenario has, at the full series length. */
  rounds: number;
  /** Rounds counted so far under the cursor — equal to `rounds` at the end. */
  roundsSoFar: number;
  /** True once the cursor has passed this scenario's last round: its world has ended. */
  ended: boolean;
  /** Who leads it through the cursor's round, and by what score (raw log return per round). */
  leader: { id: string; score: number } | null;
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
  return competition.file.scenarios.map((s) => {
    const key = s.runDir;
    const series = rounds.get(key);
    const schedule = schedules.get(key);

    let total = 0;
    if (series)
      for (const returns of Object.values(series.byAgent))
        total = Math.max(total, returns.length);

    const roundsSoFar =
      throughRound === null ? total : Math.min(throughRound, total);
    const ended = throughRound !== null && total > 0 && total <= throughRound;

    // The leader by the same rule the standings use inside a scenario: mean − λ·std over the rounds
    // counted so far. Not the z-aggregated rank, which only exists across scenarios.
    let leader: ScenarioListRow["leader"] = null;
    if (series && roundsSoFar > 0) {
      for (const [id, full] of Object.entries(series.byAgent)) {
        const upTo = Math.min(roundsSoFar, full.length);
        if (upTo <= 0) continue;
        const { score } = statsOf(
          upTo === full.length ? full : full.slice(0, upTo),
        );
        if (!leader || score > leader.score) leader = { id, score };
      }
    } else if (throughRound === null) {
      // No series collected, but matrix.json stored each agent's final score under the same rule.
      for (const agent of s.agents) {
        if (!Number.isFinite(agent.score)) continue;
        if (!leader || agent.score > leader.score)
          leader = { id: agent.id, score: agent.score };
      }
    }

    const events: string[] = [];
    for (const w of schedule?.windows ?? [])
      if (!events.includes(w.type)) events.push(w.type);

    return {
      key,
      runId: scenarioRunId(competition.id, s.runDir),
      regime: s.regime,
      seed: s.seed,
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
