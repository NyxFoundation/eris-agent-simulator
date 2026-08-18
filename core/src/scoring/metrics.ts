// Every candidate metric, computed from the same stored epoch series (issue #56).
//
// ADR 0017 §4 and ADR 0019 both promise that the scoring rule can be swapped and the stored runs
// rescored, which is why matrix.json keeps raw scores and summary.json keeps raw boundary values.
// Nothing exercised that promise until the metric choice actually had to be made, so this module is
// the exercise: one input (the epoch series plus which agent is the benchmark), every metric out.
//
// The catalogue's numbering is kept so the results can be read against it. What is NOT here is a
// judgement: M4 and M9 disagree about whether a higher-earning, choppier agent outranks a steadier
// one, and no amount of recomputation settles that -- it is the question the ADR answered by
// choosing a risk-adjusted metric.
import {
  DEFAULT_FLOOR_FRACTION,
  DEFAULT_LAMBDA,
  scoreEpochSeries,
} from "./epochScore.js";

export type AgentMetrics = {
  agentId: string;
  // M1: the endpoint difference, in USDC. Risk-neutral, and the one every other metric is a
  // correction of.
  totalPnlUsdc: number;
  // M4: excess log growth over the benchmark, ln(W_final(a)/W_final(B)) with both floored. This is
  // case A's whole score, and also E times M9's mean term.
  excessLogGrowth: number;
  // M9: mean - lambda*std of the excess epoch returns (ADR 0019's decision).
  score: number;
  meanLogReturn: number;
  stdLogReturn: number;
  // M13: the per-epoch Sharpe of the excess returns, and the same figure over the whole run. Not a
  // candidate for the headline (a ratio is scale-invariant, so "stay small and safe" optimises it),
  // but it is what lambda is a threshold on, so it belongs in the table.
  sharpePerEpoch: number;
  sharpeOverRun: number;
  // M7: MPPM at the given rho, over the excess gross returns. rho = 1 degenerates to the mean log
  // return, i.e. M4/E, which is why the catalogue treats them as one family.
  mppm: number;
  epochs: number;
};

export type MetricOptions = {
  lambda?: number;
  floorFraction?: number;
  // M7's risk aversion. 1 is excluded by the formula's 1/(1-rho); the caller gets the log-return
  // limit instead, which is the correct continuation.
  rho?: number;
  epochs?: number;
};

const mean = (v: readonly number[]) =>
  v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;

// Excess log returns, floors and freezes applied -- the same series M9 scores, so every metric in
// the table is a different reading of one series rather than a different series.
function excessReturns(
  values: ReadonlyArray<number | null>,
  benchmark: ReadonlyArray<number | null> | undefined,
  options: MetricOptions,
): { returns: number[]; initial: number; final: number } | null {
  const scored = scoreEpochSeries({
    values,
    ...(benchmark ? { benchmark } : {}),
    ...(options.lambda !== undefined ? { lambda: options.lambda } : {}),
    ...(options.floorFraction !== undefined
      ? { floorFraction: options.floorFraction }
      : {}),
    ...(options.epochs !== undefined ? { epochs: options.epochs } : {}),
  });
  if (!scored) return null;
  const initial = values[0];
  if (typeof initial !== "number") return null;
  // The last boundary that reported, so a trailing gap does not read as a collapse.
  let final = initial;
  for (const v of values) if (typeof v === "number") final = v;
  return { returns: scored.logReturns, initial, final };
}

