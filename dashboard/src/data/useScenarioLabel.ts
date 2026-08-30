// What the selected run is, said as what it is a draw of.
//
// "full-crash#303" names a regime and a seed; a timestamp names neither. The scenario page is
// titled by this, so a screenshot of it says which distribution it came from rather than when the
// file was written.
//
// Deliberately light: it reads matrix.json (cached) and nothing else. The scenario page has no use
// for the round series or the schedules, and loading them for a title would refetch 35 summaries.

import { useEffect, useState } from "react";
import { loadMatrix, scenarioRunId } from "./matrixArtifacts";
import { resolveMatrixId, useSelectedMatrixId } from "./matrixSelection";
import { listRuns } from "./runArtifacts";
import { useSelectedRunId } from "./runSelection";

export interface ScenarioLabel {
  /** "full-crash#303", or null when the run belongs to no matrix. */
  name: string | null;
  /** The matrix it came from, for the subtitle. */
  matrixSet: string | null;
  seed: number | null;
}

export function useScenarioLabel(): ScenarioLabel {
  const runId = useSelectedRunId();
  const matrixId = useSelectedMatrixId();
  const [label, setLabel] = useState<ScenarioLabel>({
    name: null,
    matrixSet: null,
    seed: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!runId) {
      setLabel({ name: null, matrixSet: null, seed: null });
      return;
    }
    listRuns()
      .then((index) => {
        const id = resolveMatrixId(index);
        if (!id) throw new Error("no matrix");
        return loadMatrix(id);
      })
      .then((m) => {
        if (cancelled) return;
        const scenario = m.file.scenarios.find(
          (s) => scenarioRunId(m.id, s.runDir) === runId,
        );
        setLabel(
          scenario
            ? {
                name: `${scenario.regime}#${scenario.seed}`,
                matrixSet: m.file.scenarioSet ?? m.id,
                seed: scenario.seed,
              }
            : { name: null, matrixSet: null, seed: null },
        );
      })
      .catch(() => {
        // No matrix to name it by; the page falls back to the run's own id.
        if (!cancelled) setLabel({ name: null, matrixSet: null, seed: null });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, matrixId]);

  return label;
}
