// Loads the competition in view and the round series behind every one of its scenarios.
//
// There is one selection model, not two: the outer unit is always a competition, and a standalone
// `sim:realtime` run is a competition of one scenario (see competitionFromRun). That is what lets
// the dashboard have one home and one round cursor rather than a competition mode and a single-run
// mode that have to be kept in step with each other.
//
// A competition in progress is a fact this snapshot states, not one the page infers: which run on
// the server is *this* competition's live one (a period's current segment, a matrix's running
// epoch), how far into its rounds it is, and when the round closes. The landing used to read the
// end of the round cursor as the finished result and call a running period "Final" (issue #84 C),
// and stopped refreshing between a matrix's epochs because no run was live (issue #84 Q).

import { useMemo } from "react";
import {
  competitionFromRun,
  loadCompetition,
  scenarioLabel,
  scenarioRunId,
  type Competition,
} from "./competition";
import {
  resolveCompetitionId,
  useSelectedCompetitionId,
} from "./competitionSelection";
import { loadLiveRun } from "./liveRun";
import { loadMode } from "./mode";
import { loadSchedules, type ScenarioSchedule } from "./schedule";
import { loadCompetitionRounds, type ScenarioRounds } from "./standings";
import { isSeedProvider } from "./provider";
import { liveProgress } from "./runsProvider";
import {
  listRuns,
  loadRun,
  loadRunHeader,
  runEntries,
  type RunIndexEntry,
} from "./runArtifacts";
import { getSelectedRunId, useSelectedRunId } from "./runSelection";
import { eventOfType } from "./artifactHelpers";
import { useSnapshot } from "./useSnapshot";

/** The run of this competition that is being written right now, and where it is. */
export interface LiveScenario {
  runId: string;
  /** What to call it: a period's day, or "epoch s" for a matrix's running epoch. */
  label: string;
  /** 1-based position among the competition's scenarios (a period's day number). */
  ordinal: number;
  /** The round in progress, and how many the run has. Null until the run's header has been read. */
  round: number | null;
  rounds: number | null;
  /** When the current round closes, estimated from the chain's cadence. */
  roundEndsAtMs: number | null;
  blockNumber: number | null;
}

export interface CompetitionSnapshot {
  competition: Competition;
  rounds: Map<string, ScenarioRounds>;
  /** What the environment was scheduled to do, per scenario, placed on the round axis. */
  schedules: Map<string, ScenarioSchedule>;
  /** Scenarios whose run dir was not collected, so they have no round detail. */
  missingRounds: number;
  /** Every run in progress on this server, whichever competition it belongs to. */
  liveRunIds: string[];
  /** This competition's own run in progress, or null when none is. */
  live: LiveScenario | null;
  /**
   * Whether more results are coming: a run of this competition is live, or the plan has epochs
   * still to run (rules §4.7.1: the live week is k epochs run one after another, and between two
   * of them nothing is live yet the standings are not final).
   */
  inProgress: boolean;
  /** Epochs the plan announced, when the competition index says (a partial matrix). */
  scenariosPlanned: number | null;
  /** When the competition's index was last written (matrix.json's mtime), for "updated at". */
  updatedAtMs: number | null;
}

/**
 * A run in progress, as a competition of one scenario with no result yet. Its header says what
 * kind of world it is and what seed it was drawn from (absent in the public view); its series
 * comes from the live boundaries the same way a period's current segment does.
 */
async function competitionFromLiveRun(runId: string): Promise<Competition> {
  const head = await loadRunHeader(runId);
  const started = eventOfType(head, "run_started_realtime");
  const seed =
    typeof started?.seed === "number" ? (started.seed as number) : null;
  return competitionFromRun(
    runId,
    {
      ...(typeof started?.resetUnit === "string"
        ? { resetUnit: started.resetUnit as string }
        : {}),
      agents: [],
    },
    seed,
  );
}

/**
 * Which live run is this competition's — by name, never by inference.
 *
 * A practice period's current segment is in its own index already (the index is rewritten at every
 * roll), so it is one of the scenarios and this finds it. A scenario matrix's running epoch is not
 * in matrix.json until it completes, and nothing on disk connects that sibling directory to the
 * matrix, so it is not attributed at all: guessing "the newest live run" would put another
 * competition's epoch, or the operator's smoke run, in this competition's header. The standings
 * still say the competition is in progress — that comes from the plan's epoch count, not from
 * finding a live directory.
 */
