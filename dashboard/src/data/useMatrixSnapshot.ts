// Loads the selected matrix and the round series behind every one of its scenarios.
//
// Both are fetched together: the round series is what lets lambda move the standings rather than
// only the explanation, and it is small (35 summary.json files, ~1.7 MB for the full set) because
// only the epoch scores are read out of each.

import { useMemo } from "react";
import { loadMatrix, type LoadedMatrix } from "./matrixArtifacts";
import {
  getSelectedMatrixId,
  NO_MATRIX,
  useSelectedMatrixId,
} from "./matrixSelection";
import { loadMatrixSchedules, type ScenarioSchedule } from "./matrixSchedule";
import { loadMatrixRounds, type ScenarioRounds } from "./matrixScoring";
import { isSeedProvider } from "./provider";
import { listRuns, matrixEntries } from "./runArtifacts";
import { useSnapshot } from "./useSnapshot";

export interface MatrixSnapshot {
  matrix: LoadedMatrix;
  rounds: Map<string, ScenarioRounds>;
  /** What the environment was scheduled to do, per scenario, placed on the round axis. */
  schedules: Map<string, ScenarioSchedule>;
  /** Scenarios whose run dir was not collected, so they have no round detail. */
  missingRounds: number;
}

/** null data with no error means "there are no matrices under runs/" — a valid state, not a failure. */
export function useMatrixSnapshot() {
  const selected = useSelectedMatrixId();

  const state = useSnapshot<MatrixSnapshot | null>(
    `matrix:${selected ?? "latest"}`,
    async () => {
      // The seed provider serves fixtures for UI development, but the dev server still has the real
      // runs/ directory beside it — so without this the landing page would show real standings while
      // every other page showed fixtures. In seed mode there is no matrix and "/" is the run view,
      // exactly as it was before the matrix level existed.
      if (isSeedProvider) return null;
      let id = getSelectedMatrixId();
      if (id === NO_MATRIX) return null;
      if (!id) {
        const matrices = matrixEntries(await listRuns());
        // The index is newest-first, so this is the most recent competition on disk.
        id = matrices[0]?.id ?? null;
      }
      if (!id) return null;
      const matrix = await loadMatrix(id);
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