export function metricsForAgent(
  agentId: string,
  values: ReadonlyArray<number | null>,
  benchmark: ReadonlyArray<number | null> | undefined,
  options: MetricOptions = {},
): AgentMetrics | null {
  const lambda = options.lambda ?? DEFAULT_LAMBDA;
  const floorFraction = options.floorFraction ?? DEFAULT_FLOOR_FRACTION;
  const rho = options.rho ?? 2;
  const scored = scoreEpochSeries({
    values,
    ...(benchmark ? { benchmark } : {}),
    lambda,
    floorFraction,
    ...(options.epochs !== undefined ? { epochs: options.epochs } : {}),
  });
  const series = excessReturns(values, benchmark, options);
  if (!scored || !series) return null;

  const floorOf = (s: ReadonlyArray<number | null>): number => {
    const first = s[0];
    return typeof first === "number" ? first * floorFraction : 0;
  };
  const lastOf = (s: ReadonlyArray<number | null>): number => {
    let out = 0;
    for (const v of s) if (typeof v === "number") out = v;
    return out;
  };
  const agentFinal = Math.max(lastOf(values), floorOf(values));
  const benchFinal = benchmark
    ? Math.max(lastOf(benchmark), floorOf(benchmark))
    : 0;
  const benchInitial =
    benchmark && typeof benchmark[0] === "number" ? benchmark[0] : 0;
  // Both legs are normalised by their own starting value, so a benchmark funded differently from
  // the agent does not shift the comparison.
  const excessLogGrowth =
    benchmark && benchInitial > 0 && benchFinal > 0
      ? Math.log(agentFinal / series.initial) -
        Math.log(benchFinal / benchInitial)
      : Math.log(agentFinal / series.initial);

  // MPPM (Goetzmann-Ingersoll-Spiegel-Welch 2007) over the excess gross returns.
  const mppm =
    Math.abs(rho - 1) < 1e-9
      ? mean(series.returns)
      : (1 / (1 - rho)) *
        Math.log(mean(series.returns.map((x) => Math.exp(x) ** (1 - rho))));

  const epochs = scored.logReturns.length;
  const sharpePerEpoch =
    scored.stdLogReturn > 0 ? scored.meanLogReturn / scored.stdLogReturn : 0;
  return {
    agentId,
    totalPnlUsdc: series.final - series.initial,
    excessLogGrowth,
    score: scored.score,
    meanLogReturn: scored.meanLogReturn,
    stdLogReturn: scored.stdLogReturn,
    sharpePerEpoch,
    // A per-epoch ratio times sqrt(E): what lambda = 0.25 means over a whole week (~1.6).
    sharpeOverRun: sharpePerEpoch * Math.sqrt(epochs),
    mppm,
    epochs,
  };
}

export type RunMetrics = {
  label: string;
  benchmarkId?: string;
  agents: AgentMetrics[];
};

export function metricsForRun(
  label: string,
  valuesByAgent: Record<string, ReadonlyArray<number | null>>,
  benchmarkId: string | undefined,
  options: MetricOptions = {},
): RunMetrics {
  const benchmark =
    benchmarkId !== undefined ? valuesByAgent[benchmarkId] : undefined;
  const agents: AgentMetrics[] = [];
  for (const [agentId, values] of Object.entries(valuesByAgent)) {
    const m = metricsForAgent(agentId, values, benchmark, options);
    if (m) agents.push(m);
  }
  return {
    label,
    ...(benchmarkId !== undefined ? { benchmarkId } : {}),
    agents,
  };
}

export type MetricKey = keyof Pick<
  AgentMetrics,
  "totalPnlUsdc" | "excessLogGrowth" | "score" | "sharpePerEpoch" | "mppm"
>;

// Ranking under one metric, best first. Ties keep their input order, which for a stored run is the
// roster order -- deterministic, and never a hidden tiebreak.
export function rankBy(run: RunMetrics, metric: MetricKey): string[] {
  return [...run.agents]
    .sort((a, b) => b[metric] - a[metric])
    .map((a) => a.agentId);
}

// M27: Borda over a set of runs. Ordinal by construction, so a regime whose spread is ten times
// another's cannot dominate -- the property the catalogue picked it for. Lower total = better.
export function bordaTotals(
  runs: RunMetrics[],
  metric: MetricKey,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const run of runs) {
    rankBy(run, metric).forEach((agentId, i) => {
      totals[agentId] = (totals[agentId] ?? 0) + i + 1;
    });
  }
  return totals;
}
