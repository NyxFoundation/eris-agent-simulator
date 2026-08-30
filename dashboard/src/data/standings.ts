// The competition standings, under the one rule the competition is scored by:
//
//   per scenario   score = mean − λ·std of per-round excess log returns
//   across scenarios   z-score within each scenario's field, averaged with equal weight per regime
//
// The aggregation is imported from core rather than reimplemented — two implementations of one
// ranking is two answers to "who won" with no way to tell which is the real one (see the vite
// alias note). Re-ranking a stored competition under other metrics is a CLI job:
// `npm run metrics -- --matrix <dir>`.

import {
  aggregateScenarios,
  type AggregateRow,
  type ScenarioRow,
} from "@core/scoring/aggregate";
import type { Competition, CompetitionScenario } from "./competition";
import { scenarioRunId } from "./competition";
import type { EpochScore, RunSummary } from "./runArtifacts";

/** The λ every stored run was scored with. */
export const LAMBDA = 0.25;

// ---------------------------------------------------------------------------
// per-scenario round series

/** One scenario's per-epoch excess log returns, by agent. Absent when its summary could not load. */
export interface ScenarioRounds {
  regime: string;
  seed: number;
  runId: string;
  byAgent: Record<string, number[]>;
  /** 1-based epoch at which each agent hit the bankruptcy floor. */
  bankruptAtEpoch: Record<string, number | null>;
}

/**
 * Identity, not display. `runDir` is the one field guaranteed unique across a competition's
 * scenarios — a matrix can repeat (regime, seed) under `--repeat`, and a practice period's segments
 * (ADR 0021 §6) can share a label when several fall in the same hour. Keying on the label collapsed
 * six segments into one and pooled their rounds together.
 */
function scenarioKey(s: { runDir: string }): string {
  return s.runDir;
}

/**
 * Load the epoch series behind every scenario of a competition.
 *
 * summary.json stores `logReturns` already floored, already in excess of the baseline and already
 * frozen at bankruptcy — every part of the scoring construction except λ. So a standing "through
 * round k" is exactly mean − λ·std over the first k entries, not an approximation of it.
 */
