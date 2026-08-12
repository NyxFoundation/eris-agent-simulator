// Scenario-matrix aggregation (ADR 0017 §4).
//
// Turns a scenario x agent score matrix into standings in three layers:
//   1. scenario score  -- the raw metric from that scenario's single run
//   2. scenario z      -- normalized across agents *within the scenario*
//   3. total           -- mean over scenarios inside a regime, then mean over regimes (equal weight)
//
// Why normalize per scenario rather than per regime: every agent in a scenario ran in the same world
// (ADR 0017 §1 co-location), so comparing them to each other is the one comparison the design
// actually guarantees is fair. Doing it per scenario also flattens the seed-to-seed scale spread
// inside a regime, not just the regime-to-regime spread, which is a strict improvement over
// normalizing the regime as one pool.
//
// Pure. No filesystem, no chain. The CLI collects summaries and hands them here, so the aggregation
// rule can be re-run over a stored matrix.json when the scoring method changes (it is expected to --
// ADR 0017 leaves the metric and the formula open).

// How far below the worst finisher a disqualified agent lands, in z units (standard deviations).
// Being disqualified has to be worse than finishing last, or crashing becomes a strategy; and it has
// to be a bounded penalty rather than -Infinity, or one bad scenario decides the whole competition.
export const DISQUALIFIED_Z_PENALTY = 1;

export type ScoringMetric = "netPnlUsdc" | "alphaUsdc";

export type AgentScore = {
  id: string;
  netPnlUsdc?: number;
  alphaUsdc?: number;
  // The two cross-sections the metrics above are differences of. Carried into matrix.json because
  // the run directories do not survive: of the 30 runs in the 2026-08-09 sweep, 5 had already lost
  // theirs, and with only the differences stored there was no way to recompute a score under a
  // changed rule -- which is the whole premise of standings.json being a derivative (ADR 0017 §4).
  initialValueUsdc?: number;
  finalValueUsdc?: number;
  // Set when the agent must not be credited with a score for this scenario: it broke a rule, its
  // process died, or it never reported. The reason is carried through to the report.
  disqualified?: string;
};

export type ScenarioResult = {
  regime: string;
  seed: number;
  // Absent when the run produced no summary at all. Such scenarios are excluded from the
  // aggregation and reported separately -- a failure of the environment must not be charged to the
  // participants, and a row of zeros would silently dilute everyone's average.
  agents?: AgentScore[];
  runDir?: string;
  error?: string;
};

export type ScenarioStanding = {
  regime: string;
  seed: number;
  scores: Record<string, number>;
  z: Record<string, number>;
  disqualified: Record<string, string>;
};

export type Standings = {
  metric: ScoringMetric;
  agents: Array<{
    id: string;
    total: number;
    byRegime: Record<string, number>;
    scenariosScored: number;
    disqualifications: number;
  }>;
  regimes: string[];
  scenarios: ScenarioStanding[];
  excludedScenarios: Array<{ regime: string; seed: number; error?: string }>;
};

export function scenarioId(regime: string, seed: number): string {
  return `${regime}#${seed}`;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Population standard deviation: the agents in a scenario are the whole set being compared, not a
// sample drawn from a larger one.
function stdev(values: number[], mu: number): number {
  return Math.sqrt(mean(values.map((v) => (v - mu) ** 2)));
}

function metricOf(
  agent: AgentScore,
  metric: ScoringMetric,
): number | undefined {
  const raw = agent[metric];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

// z-scores for one scenario. Agents that finished are normalized against each other; agents that did
// not are placed below all of them.
export function scenarioZScores(
  agents: AgentScore[],
  metric: ScoringMetric,
): {
  z: Record<string, number>;
  scores: Record<string, number>;
  disqualified: Record<string, string>;
} {
  const scores: Record<string, number> = {};
  const disqualified: Record<string, string> = {};
  const finishers: string[] = [];

  for (const agent of agents) {
    const value = metricOf(agent, metric);
    if (agent.disqualified !== undefined) {
      disqualified[agent.id] = agent.disqualified;
      // Keep the raw number when there is one: the report should still show what the agent was
      // holding when it was disqualified, even though the number does not earn it any z.
      if (value !== undefined) scores[agent.id] = value;
      continue;
    }
    if (value === undefined) {
      // A finisher with no readable metric is a reporting failure, not a zero. Treat it the same as
      // any other agent we cannot score rather than crediting it with an average result.
      disqualified[agent.id] = `no ${metric} in summary`;
      continue;
    }
    scores[agent.id] = value;
    finishers.push(agent.id);
  }

  const z: Record<string, number> = {};
  const values = finishers.map((id) => scores[id]);
  if (finishers.length > 0) {
    const mu = mean(values);
    const sd = stdev(values, mu);
    // sd === 0 means every finisher tied. No one out-traded anyone, so no one gains ground.
    for (const id of finishers) z[id] = sd > 0 ? (scores[id] - mu) / sd : 0;
  }
  const worst =
    finishers.length > 0 ? Math.min(...finishers.map((id) => z[id])) : 0;
  for (const id of Object.keys(disqualified))
    z[id] = finishers.length > 0 ? worst - DISQUALIFIED_Z_PENALTY : 0;

  return { z, scores, disqualified };
}

export function computeStandings(
  results: ScenarioResult[],
  metric: ScoringMetric,
): Standings {
  const scored: ScenarioStanding[] = [];
  const excluded: Standings["excludedScenarios"] = [];

  for (const result of results) {
    if (!result.agents || result.agents.length === 0) {
      excluded.push({
        regime: result.regime,
        seed: result.seed,
        error: result.error ?? "no summary.json",
      });
      continue;
    }
    const { z, scores, disqualified } = scenarioZScores(result.agents, metric);
    scored.push({
      regime: result.regime,
      seed: result.seed,
      scores,
      z,
      disqualified,
    });
  }

  // Regime order follows first appearance so the report reads in the order the matrix was run.
  const regimes: string[] = [];
  for (const s of scored)
    if (!regimes.includes(s.regime)) regimes.push(s.regime);

  const agentIds: string[] = [];
  for (const s of scored)
    for (const id of Object.keys(s.z))
      if (!agentIds.includes(id)) agentIds.push(id);

  const agents = agentIds.map((id) => {
    const byRegime: Record<string, number> = {};
    let scenariosScored = 0;
    let disqualifications = 0;
    for (const regime of regimes) {
      const inRegime = scored.filter((s) => s.regime === regime && id in s.z);
      if (inRegime.length === 0) continue;
      byRegime[regime] = mean(inRegime.map((s) => s.z[id]));
      scenariosScored += inRegime.length;
      disqualifications += inRegime.filter((s) => id in s.disqualified).length;
    }
    const present = regimes.filter((r) => r in byRegime);
    return {
      id,
      // Equal weight per regime, so a regime with more seeds does not carry more of the total.
      total: present.length > 0 ? mean(present.map((r) => byRegime[r])) : 0,
      byRegime,
      scenariosScored,
      disqualifications,
    };
  });

  agents.sort((a, b) => b.total - a.total);
  return {
    metric,
    agents,
    regimes,
    scenarios: scored,
    excludedScenarios: excluded,
  };
}
