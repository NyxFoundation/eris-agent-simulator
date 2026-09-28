// Which epoch of the competition a run is (issue #167; rules §4.4.1).
//
// Every epoch restarts an agent from the same initial state, and the epoch's weight rises with its
// ordinal (w_s = 1 + 0.5 (s - 1) / (k - 1), core/src/scoring/deviationScore.ts), so how far into the
// competition it is is a fair thing to play on. Until this, only an agent that counted its own
// starts in its state directory could know, and only where state was carried; the timetable plus
// the wall clock breaks when an epoch starts late or is re-run. So the environment says.
//
// The ordinal gives away the weight and nothing else: the regime and the seed stay withheld
// (§3.3, ADR 0027).
//
// Only the scenario-matrix runner sets it. A single run, a single --regime backtest and the practice
// period have no ordinal, and the variables are absent there -- not "1 of 1".
//
// No imports: the backtest CLI reads this before it may load anything that touches sdk/constants.
export const EPOCH_INDEX_ENV = "ERIS_EPOCH_INDEX";
export const EPOCH_COUNT_ENV = "ERIS_EPOCH_COUNT";

// `index` is the scheduled ordinal s (1-based), `count` the schedule's length k. A re-run or resumed
// epoch keeps its original s -- the rules give it the original ordinal and weight (§4.4.2).
export type EpochOrdinal = { index: number; count: number };

/// Read an ordinal from its two variables. Neither = no ordinal. One without the other, or values
/// that are not 1 <= index <= count integers, is an error: half an ordinal is a bug in whoever set it.
export function readEpochOrdinal(
  index: string | number | boolean | undefined,
  count: string | number | boolean | undefined,
): EpochOrdinal | undefined {
  if (index === undefined && count === undefined) return undefined;
  const i = Number(index);
  const k = Number(count);
  if (!Number.isInteger(i) || !Number.isInteger(k) || i < 1 || k < i)
    throw new Error(
      `${EPOCH_INDEX_ENV}=${String(index)} / ${EPOCH_COUNT_ENV}=${String(count)}: an epoch ` +
        "ordinal is two integers, 1 <= index <= count, set together",
    );
  return { index: i, count: k };
}

export function epochOrdinalFromEnv(
  env: Record<string, string | undefined>,
): EpochOrdinal | undefined {
  return readEpochOrdinal(env[EPOCH_INDEX_ENV], env[EPOCH_COUNT_ENV]);
}

export function epochOrdinalEnv(epoch: EpochOrdinal): Record<string, string> {
  return {
    [EPOCH_INDEX_ENV]: String(epoch.index),
    [EPOCH_COUNT_ENV]: String(epoch.count),
  };
}
