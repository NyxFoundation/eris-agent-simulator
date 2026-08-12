// The competition score (ADR 0019 §1): risk-adjusted log growth over the epoch value series.
//
//   x_e   = ln( W_e / W_{e-1} )        e = 1..E
//   W     = max( V, 0.01 * W_init )    G1, the bankruptcy floor
//   score = mean_e(x_e) - lambda * std_e(x_e)
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

  for (let e = 1; e <= epochs; e++) {
    if (bankruptAtEpoch !== null) {
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
    logReturns.push(Math.log(floored / previous));
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
  };
}

// Score every agent in a reconstructed epoch series. `epochs` pins the denominator across the field.
export function scoreEpochSeriesByAgent(
  valuesByAgent: Record<string, ReadonlyArray<number | null>>,
  options: Omit<EpochScoreInput, "values"> = {},
): Record<string, EpochScore> {
  const scores: Record<string, EpochScore> = {};
  for (const [agentId, values] of Object.entries(valuesByAgent)) {
    const score = scoreEpochSeries({ ...options, values });
    if (score) scores[agentId] = score;
  }
  return scores;
}
