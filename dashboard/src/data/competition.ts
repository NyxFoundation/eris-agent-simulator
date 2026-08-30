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
  /**
   * What to call this instead of "regime#seed". A scenario matrix has no use for it — "crash#303"
   * already names a distribution and a draw. A practice period's segments do: they are cuts of one
   * continuous world (ADR 0021 §6), and "segment#3" names nothing a participant cares about, where
   * "2026-09-02" does.
   */
  label?: string;
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

// ---------------------------------------------------------------------------
// display names
//
// A competition's heading is a name, not a storage detail: the scenario set it ran ("full-8h"),
// never the yaml path that configured it or the timestamped directory it landed in. The raw id
// stays available as a tooltip for anyone who needs to find the files.

/** "config/scenarios/full-8h.yaml" -> "full-8h"; already-clean names pass through. */
function nameFromScenarioSet(set: string): string {
  const base = set.split("/").filter(Boolean).pop() ?? set;
  return base.replace(/\.ya?ml$/i, "");
}

/** "2026-08-29T16-03-52-390Z" (a run dir basename) -> "2026-08-29 16:03"; else the basename. */
export function runDisplayName(runId: string): string {
  const base = runId.split("/").filter(Boolean).pop() ?? runId;
  const m = base.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : base;
}

/**
 * What a scenario is called: its own label when it has one, otherwise the regime and seed it was
 * drawn from. One function, so every place that names a scenario names it the same way.
 */
export function scenarioLabel(s: {
  regime: string;
  seed: number;
  label?: string;
}): string {
  return s.label ?? `${s.regime}#${s.seed}`;
}

/** The competition's human name. A single-run competition is named by its run's timestamp. */
export function competitionName(c: Competition): string {
  if (!c.fromSingleRun && c.file.scenarioSet)
    return nameFromScenarioSet(c.file.scenarioSet);
  if (c.fromSingleRun) return runDisplayName(c.id);
  return c.id.split("/").filter(Boolean).pop() ?? c.id;
}

/** "full-8h · 8/29" — the picker label; the date separates re-runs of the same set. */
export function competitionLabel(c: Competition, locale: string): string {
  const name = competitionName(c);
  if (!c.file.createdAt) return name;
  const date = new Date(c.file.createdAt);
  if (Number.isNaN(date.getTime())) return name;
  return `${name} · ${date.toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", { month: "numeric", day: "numeric" })}`;
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
