// Re-scoring a stored matrix: metric x aggregator, plus the round-level decomposition that explains
// the resulting order (ADR 0020 §5, issue #56).
//
// Two choices produce a standing in `scenario` mode, and they are independent:
//
//   metric      what one scenario is worth to one agent    (M1 / alpha / M4 / M9)
//   aggregator  how 35 of those become one number          (zscore / borda / mean)
//
// Neither is settled. ADR 0019 retired the field-relative z-score without naming a successor, and
// #56 is still open on the metric. So this deliberately does not present one table as the answer:
// it presents the chosen combination next to how far the others disagree with it.
//
// The aggregation itself is imported from core rather than reimplemented -- see the vite alias note.

import {
  AGGREGATORS,
  aggregateScenarios,
  orderOf,
  sdInflationFromExtreme,
  type AggregateRow,
  type Aggregator,
  type ScenarioRow,
} from "@core/scoring/aggregate";
import type { LoadedMatrix, MatrixScenario } from "./matrixArtifacts";
import { scenarioRunId } from "./matrixArtifacts";
import type { EpochScore, RunSummary } from "./runArtifacts";

export { AGGREGATORS };
export type { AggregateRow, Aggregator };

/**
 * The metrics a stored matrix can be re-ranked by without re-running anything.
 *
 * The first four are in matrix.json. The last two are not, but they are functions of the same stored
 * epoch series M9 is scored from — core/src/scoring/metrics.ts computes every one of them from
 * `scored.logReturns` — so they cost one extra read of each scenario's summary.json and nothing
 * else. That is what makes this the same table `npm run metrics -- --matrix` prints.
 */
export type MetricKey =
  | "score"
  | "netPnlUsdc"
  | "alphaUsdc"
  | "excessLogGrowth"
  | "epochPnlUsdc"
  | "sharpePerEpoch"
  | "mppm";

/**
 * Metrics computed from the epoch series rather than read off matrix.json.
 *
 * Two consequences: a matrix whose scenario runs were not collected cannot show them at all, and —
 * because the series can be truncated — they are the ones the round cursor can scope. M4 is in here
 * even though matrix.json stores it: the excess log returns telescope, so the sum of the stored
 * series is bit-identical to the stored total (checked over all 735 agent-scenarios of the full-8h
 * matrix), which buys a round-scopeable M4 at no cost in fidelity.
 */
export const SERIES_METRICS: MetricKey[] = [
  "score",
  "epochPnlUsdc",
  "excessLogGrowth",
  "sharpePerEpoch",
  "mppm",
];

/**
 * The two that are defined only at a run's end. Both ends are priced at the final marks, so there
 * is no "value at round k" to take — asking for one would mean inventing a mark the run never had.
 */
export const ENDPOINT_ONLY_METRICS: MetricKey[] = ["netPnlUsdc", "alphaUsdc"];

export const METRICS: {
  key: MetricKey;
  label: string;
  hint: string;
  unit: "usdc" | "log" | "ratio";
}[] = [
  {
    key: "score",
    label: "M9  mean − λ·std",
    hint: "the ADR 0019 competition metric: per-epoch excess log return, penalised for its own spread",
    unit: "log",
  },
  {
    key: "epochPnlUsdc",
    label: "M1  PnL (epoch series)",
    hint: "last epoch boundary minus the first, prices moving. This is the M1 `npm run metrics` prints, and it carries beta — the do-nothing baseline is not zero under it",
    unit: "usdc",
  },
  {
    key: "netPnlUsdc",
    label: "net PnL (final marks)",
    hint: "what backtest --metric netPnlUsdc ranks by. Both ends are priced at the run's LAST prices, so beta cancels by construction and noop is exactly 0 — a different quantity from M1, not a rounding of it",
    unit: "usdc",
  },
  {
    key: "alphaUsdc",
    label: "α  alpha (final marks)",
    hint: "PnL with the beta of free inventory removed — held venue positions are still marked live",
    unit: "usdc",
  },
  {
    key: "excessLogGrowth",
    label: "M4  excess log growth",
    hint: "the same epoch series M9 scores, summed instead of penalised. Differs from M9 by exactly λ·std",
    unit: "log",
  },
  {
    key: "sharpePerEpoch",
    label: "M13  Sharpe / round",
    hint: "mean ÷ std of the same series. A ratio, so it rewards steadiness at any size — an agent risking nothing can top it",
    unit: "ratio",
  },
  {
    key: "mppm",
    label: "M7  MPPM",
    hint: "manipulation-proof performance measure at the given ρ: a risk-aversion-weighted certainty equivalent of the excess returns",
    unit: "log",
  },
];

