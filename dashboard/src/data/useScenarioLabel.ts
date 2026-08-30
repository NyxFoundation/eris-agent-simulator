// What the selected run is, said as what it is a draw of.
//
// "full-crash#303" names a regime and a seed; a timestamp names neither. The scenario page is
// titled by this, so a screenshot of it says which distribution it came from rather than when the
// file was written.
//
// Deliberately light: it reads matrix.json (cached) and nothing else. The scenario page has no use
// for the round series or the schedules, and loading them for a title would refetch 35 summaries.

import { useEffect, useState } from "react";
import { competitionName, loadCompetition, scenarioLabel, scenarioRunId } from "./competition";
import {
  resolveCompetitionId,
  useSelectedCompetitionId,
} from "./competitionSelection";
import { listRuns } from "./runArtifacts";
import { useSelectedRunId } from "./runSelection";

export interface ScenarioLabel {
  /** "full-crash#303", or null when the run belongs to no competition. */
  name: string | null;
  /** The competition it came from, for the subtitle. */
  competition: string | null;
  seed: number | null;
}

const EMPTY: ScenarioLabel = { name: null, competition: null, seed: null };

export function useScenarioLabel(): ScenarioLabel {
  const runId = useSelectedRunId();
  const competitionId = useSelectedCompetitionId();
  const [label, setLabel] = useState<ScenarioLabel>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    if (!runId) {
      setLabel(EMPTY);
      return;
    }
    listRuns()
      .then((index) => {
        const id = resolveCompetitionId(index);
        if (!id) throw new Error("no competition");
        return loadCompetition(id);
      })
      .then((m) => {
        if (cancelled) return;
        const scenario = m.file.scenarios.find(
          (s) => scenarioRunId(m.id, s.runDir) === runId,
        );
        setLabel(
          scenario
            ? {
                name: scenarioLabel(scenario),
                competition: competitionName(m),
                seed: scenario.seed,
              }
            : EMPTY,
        );
      })
      .catch(() => {
        // No competition to name it by; the page falls back to the run's own id.
        if (!cancelled) setLabel(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, competitionId]);

  return label;
}
