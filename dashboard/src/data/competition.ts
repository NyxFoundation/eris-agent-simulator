// The competition: the outer unit everything on the dashboard belongs to.
//
//   competition ⊃ scenario (one run, "regime#seed") ⊃ round (one scoring epoch)
//
// A competition is normally a scenario matrix written by `npm run backtest -- --scenarios ...`
// (runs/<id>/matrix.json), whose scenarios are sibling run dirs. A standalone `sim:realtime` run is
// the same thing with one scenario in it — `competitionFromRun` wraps it into the identical shape,
// so every page downstream of this file processes exactly one kind of object.

export interface ScenarioAgentResult {
  id: string;
  netPnlUsdc: number;
  alphaUsdc: number;
  /** The competition score for this scenario: mean − λ·std of per-round excess log returns. */
  score: number;
  excessLogGrowth: number;
  initialValueUsdc: number;
  finalValueUsdc: number;
}

export interface CompetitionScenario {
  regime: string;
  seed: number;
  agents: ScenarioAgentResult[];
  /** Path to that scenario's run dir, relative to the poc root that produced it. */
  runDir: string;
}

/** Shape of matrix.json, written by core/src/backtest/matrix.ts. Parsed defensively: `schema` is 1
 * today, and older files may lack fields that were added later. */
export interface CompetitionFile {
  schema?: number;
  createdAt?: string;
  sourceCommit?: string;
  scenarioSet?: string;
  resetUnit?: string;
  metric?: string;
  repeat?: number;
  scenariosPlanned?: number;
  scenarios: CompetitionScenario[];
}

export interface Competition {
  id: string;
  file: CompetitionFile;
  /** Built from one run rather than read from a matrix.json — see competitionFromRun. */
  fromSingleRun?: boolean;
}

/**
 * A scenario's `runDir` is relative to the root of whatever machine produced it ("runs/<id>"), so it
 * cannot be used as an id here: a competition collected from a remote box lives at
 * runs/<collection>/runs/matrix-<x>/ with its scenarios beside it. The run is always a sibling of
 * the competition dir, so resolving through the competition's own prefix works for both layouts.
 */
export function scenarioRunId(competitionId: string, runDir: string): string {
  const name = runDir.split("/").filter(Boolean).pop() ?? runDir;
  const cut = competitionId.lastIndexOf("/");
  return cut === -1 ? name : `${competitionId.slice(0, cut + 1)}${name}`;
}

/**
 * A single run, as a competition of one scenario.
 *
 * Everything is read from the run's own summary.json, so this asserts nothing the run did not
 * record. A run still in progress has no summary.json and therefore no scenario — its results do
 * not exist yet, which is a fact about the run rather than a gap in this function.
 */
export function competitionFromRun(
  runId: string,
  summary: {
    resetUnit?: string;
    agents?: {
      id: string;
      initialValueUsdc: number;
      finalValueUsdc: number;
      netPnlUsdc: number;
      alphaUsdc?: number;
    }[];
    epochScores?: Record<string, { score: number; logReturns: number[] }>;
  },
  seed: number,
): Competition {
  const scores = summary.epochScores ?? {};
  const agents: ScenarioAgentResult[] = (summary.agents ?? []).map((a) => {
    const epoch = scores[a.id];
    return {
      id: a.id,
      netPnlUsdc: a.netPnlUsdc,
      alphaUsdc: a.alphaUsdc ?? 0,
      score: epoch?.score ?? 0,
      // The excess returns telescope, so their sum is the run's excess log growth exactly.
      excessLogGrowth: (epoch?.logReturns ?? []).reduce((x, y) => x + y, 0),
      initialValueUsdc: a.initialValueUsdc,
      finalValueUsdc: a.finalValueUsdc,
    };
  });
  return {
    id: runId,
    fromSingleRun: true,
    file: {
      schema: 1,
      scenarioSet: runId,
      resetUnit: summary.resetUnit ?? "continuous",
      scenariosPlanned: 1,
      // The run carries no regime name — a regime is a config the backtest runner names, and a
      // standalone run was not launched through it. The seed is what the run does record.
      scenarios: [{ regime: "run", seed, agents, runDir: runId }],
    },
  };
}

const cache = new Map<string, Promise<Competition>>();

export function loadCompetition(id: string): Promise<Competition> {
  const cached = cache.get(id);
  if (cached) return cached;

  const loading = (async (): Promise<Competition> => {
    const res = await fetch(`/runs/${encodeURIComponent(id)}/matrix.json`);
    if (!res.ok) throw new Error(`matrix.json ${res.status} for ${id}`);
    const file = (await res.json()) as CompetitionFile;
    if (!Array.isArray(file.scenarios)) {
      throw new Error(`matrix.json has no scenarios: ${id}`);
    }
    return { id, file };
  })();

  loading.catch(() => cache.delete(id));
  cache.set(id, loading);
  return loading;
}
