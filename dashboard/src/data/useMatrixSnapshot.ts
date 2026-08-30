// Loads the matrix in view and the round series behind every one of its scenarios.
//
// There is one selection model, not two: the outer unit is always a matrix, and a standalone
// `sim:realtime` run is a matrix of one scenario (see synthesizeMatrix). That is what lets the
// dashboard have one home, one set of controls and one round cursor rather than a competition mode
// and a single-run mode that have to be kept in step with each other.
//
// The round series is fetched alongside, because it is what lets lambda move the standings rather
// than only the explanation, and it is small — only each run's epoch scores are read out.

import { useMemo } from "react";
import {
  loadMatrix,
  synthesizeMatrix,
  type LoadedMatrix,
} from "./matrixArtifacts";
import {
  getSelectedMatrixId,
  NO_MATRIX,
  useSelectedMatrixId,
} from "./matrixSelection";
import { loadMatrixSchedules, type ScenarioSchedule } from "./matrixSchedule";
import { loadMatrixRounds, type ScenarioRounds } from "./matrixScoring";
import { isSeedProvider } from "./provider";
import { listRuns, loadRun, matrixEntries, runEntries } from "./runArtifacts";
import { getSelectedRunId, useSelectedRunId } from "./runSelection";
import { eventOfType } from "./artifactHelpers";
import { useSnapshot } from "./useSnapshot";

export interface MatrixSnapshot {
  matrix: LoadedMatrix;
  rounds: Map<string, ScenarioRounds>;
  /** What the environment was scheduled to do, per scenario, placed on the round axis. */
  schedules: Map<string, ScenarioSchedule>;
  /** Scenarios whose run dir was not collected, so they have no round detail. */
  missingRounds: number;
}

/**
 * null data with no error means there is nothing to show standings for: seed-provider mode, an
 * empty runs/, or a run still in progress. A live run genuinely has no standings — summary.json is
 * written at the end — so that is a fact reported rather than a gap papered over.
 */
export function useMatrixSnapshot() {
  const selectedMatrix = useSelectedMatrixId();
  const selectedRun = useSelectedRunId();

  const state = useSnapshot<MatrixSnapshot | null>(
    `matrix:${selectedMatrix ?? "latest"}:${selectedRun ?? ""}`,
    async () => {
      // Seed-provider mode serves fixtures for UI development, but the dev server still has the real
      // runs/ directory beside it. Without this the landing page would read real matrices off disk
      // and show real standings while every other page showed fixtures.
      if (isSeedProvider) return null;

      const index = await listRuns();
      let id = getSelectedMatrixId();
      if (!id) {
        // The index is newest-first, so this is the most recent competition on disk.
        id = matrixEntries(index)[0]?.id ?? null;
      }

      let matrix: LoadedMatrix;
      if (id && id !== NO_MATRIX) {
        matrix = await loadMatrix(id);
      } else {
        // No matrix chosen: the outer unit is the selected run on its own.
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
        matrix = synthesizeMatrix(runId, run.summary, seed);
      }

      const [rounds, schedules] = await Promise.all([
        loadMatrixRounds(matrix),
        loadMatrixSchedules(matrix),
      ]);
      return {
        matrix,
        rounds,
        schedules,
        missingRounds: matrix.file.scenarios.length - rounds.size,
      };
    },
    () => false,
  );

  return useMemo(() => state, [state]);
}
