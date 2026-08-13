// The competition score (ADR 0019 §1): risk-adjusted log growth over the epoch value series.
//
//   x_e   = ln( W_e / W_{e-1} ) - ln( B_e / B_{e-1} )   e = 1..E   (excess over the benchmark)
//   W     = max( V, 0.01 * W_init )                     G1, the bankruptcy floor
//   score = mean_e(x_e) - lambda * std_e(x_e)
//
// The benchmark term is what makes §4 true: holding cash has to score exactly 0, mean AND std, or
// lambda is not a hurdle over doing nothing. It is not cosmetic. Scoring raw returns instead was
// measured across five B harness seeds: the noop agent scored -5.07e-5 with a std of 2.22e-4, which
// was 93% of an active agent's total dispersion -- everyone's gas reserve moving with ETH. Every
// agent carries that same reserve, so it cancels epoch by epoch, and subtracting it took peg-arb
// from a Sharpe of 0.111 to 0.241 and noop to exactly zero without touching the funding.
//
// The mean term is unaffected by the choice: it telescopes to (ln W_E - ln W_0 - ln B_E + ln B_0)/E,
// so the benchmark is a constant across agents there. Only the std term changes -- which is the
// whole reason the benchmark had to be cash rather than HODL (§2).
//
// Kept as a pure function over the stored series, separate from the scenario-matrix scorer in
// backtest/standings.ts. lambda and the epoch length are provisional, so a run's numbers have to
// stay recomputable from summary.json alone -- the same discipline that makes standings.json a
// derivative of matrix.json (ADR 0017 §4).

export const DEFAULT_LAMBDA = 0.25;
export const DEFAULT_FLOOR_FRACTION = 0.01;

export type EpochScoreInput = {
  // Value at each epoch boundary, index 0 being the run's start. `null` is a boundary that reported
  // no value (a failed read, a dead process), which is not the same as a value of zero.
  values: ReadonlyArray<number | null>;
  // Denominator E. Fixed for every agent (42 in the live competition) rather than "however many
  // epochs this agent survived": dividing by a shorter series shrinks std and would make failing
  // early pay (ADR 0019 §8). Defaults to the number of returns the series supports.
  epochs?: number;
  lambda?: number;
  floorFraction?: number;
  // The benchmark's value at the same boundaries (the roster's `baseline: true` agent, ADR 0019 §2).
  // Absent = raw returns, which scores the benchmark's own drift as if the agent had chosen it.
  benchmark?: ReadonlyArray<number | null>;
};

export type EpochScore = {
  score: number;
  meanLogReturn: number;
  stdLogReturn: number;
  // The E returns the score was computed from, in order, after flooring/freezing/carrying.
  logReturns: number[];
  // Epoch index (1-based) at which the floor was first touched, or null. From there on the series
  // is frozen at 0 -- G2 is a scoring rule, not a chain rule: the agent's txs are never blocked,
  // because on a live chain a participant reaches the sequencer directly and only a sequencer-level
  // power could stop them (ADR 0019 §5).
  bankruptAtEpoch: number | null;
  // Epoch indices (1-based) whose value was missing and carried forward at a return of 0. Reported
  // rather than folded in silently: a gap is the environment's failure, not the agent's.
  carriedForwardEpochs: number[];
  floorUsdc: number;
  lambda: number;
  // False when no benchmark series was supplied, i.e. the returns are raw. Reported so a score is
  // never read as excess when it is not.
  benchmarkApplied: boolean;
};

// Population standard deviation (denominator E, not E-1). The series is the whole week, not a sample
// drawn from it.
function populationStd(values: readonly number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

export function scoreEpochSeries(input: EpochScoreInput): EpochScore | null {
  const {
    values,
    lambda = DEFAULT_LAMBDA,
    floorFraction = DEFAULT_FLOOR_FRACTION,
  } = input;
  const initial = values[0];
  // Without a starting value there is no growth rate to speak of, and inventing one (par, the first
  // value that did report) would put a number on an agent nobody measured.
  if (initial === null || initial === undefined || !(initial > 0)) return null;

  const epochs = Math.max(0, Math.floor(input.epochs ?? values.length - 1));
  if (epochs === 0) return null;

  const floorUsdc = initial * floorFraction;
  const logReturns: number[] = [];
  const carriedForwardEpochs: number[] = [];
  let bankruptAtEpoch: number | null = null;
  let previous = initial;

  // The benchmark's log return for one epoch. A gap in the benchmark leaves the agent's own return
  // unadjusted rather than dropping the epoch: the benchmark is the environment's own agent, and its
  // missing read is not something to charge to anyone.
  const benchmark = input.benchmark;
  const benchmarkReturn = (e: number): number => {
    if (!benchmark) return 0;
    const now = benchmark[e];
    const before = benchmark[e - 1];
    if (typeof now !== "number" || typeof before !== "number") return 0;
    if (!(now > 0) || !(before > 0)) return 0;
    return Math.log(now / before);
  };

  for (let e = 1; e <= epochs; e++) {
    if (bankruptAtEpoch !== null) {
      // Zero *excess*: an agent that is out neither gains on the benchmark nor loses to it.
      logReturns.push(0);
      continue;
    }
    const raw = values[e];
    if (raw === null || raw === undefined) {
      // Carry the last value forward. Dropping the epoch instead would shorten the series for
      // exactly the agents the environment failed to read, and a shorter series is a smaller std.
      carriedForwardEpochs.push(e);
      logReturns.push(0);
      continue;
    }
    // G1: the floor is not just ln(0) avoidance. Aave's valueUsdc is collateral - debt and is not
    // clamped, so a liquidated agent's total value can be negative, where ln is NaN rather than
    // -Infinity. Flooring makes bankruptcy a defined event that G2 can hang off, and bounds the
    // worst single-epoch return so one blowup cannot dominate every std in the field.
    const floored = Math.max(raw, floorUsdc);
    logReturns.push(Math.log(floored / previous) - benchmarkReturn(e));
    if (raw <= floorUsdc) bankruptAtEpoch = e;
    previous = floored;
  }

  const mean = logReturns.reduce((sum, x) => sum + x, 0) / epochs;
  const std = populationStd(logReturns, mean);
  return {
    score: mean - lambda * std,
    meanLogReturn: mean,
    stdLogReturn: std,
    logReturns,
    bankruptAtEpoch,
    carriedForwardEpochs,
    floorUsdc,
    lambda,
    benchmarkApplied: benchmark !== undefined,
  };
}

// Score every agent in a reconstructed epoch series. `epochs` pins the denominator across the field,
// and `benchmarkId` names the roster's baseline agent (ADR 0019 §2: the benchmark is an entry in the
// run, not a synthetic series -- it carries the same gas reserve as everyone else, which is exactly
// what has to cancel).
//
// The benchmark is scored too, against itself, so its row is present and reads 0 rather than going
// missing from the report.
export function scoreEpochSeriesByAgent(
  valuesByAgent: Record<string, ReadonlyArray<number | null>>,
  options: Omit<EpochScoreInput, "values" | "benchmark"> & {
    benchmarkId?: string;
  } = {},
): Record<string, EpochScore> {
  const { benchmarkId, ...rest } = options;
  const benchmark =
    benchmarkId !== undefined ? valuesByAgent[benchmarkId] : undefined;
  const scores: Record<string, EpochScore> = {};
  for (const [agentId, values] of Object.entries(valuesByAgent)) {
    const score = scoreEpochSeries({
      ...rest,
      values,
      ...(benchmark ? { benchmark } : {}),
    });
    if (score) scores[agentId] = score;
  }
  return scores;
}