export const DEFAULT_METRIC: MetricKey = "score";
export const DEFAULT_AGGREGATOR: Aggregator = "zscore";

/** ADR 0019's value, and what every stored run was scored with. */
export const DEFAULT_LAMBDA = 0.25;

// ---------------------------------------------------------------------------
// per-scenario round series

/** One scenario's per-epoch excess log returns, by agent. Absent when its summary could not load. */
export interface ScenarioRounds {
  regime: string;
  seed: number;
  runId: string;
  byAgent: Record<string, number[]>;
  /** 1-based epoch at which each agent hit the bankruptcy floor (ADR 0019 G1/G2). */
  bankruptAtEpoch: Record<string, number | null>;
  /**
   * The raw value at each epoch boundary, before the excess/floor construction. Beta is still in
   * it, which is exactly what makes it a different quantity from the excess series above — and it
   * is the one `npm run metrics` reports M1 from. A boundary the scorer could not read is null.
   */
  valuesByAgent: Record<string, Array<number | null>>;
  /** The lambda the run itself was scored with, for the "as recorded" reference point. */
  lambda: number | null;
}

function scenarioKey(s: { regime: string; seed: number }): string {
  return `${s.regime}#${s.seed}`;
}

export function keyOfScenario(s: MatrixScenario): string {
  return scenarioKey(s);
}

/**
 * Load the epoch series behind every scenario of a matrix.
 *
 * summary.json stores `logReturns` already floored, already in excess of the baseline and already
 * frozen at bankruptcy — every part of the ADR 0019 construction except lambda. So re-scoring at a
 * different lambda is exactly mean − λ·std over the stored series, not an approximation of it. That
 * is what makes the lambda control honest rather than decorative.
 */
