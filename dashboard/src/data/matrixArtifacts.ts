// Loader for runs/<id>/matrix.json — the output of `npm run backtest -- --scenarios ...`.
//
// A matrix is the unit the competition is actually scored over (ADR 0020): the standings come from
// 35 scenarios, and any one of them is a single draw from the regime's distribution rather than a
// result. config/scenarios/public.yaml says so outright — "the published seeds are five draws from
// it, not the target". A viewer that can only open one scenario at a time invites exactly the
// reading that sentence warns against, which is why the matrix is a first-class object here.
//
// Shape written by core/src/backtest/matrix.ts. Parsed defensively: `schema` is 1 today, and older
// files may lack fields that were added later.

export interface MatrixAgentRow {
  id: string;
  netPnlUsdc: number;
  alphaUsdc: number;
  /** M9, the ADR 0019 competition metric: mean - lambda*std of per-epoch excess log returns. */
  score: number;
  /** M4: the same epoch series summed, so score and this differ by exactly lambda*std. */
  excessLogGrowth: number;
  initialValueUsdc: number;
  finalValueUsdc: number;
}

export interface MatrixScenario {
  regime: string;
  seed: number;
  agents: MatrixAgentRow[];
  /** Path to that scenario's run dir, relative to the poc root that produced it. */
  runDir: string;
}

export interface MatrixFile {
  schema?: number;
  createdAt?: string;
  sourceCommit?: string;
  scenarioSet?: string;
  resetUnit?: string;
  /** The metric the CLI ranked by when it wrote the file. The dashboard re-picks it. */
  metric?: string;
  repeat?: number;
  scenariosPlanned?: number;
  scenarios: MatrixScenario[];
}

export interface LoadedMatrix {
  id: string;
  file: MatrixFile;
  /** Built from one run rather than read from a matrix.json — see synthesizeMatrix. */
  synthetic?: boolean;
}

/**
 * A scenario's `runDir` is relative to the root of whatever machine produced it ("runs/<id>"), so it
 * cannot be used as an id here: a matrix collected from a remote box lives at
 * runs/<collection>/runs/matrix-<x>/ with its scenarios beside it. The run is always a sibling of
 * the matrix dir, so resolving through the matrix's own prefix works for both layouts.
 */
export function scenarioRunId(matrixId: string, runDir: string): string {
  const name = runDir.split("/").filter(Boolean).pop() ?? runDir;
  const cut = matrixId.lastIndexOf("/");
  return cut === -1 ? name : `${matrixId.slice(0, cut + 1)}${name}`;
}

/**
 * A single run, as a matrix of one scenario.
 *
 * There is no second model for "a run that is not part of a competition": a `sim:realtime` run is a
 * competition with one scenario in it, and saying so keeps one selection model, one home and one set
 * of controls instead of two parallel worlds that have to be kept in step. The aggregation over one
 * scenario is degenerate but not meaningless — z-score is the field's spread within that scenario,
 * borda is its ranking, mean is the raw metric.
 *
 * Everything is read from the run's own summary.json, so this asserts nothing the run did not record.
 * A run still in progress has no summary.json and therefore no scenario — its results do not exist
 * yet, which is a fact about the run rather than a gap in this function.
 */
export function synthesizeMatrix(
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
): LoadedMatrix {
  const scores = summary.epochScores ?? {};
  const agents: MatrixAgentRow[] = (summary.agents ?? []).map((a) => {
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
    synthetic: true,
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

const cache = new Map<string, Promise<LoadedMatrix>>();

export function loadMatrix(matrixId: string): Promise<LoadedMatrix> {
  const cached = cache.get(matrixId);
  if (cached) return cached;

  const loading = (async (): Promise<LoadedMatrix> => {
    const res = await fetch(
      `/runs/${encodeURIComponent(matrixId)}/matrix.json`,
    );
    if (!res.ok) throw new Error(`matrix.json ${res.status} for ${matrixId}`);
    const file = (await res.json()) as MatrixFile;
    if (!Array.isArray(file.scenarios)) {
      throw new Error(`matrix.json has no scenarios: ${matrixId}`);
    }
    return { id: matrixId, file };
  })();

  loading.catch(() => cache.delete(matrixId));
  cache.set(matrixId, loading);
  return loading;
}
