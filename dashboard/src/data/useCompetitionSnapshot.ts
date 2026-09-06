// Loads the competition in view and the round series behind every one of its scenarios.
//
// There is one selection model, not two: the outer unit is always a competition, and a standalone
// `sim:realtime` run is a competition of one scenario (see competitionFromRun). That is what lets
// the dashboard have one home and one round cursor rather than a competition mode and a single-run
// mode that have to be kept in step with each other.

import { useMemo } from "react";
import {
  competitionFromRun,
  loadCompetition,
  type Competition,
} from "./competition";
import {
  resolveCompetitionId,
  useSelectedCompetitionId,
} from "./competitionSelection";
import { loadSchedules, type ScenarioSchedule } from "./schedule";
import { loadCompetitionRounds, type ScenarioRounds } from "./standings";
import { isSeedProvider } from "./provider";
import { listRuns, loadRun, runEntries } from "./runArtifacts";
import { getSelectedRunId, useSelectedRunId } from "./runSelection";
import { eventOfType } from "./artifactHelpers";
import { useSnapshot } from "./useSnapshot";

export interface CompetitionSnapshot {
  competition: Competition;
  rounds: Map<string, ScenarioRounds>;
  /** What the environment was scheduled to do, per scenario, placed on the round axis. */
  schedules: Map<string, ScenarioSchedule>;
  /** Scenarios whose run dir was not collected, so they have no round detail. */
  missingRounds: number;
  /**
   * Runs in progress right now (rules §4.7.1: the live week is k epochs run one after another, and
   * the standings update as each one completes). A live run that is one of this competition's
   * scenarios is a day of a practice period still being written; one that is not is the next
   * epoch of a matrix, whose result is not in matrix.json yet.
   */
  liveRunIds: string[];
  /** Epochs the plan announced, when the competition index says (a partial matrix). */
  scenariosPlanned: number | null;
  /** When the competition's index was last written (matrix.json's mtime), for "updated at". */
  updatedAtMs: number | null;
}

/**
 * null data with no error means there is nothing to show standings for: seed-provider mode, an
 * empty runs/, or a run still in progress. A live run genuinely has no standings — summary.json is
 * written at the end — so that is a fact reported rather than a gap papered over.
 */
export function useCompetitionSnapshot() {
  const selectedCompetition = useSelectedCompetitionId();
  const selectedRun = useSelectedRunId();

  const state = useSnapshot<CompetitionSnapshot | null>(
    `competition:${selectedCompetition ?? "latest"}:${selectedRun ?? ""}`,
    async () => {
      // Seed-provider mode serves fixtures for UI development, but the dev server still has the real
      // runs/ directory beside it. Without this the landing page would read real competitions off
      // disk and show real standings while every other page showed fixtures.
      if (isSeedProvider) return null;

      const index = await listRuns();
      const id = resolveCompetitionId(index);

      let competition: Competition;
      if (id) {
        competition = await loadCompetition(id);
      } else {
        // No competition chosen: the outer unit is the selected run on its own.
        const runs = runEntries(index);
        const runId =
          getSelectedRunId() && runs.some((r) => r.id === getSelectedRunId())
            ? (getSelectedRunId() as string)
            : (runs[0]?.id ?? null);
        if (!runId) return null;
        const entry = runs.find((r) => r.id === runId);
        // A run in progress has no summary.json, so there is nothing to score it on yet.
        if (entry?.live) return null;
        const run = await loadRun(runId);
        const started = eventOfType(run.events, "run_started_realtime");
        const seed =
          typeof started?.seed === "number" ? (started.seed as number) : 0;
        competition = competitionFromRun(runId, run.summary, seed);
      }

      const [rounds, schedules] = await Promise.all([
        loadCompetitionRounds(competition),
        loadSchedules(competition),
      ]);
      return {
        competition,
        rounds,
        schedules,
        missingRounds: competition.file.scenarios.length - rounds.size,
        liveRunIds: index.filter((r) => r.live).map((r) => r.id),
        updatedAtMs:
          index.find((r) => r.id === competition.id)?.mtimeMs ?? null,
        scenariosPlanned:
          typeof competition.file.scenariosPlanned === "number"
            ? competition.file.scenariosPlanned
            : typeof competition.file.k === "number"
              ? competition.file.k
              : null,
      };
    },
    // Something is still running: today's rounds keep arriving, or the next epoch's result will.
    // Refreshing in place is what makes the standings a live leaderboard rather than a page to
    // reload (rules §4.4.3: "各エポックの損益と偏差値は、当該エポックの終了後にリーダーボードで公開").
    (data) => (data?.liveRunIds.length ?? 0) > 0,
  );

  return useMemo(() => state, [state]);
}