export async function loadMatrixRounds(
  matrix: LoadedMatrix,
): Promise<Map<string, ScenarioRounds>> {
  const entries = await Promise.all(
    matrix.file.scenarios.map(async (s) => {
      const runId = scenarioRunId(matrix.id, s.runDir);
      try {
        const res = await fetch(
          `/runs/${encodeURIComponent(runId)}/summary.json`,
        );
        if (!res.ok) return null;
        const summary = (await res.json()) as RunSummary;
        const scores = summary.epochScores ?? {};
        const byAgent: Record<string, number[]> = {};
        const bankruptAtEpoch: Record<string, number | null> = {};
        let lambda: number | null = null;
        for (const [id, entry] of Object.entries(scores)) {
          const e = entry as EpochScore;
          if (!Array.isArray(e.logReturns)) continue;
          byAgent[id] = e.logReturns;
          bankruptAtEpoch[id] = e.bankruptAtEpoch ?? null;
          if (lambda === null && typeof e.lambda === "number")
            lambda = e.lambda;
        }
        if (Object.keys(byAgent).length === 0) return null;
        const valuesByAgent =
          summary.valueSeries?.epochSeries?.valuesByAgent ?? {};
        return [
          scenarioKey(s),
          {
            regime: s.regime,
            seed: s.seed,
            runId,
            byAgent,
            bankruptAtEpoch,
            valuesByAgent,
            lambda,
          },
        ] as const;
      } catch {
        // A scenario whose run dir was not collected simply has no round detail. The matrix's own
        // numbers still rank it — dropping the scenario instead would silently change the standings.
        return null;
      }
    }),
  );
  return new Map(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}

// ---------------------------------------------------------------------------
// metric values

function populationStd(values: number[], mu: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export interface RoundStats {
  mean: number;
  std: number;
  /** mean − λ·std at the requested lambda. */
  score: number;
  epochs: number;
  bankruptAtEpoch: number | null;
}

export function statsOf(
  logReturns: number[],
  lambda: number,
  bankruptAtEpoch: number | null = null,
): RoundStats {
  const epochs = logReturns.length;
  const mean = epochs > 0 ? logReturns.reduce((a, b) => a + b, 0) / epochs : 0;
  const std = populationStd(logReturns, mean);
  return { mean, std, score: mean - lambda * std, epochs, bankruptAtEpoch };
}

/** ADR 0020 §5's default risk aversion, and what `npm run metrics` uses unless told otherwise. */
export const DEFAULT_RHO = 2;

/**
 * The two metrics that read the series differently from M9. Both mirror core/src/scoring/metrics.ts
 * exactly, over the identical input: `logReturns` as stored.
 */
function seriesMetric(
  logReturns: number[],
  metric: "sharpePerEpoch" | "mppm",
  rho: number,
): number {
  if (logReturns.length === 0) return 0;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  if (metric === "sharpePerEpoch") {
    const std = populationStd(logReturns, mean);
    return std > 0 ? mean / std : 0;
  }
  // rho = 1 degenerates to the mean log return, where the closed form divides by zero.
  if (Math.abs(rho - 1) < 1e-9) return mean;
  const powered = logReturns.map((x) => Math.exp(x) ** (1 - rho));
  const avg = powered.reduce((a, b) => a + b, 0) / powered.length;
  return (1 / (1 - rho)) * Math.log(avg);
}

/**
 * One scenario's metric value per agent.
 *
 * M9 comes from the round series whenever it is available, so the lambda control moves the standings
 * rather than only the decomposition. Without the series it falls back to the value the CLI stored,
 * which was computed at DEFAULT_LAMBDA — `lambdaApplies` reports which of the two happened so the UI
 * never shows a lambda that did not actually reach the numbers.
 */
export interface ScoringParams {
  lambda: number;
  rho: number;
}

/**
 * One scenario's metric value per agent, optionally as of a round rather than at the end.
 *
 * `throughRound` truncates the stored series, which is what makes the standings scrubbable: at
 * round k the series is the first k entries and every metric is recomputed over exactly those. A
 * scenario shorter than k is *not* dropped — its world ended, so its final value is its result and
 * removing it would move the standings for a reason that is not a result. `endedScenarios` counts
 * them so the UI can say which.
 */
export function scenarioValues(
  scenario: MatrixScenario,
  metric: MetricKey,
  params: ScoringParams,
  rounds: Map<string, ScenarioRounds>,
  throughRound: number | null = null,
): { byAgent: Record<string, number>; fromSeries: boolean; ended: boolean } {
  const byAgent: Record<string, number> = {};
  const series = rounds.get(scenarioKey(scenario));
  let ended = false;

  if (series && SERIES_METRICS.includes(metric)) {
    for (const agent of scenario.agents) {
      const full = series.byAgent[agent.id];
      if (!full) continue;
      if (throughRound !== null && full.length <= throughRound) ended = true;
      const upTo =
        throughRound === null
          ? full.length
          : Math.min(throughRound, full.length);
      if (upTo <= 0) continue;

      if (metric === "epochPnlUsdc") {
        // First boundary to the last one that reported inside the window, so a gap reads as a gap
        // rather than as a collapse to zero. Same rule as core/src/scoring/metrics.ts. There is one
        // more boundary than there are rounds, so round k ends at index k.
        const values = series.valuesByAgent[agent.id];
        if (!values) continue;
        const first = values[0];
        if (typeof first !== "number") continue;
        let last = first;
        for (const v of values.slice(0, upTo + 1))
          if (typeof v === "number") last = v;
        byAgent[agent.id] = last - first;
        continue;
      }

      const returns = upTo === full.length ? full : full.slice(0, upTo);
      byAgent[agent.id] =
        metric === "score"
          ? statsOf(returns, params.lambda).score
          : metric === "excessLogGrowth"
            ? returns.reduce((a, b) => a + b, 0)
            : seriesMetric(
                returns,
                metric as "sharpePerEpoch" | "mppm",
                params.rho,
              );
    }
    if (Object.keys(byAgent).length > 0)
      return { byAgent, fromSeries: true, ended };
  }

  // No series: a series metric genuinely does not exist for this scenario, and inventing a fallback
  // would be inventing a result. The endpoint metrics still read straight off matrix.json.
  if (SERIES_METRICS.includes(metric))
    return { byAgent, fromSeries: false, ended };

  for (const agent of scenario.agents) {
    const value = agent[metric as keyof typeof agent];
    if (typeof value === "number" && Number.isFinite(value))
      byAgent[agent.id] = value;
  }
  return { byAgent, fromSeries: false, ended: false };
}

// ---------------------------------------------------------------------------
// standings

export interface ScenarioCell {
  regime: string;
  seed: number;
  runId: string;
  byAgent: Record<string, number>;
  /** issue #55: how much of this scenario's spread is one agent's doing, and whose. */
  sdInflation: { ratio: number; agentId?: string };
  /** True when the cursor is past this scenario's last round: its world has finished. */
  ended: boolean;
}

export interface MatrixStandings {
  metric: MetricKey;
  aggregator: Aggregator;
  params: ScoringParams;
  /**
   * True when the numbers came from the stored epoch series, so the lambda/rho controls actually
   * reached them. False means the values are matrix.json's own, scored at the defaults.
   */
  fromSeries: boolean;
  rows: AggregateRow[];
  regimes: string[];
  cells: ScenarioCell[];
  agentIds: string[];
  /** The round these standings are as of, or null for the finished result. */
  throughRound: number | null;
  /** Scenarios whose world had already ended at that round — counted, never silently dropped. */
  endedScenarios: number;
}

export function buildStandings(
  matrix: LoadedMatrix,
  rounds: Map<string, ScenarioRounds>,
  metric: MetricKey,
  aggregator: Aggregator,
  params: ScoringParams,
  throughRound: number | null = null,
): MatrixStandings {
  let fromSeries = false;
  let endedScenarios = 0;
  const cells: ScenarioCell[] = matrix.file.scenarios.map((s) => {
    const scenario = scenarioValues(s, metric, params, rounds, throughRound);
    const byAgent = scenario.byAgent;
    if (scenario.fromSeries) fromSeries = true;
    if (scenario.ended) endedScenarios += 1;
    return {
      regime: s.regime,
      seed: s.seed,
      runId: scenarioRunId(matrix.id, s.runDir),
      byAgent,
      sdInflation: sdInflationFromExtreme(byAgent),
      ended: scenario.ended,
    };
  });

  const rows: ScenarioRow[] = cells.map((c) => ({
    regime: c.regime,
    seed: c.seed,
    byAgent: c.byAgent,
  }));

  const regimes: string[] = [];
  for (const c of cells)
    if (!regimes.includes(c.regime)) regimes.push(c.regime);
  const agentIds: string[] = [];
  for (const c of cells)
    for (const id of Object.keys(c.byAgent))
      if (!agentIds.includes(id)) agentIds.push(id);

  return {
    metric,
    aggregator,
    params,
    fromSeries,
    rows: aggregateScenarios(rows, aggregator),
    regimes,
    cells,
    agentIds,
    throughRound,
    endedScenarios,
  };
}

/**
 * Where each agent stood one round earlier, so the standings can show the move.
 *
 * Rank movement is the thing a round-by-round view is for: a total that ticks up says nothing on
 * its own, and "▲3 this round" is the sentence a viewer is actually reading for. At round 1 there
 * is no previous round and every move is undefined rather than zero — zero would claim the field
 * started in the order it happens to be in.
 */
export function rankMoves(
  matrix: LoadedMatrix,
  rounds: Map<string, ScenarioRounds>,
  standings: MatrixStandings,
): Map<string, number | null> {
  const at = standings.throughRound;
  const out = new Map<string, number | null>();
  if (at === null || at <= 1) {
    for (const row of standings.rows) out.set(row.id, null);
    return out;
  }
  const before = buildStandings(
    matrix,
    rounds,
    standings.metric,
    standings.aggregator,
    standings.params,
    at - 1,
  );
  const wasAt = new Map(before.rows.map((r, i) => [r.id, i]));
  standings.rows.forEach((row, i) => {
    const was = wasAt.get(row.id);
    // Positive = moved up the table (a smaller index).
    out.set(row.id, was === undefined ? null : was - i);
  });
  return out;
}

// ---------------------------------------------------------------------------
// disagreement between combinations

export interface Disagreement {
  metric: MetricKey;
  aggregator: Aggregator;
  /** Fraction of agents placed identically to the reference combination. */
  sameRank: number;
  /** The largest number of places any single agent moves. */
  maxShift: number;
  /** Whose place moves the most, and by how much (signed: positive = better under this rule). */
  mover?: { id: string; shift: number };
}

/**
 * Every combination's order compared against the one on screen.
 *
 * This is the point of the page rather than an appendix to it. Presenting a single table would say
 * the ranking rule is decided; it is not, and the honest summary of a matrix is how much of the
 * order survives changing the rule.
 */
export function compareCombinations(
  matrix: LoadedMatrix,
  rounds: Map<string, ScenarioRounds>,
  reference: MatrixStandings,
): Disagreement[] {
  const refOrder = orderOf(reference.rows);
  const refPlace = new Map(refOrder.map((id, i) => [id, i]));

  const out: Disagreement[] = [];
  for (const { key: metric } of METRICS) {
    for (const aggregator of AGGREGATORS) {
      if (metric === reference.metric && aggregator === reference.aggregator)
        continue;
      const standings = buildStandings(
        matrix,
        rounds,
        metric,
        aggregator,
        reference.params,
      );
      // A round-only metric with no series produces no order at all; reporting it as "0% agreement"
      // would read as a disagreement rather than as an absence.
      if (standings.rows.length === 0) continue;
      const order = orderOf(standings.rows);
      let same = 0;
      let maxShift = 0;
      let mover: { id: string; shift: number } | undefined;
      order.forEach((id, i) => {
        const was = refPlace.get(id);
        if (was === undefined) return;
        if (was === i) same++;
        // positive = this rule places the agent higher (a smaller index) than the reference
        const shift = was - i;
        if (Math.abs(shift) > maxShift) {
          maxShift = Math.abs(shift);
          mover = { id, shift };
        }
      });
      out.push({
        metric,
        aggregator,
        sameRank: order.length > 0 ? same / order.length : 0,
        maxShift,
        mover,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// round decomposition — why an agent sits where it does

export interface AgentRoundDecomposition {
  id: string;
  /** Every epoch return the agent produced, across every scenario in the matrix. */
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
 * This is NOT how the standings are computed — M9 is per scenario, then aggregated per regime — and
 * it is not offered as an alternative ranking. It answers the one question the standings cannot:
 * *why* an agent sits where it does. An agent can earn far more per round than the winner and still
 * place last, and the difference is entirely in the spread that lambda charges for.
 */
export function decomposeAgent(
  agentId: string,
  matrix: LoadedMatrix,
  rounds: Map<string, ScenarioRounds>,
  lambda: number,
): AgentRoundDecomposition | null {
  const pooled: number[] = [];
  const perRegime = new Map<string, { returns: number[]; scenarios: number }>();
  const bankruptIn: { regime: string; seed: number; epoch: number }[] = [];

  for (const s of matrix.file.scenarios) {
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
    stats: statsOf(pooled, lambda),
    byRegime: [...perRegime.entries()].map(([regime, b]) => ({
      regime,
      stats: statsOf(b.returns, lambda),
      scenarios: b.scenarios,
    })),
    bankruptIn,
  };
}