async function attributeLive(
  competition: Competition,
  index: RunIndexEntry[],
): Promise<LiveScenario | null> {
  const live = index.filter((r) => r.live);
  if (live.length === 0) return null;
  const scenarios = competition.file.scenarios;
  const byRunId = new Map(
    scenarios.flatMap((s, i) =>
      typeof s.runDir === "string"
        ? [[scenarioRunId(competition.id, s.runDir), { s, i }] as const]
        : [],
    ),
  );
  const own = live.find((r) => byRunId.has(r.id));
  if (!own) return null;
  const { s, i } = byRunId.get(own.id)!;
  const picked = {
    runId: own.id,
    label: scenarioLabel(s),
    ordinal: s.s ?? i + 1,
  };
  try {
    const run = await loadLiveRun(picked.runId);
    const progress = liveProgress(run);
    return {
      ...picked,
      round: progress?.round ?? null,
      rounds: progress?.rounds ?? null,
      roundEndsAtMs: progress?.roundEndsAtMs ?? null,
      blockNumber: progress?.blockNumber ?? run.live?.chainHeight ?? null,
    };
  } catch {
    return {
      ...picked,
      round: null,
      rounds: null,
      roundEndsAtMs: null,
      blockNumber: null,
    };
  }
}

/**
 * null data with no error means there is nothing to show standings for: seed-provider mode, or an
 * empty runs/. A run still in progress is a competition whose result is not in yet -- a fact the
 * landing states, rather than a gap it falls through.
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
      await loadMode();

      const index = await listRuns();
      const id = resolveCompetitionId(index);

      let competition: Competition;
      if (id) {
        competition = await loadCompetition(id, {
          mtimeMs: index.find((r) => r.id === id)?.mtimeMs ?? null,
        });
      } else {
        // No competition chosen: the outer unit is the selected run on its own.
        const runs = runEntries(index);
        const runId =
          getSelectedRunId() && runs.some((r) => r.id === getSelectedRunId())
            ? (getSelectedRunId() as string)
            : (runs[0]?.id ?? null);
        if (!runId) return null;
        const entry = runs.find((r) => r.id === runId);
        if (entry?.live) {
          competition = await competitionFromLiveRun(runId);
        } else {
          const run = await loadRun(runId);
          const started = eventOfType(run.events, "run_started_realtime");
          const seed =
            typeof started?.seed === "number" ? (started.seed as number) : null;
          competition = competitionFromRun(runId, run.summary, seed);
        }
      }

      const scenariosPlanned =
        typeof competition.file.scenariosPlanned === "number"
          ? competition.file.scenariosPlanned
          : typeof competition.file.k === "number"
            ? competition.file.k
            : null;
      const [rounds, schedules, live] = await Promise.all([
        loadCompetitionRounds(competition),
        loadSchedules(competition),
        attributeLive(competition, index),
      ]);
      const inProgress =
        live !== null ||
        (competition.file.resetUnit !== "continuous" &&
          scenariosPlanned !== null &&
          competition.file.scenarios.length < scenariosPlanned);
      return {
        competition,
        rounds,
        schedules,
        missingRounds:
          competition.file.scenarios.filter((s) => typeof s.runDir === "string")
            .length - rounds.size,
        liveRunIds: index.filter((r) => r.live).map((r) => r.id),
        live,
        inProgress,
        updatedAtMs:
          index.find((r) => r.id === competition.id)?.mtimeMs ?? null,
        scenariosPlanned,
      };
    },
    // More is coming: today's rounds keep arriving, or the next epoch's result will. Refreshing in
    // place is what makes the standings a live leaderboard rather than a page to reload (rules
    // §4.4.3: "各エポックの損益と偏差値は、当該エポックの終了後にリーダーボードで公開") -- and it has to
    // go on between two epochs of a matrix, when nothing is live and the next result is minutes away.
    (data) => data?.inProgress ?? false,
  );

  return useMemo(() => state, [state]);
}