export async function loadCompetitionRounds(
  competition: Competition,
): Promise<Map<string, ScenarioRounds>> {
  const entries = await Promise.all(
    competition.file.scenarios.map(async (s) => {
      const runId = scenarioRunId(competition.id, s.runDir);
      try {
        const res = await fetch(
          `/runs/${encodeURIComponent(runId)}/summary.json`,
        );
        if (!res.ok) return null;
        const summary = (await res.json()) as RunSummary;
        const scores = summary.epochScores ?? {};
        const byAgent: Record<string, number[]> = {};
        const bankruptAtEpoch: Record<string, number | null> = {};
        for (const [id, entry] of Object.entries(scores)) {
          const e = entry as EpochScore;
          if (!Array.isArray(e.logReturns)) continue;
          byAgent[id] = e.logReturns;
          bankruptAtEpoch[id] = e.bankruptAtEpoch ?? null;
        }
        // A scenario whose summary is present but holds no scored round yet is a *result pending*,
        // not a missing file. A practice period's current segment is always in that state (ADR 0021
        // §6): its first epoch has not closed. Reported as an empty series rather than as absent, so
        // the page does not tell a viewer their day was "not collected" every day.
        return [
          scenarioKey(s),
          { regime: s.regime, seed: s.seed, runId, byAgent, bankruptAtEpoch },
        ] as const;
      } catch {
        // A scenario whose run dir was not collected genuinely has no round detail. Its stored score
        // still ranks it — dropping the scenario instead would silently change the standings.
        return null;
      }
    }),
  );
  return new Map(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}

// ---------------------------------------------------------------------------
// the score

function populationStd(values: number[], mu: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export interface RoundStats {
  mean: number;
  std: number;
  /** mean − λ·std. */
  score: number;
  epochs: number;
  bankruptAtEpoch: number | null;
}

export function statsOf(
  logReturns: number[],
  bankruptAtEpoch: number | null = null,
): RoundStats {
  const epochs = logReturns.length;
  const mean = epochs > 0 ? logReturns.reduce((a, b) => a + b, 0) / epochs : 0;
  const std = populationStd(logReturns, mean);
  return { mean, std, score: mean - LAMBDA * std, epochs, bankruptAtEpoch };
}

/**
 * One scenario's score per agent, optionally as of a round rather than at the end.
 *
 * `throughRound` truncates the stored series, which is what makes the standings scrubbable: at
 * round k the series is the first k entries and the score is recomputed over exactly those. A
 * scenario shorter than k is *not* dropped — its world ended, so its final value is its result and
 * removing it would move the standings for a reason that is not a result. `endedScenarios` counts
 * them so the bar can say which.
 *
 * A scenario with no collected run falls back to the score matrix.json stored (the same rule, at
 * the same λ) at the end, and contributes nothing mid-scrub — there is no series to truncate, and
 * showing the finished number under a round label would be showing the future.
 */
function scenarioScores(
  scenario: CompetitionScenario,
  rounds: Map<string, ScenarioRounds>,
  throughRound: number | null,
): { byAgent: Record<string, number>; ended: boolean } {
  const byAgent: Record<string, number> = {};
  const series = rounds.get(scenarioKey(scenario));
  let ended = false;

  if (series) {
    for (const agent of scenario.agents) {
      const full = series.byAgent[agent.id];
      if (!full) continue;
      if (throughRound !== null && full.length <= throughRound) ended = true;
      const upTo =
        throughRound === null
          ? full.length
          : Math.min(throughRound, full.length);
      if (upTo <= 0) continue;
      const returns = upTo === full.length ? full : full.slice(0, upTo);
      byAgent[agent.id] = statsOf(returns).score;
    }
    if (Object.keys(byAgent).length > 0) return { byAgent, ended };
  }

  if (throughRound !== null) return { byAgent: {}, ended: false };
  for (const agent of scenario.agents) {
    if (Number.isFinite(agent.score)) byAgent[agent.id] = agent.score;
  }
  return { byAgent, ended: false };
}

// ---------------------------------------------------------------------------
// standings

export interface Standings {
  rows: AggregateRow[];
  regimes: string[];
  agentIds: string[];
  /** The round these standings are as of, or null for the finished result. */
  throughRound: number | null;
  /** Scenarios whose world had already ended at that round — counted, never silently dropped. */
  endedScenarios: number;
  /** Net PnL (final marks) summed across every scenario. Defined only at a run's end — both ends
   * are priced at the final marks, so there is no "value at round k" to take. */
  netPnlByAgent: Record<string, number>;
  /**
   * The score in its own units (raw log return per round; display ×10⁴ as bps): per-scenario
   * scores averaged per regime, then across regimes with equal weight. This is what the standings
   * table shows — the rank itself still comes from `rows` (the official z aggregation), and the
   * two can disagree in order; that difference is the aggregation choice, stated, not hidden.
   */
  scoreByAgent: Record<
    string,
    { overall: number; byRegime: Record<string, number> }
  >;
}

export function buildStandings(
  competition: Competition,
  rounds: Map<string, ScenarioRounds>,
  throughRound: number | null = null,
): Standings {
  let endedScenarios = 0;
  const scenarioRows: ScenarioRow[] = competition.file.scenarios.map((s) => {
    const { byAgent, ended } = scenarioScores(s, rounds, throughRound);
    if (ended) endedScenarios += 1;
    return { regime: s.regime, seed: s.seed, byAgent };
  });

  const regimes: string[] = [];
  const agentIds: string[] = [];
  const netPnlByAgent: Record<string, number> = {};
  for (const s of competition.file.scenarios) {
    if (!regimes.includes(s.regime)) regimes.push(s.regime);
    for (const agent of s.agents) {
      if (!agentIds.includes(agent.id)) agentIds.push(agent.id);
      netPnlByAgent[agent.id] =
        (netPnlByAgent[agent.id] ?? 0) + agent.netPnlUsdc;
    }
  }

  // Regime-equal means of the raw scores, from exactly the rows the ranking aggregates.
  const perRegime = new Map<string, Map<string, number[]>>(); // agent -> regime -> scores
  for (const row of scenarioRows) {
    for (const [id, value] of Object.entries(row.byAgent)) {
      const byRegime = perRegime.get(id) ?? new Map<string, number[]>();
      const list = byRegime.get(row.regime) ?? [];
      list.push(value);
      byRegime.set(row.regime, list);
      perRegime.set(id, byRegime);
    }
  }
  const scoreByAgent: Standings["scoreByAgent"] = {};
  for (const [id, byRegimeLists] of perRegime) {
    const byRegime: Record<string, number> = {};
    for (const [regime, values] of byRegimeLists) {
      byRegime[regime] = values.reduce((a, b) => a + b, 0) / values.length;
    }
    const regimeMeans = Object.values(byRegime);
    scoreByAgent[id] = {
      overall: regimeMeans.reduce((a, b) => a + b, 0) / regimeMeans.length,
      byRegime,
    };
  }

  return {
    rows: aggregateScenarios(scenarioRows, "zscore"),
    regimes,
    agentIds,
    throughRound,
    endedScenarios,
    netPnlByAgent,
    scoreByAgent,
  };
}

/**
 * Where each agent stood one round earlier, so the standings can show the move.
 *
 * At round 1 there is no previous round and every move is undefined rather than zero — zero would
 * claim the field started in the order it happens to be in.
 */
export function rankMoves(
  competition: Competition,
  rounds: Map<string, ScenarioRounds>,
  standings: Standings,
): Map<string, number | null> {
  const at = standings.throughRound;
  const out = new Map<string, number | null>();
  if (at === null || at <= 1) {
    for (const row of standings.rows) out.set(row.id, null);
    return out;
  }
  const before = buildStandings(competition, rounds, at - 1);
  const wasAt = new Map(before.rows.map((r, i) => [r.id, i]));
  standings.rows.forEach((row, i) => {
    const was = wasAt.get(row.id);
    // Positive = moved up the table (a smaller index).
    out.set(row.id, was === undefined ? null : was - i);
  });
  return out;
}

// ---------------------------------------------------------------------------
// round decomposition — why an agent sits where it does

export interface AgentRoundDecomposition {
  id: string;
  /** Every epoch return the agent produced, across every scenario in the competition. */
  pooled: number[];
  stats: RoundStats;
  /** Per-regime stats, so a strategy that only works in one regime is visible as such. */
  byRegime: { regime: string; stats: RoundStats; scenarios: number }[];
  /** Scenarios in which the agent hit the bankruptcy floor. */
  bankruptIn: { regime: string; seed: number; epoch: number }[];
}

/**
 * Pooling every scenario's epochs into one distribution.
 *
 * This is NOT how the standings are computed — the score is per scenario, then averaged per
 * regime — and it is not an alternative ranking. It answers the one question the standings cannot:
 * *why* an agent sits where it does. An agent can earn far more per round than the winner and still
 * place last, and the difference is entirely in the spread that λ charges for.
 */
export function decomposeAgent(
  agentId: string,
  competition: Competition,
  rounds: Map<string, ScenarioRounds>,
): AgentRoundDecomposition | null {
  const pooled: number[] = [];
  const perRegime = new Map<string, { returns: number[]; scenarios: number }>();
  const bankruptIn: { regime: string; seed: number; epoch: number }[] = [];

  for (const s of competition.file.scenarios) {
    const series = rounds.get(scenarioKey(s));
    const returns = series?.byAgent[agentId];
    if (!series || !returns) continue;
    pooled.push(...returns);
    const bucket = perRegime.get(s.regime) ?? { returns: [], scenarios: 0 };
    bucket.returns.push(...returns);
    bucket.scenarios += 1;
    perRegime.set(s.regime, bucket);
    const bankrupt = series.bankruptAtEpoch[agentId];
    if (typeof bankrupt === "number")
      bankruptIn.push({ regime: s.regime, seed: s.seed, epoch: bankrupt });
  }

  if (pooled.length === 0) return null;
  return {
    id: agentId,
    pooled,
    stats: statsOf(pooled),
    byRegime: [...perRegime.entries()].map(([regime, b]) => ({
      regime,
      stats: statsOf(b.returns),
      scenarios: b.scenarios,
    })),
    bankruptIn,
  };
}
