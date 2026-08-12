// The competition score (ADR 0019 §1): mean_e(x_e) - lambda * std_e(x_e) over the epoch log
// returns, with the bankruptcy floor (G1) and the scoring-side freeze (G2).
//
// These pin the properties the ADR reasons from, not just the arithmetic: doing nothing scores
// exactly 0, beating it requires a per-epoch Sharpe above lambda, the mean telescopes to the
// endpoints (which is why only the boundaries can be manipulated for the mean, and why G4 is not
// needed), and neither dying early nor a gap in the environment's own reads can pay.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LAMBDA,
  scoreEpochSeries,
} from "../core/src/scoring/epochScore.js";

const flat = (value: number, epochs: number) =>
  Array.from({ length: epochs + 1 }, () => value);

test("holding cash scores exactly zero", () => {
  // The reference point the whole metric is read against: mean 0 AND std 0. An agent is above it
  // only by taking risk that paid.
  const score = scoreEpochSeries({ values: flat(100_000, 42) });
  assert.ok(score);
  assert.equal(score.score, 0);
  assert.equal(score.meanLogReturn, 0);
  assert.equal(score.stdLogReturn, 0);
});

test("lambda is the hurdle rate: beating cash needs mean/std > lambda", () => {
  // Same total gain, different paths. The steady one clears the hurdle; the lumpy one does not,
  // which is the whole point of scoring the series rather than the endpoints.
  const steady = scoreEpochSeries({ values: [100, 101, 102.01, 103.0301] });
  assert.ok(steady);
  assert.ok(steady.stdLogReturn < 1e-9, "a constant return has no dispersion");
  assert.ok(steady.score > 0);

  const lumpy = scoreEpochSeries({ values: [100, 90, 110, 103.0301] });
  assert.ok(lumpy);
  assert.ok(
    lumpy.meanLogReturn / lumpy.stdLogReturn < DEFAULT_LAMBDA,
    "this path should sit below the hurdle",
  );
  assert.ok(lumpy.score < 0);
  // Same endpoint, so case A (the mean-only option) would have called these equal.
  assert.ok(
    Math.abs(steady.meanLogReturn - lumpy.meanLogReturn) < 1e-12,
    "the two paths must share a mean for this comparison to mean anything",
  );
});

test("the mean telescopes to the endpoints", () => {
  // ADR 0019 §1: mean = (ln W_E - ln W_0) / E. This is what makes an intermediate boundary push
  // std-only (and therefore what G7 has to defend).
  const values = [100, 130, 90, 121, 150];
  const score = scoreEpochSeries({ values });
  assert.ok(score);
  assert.ok(
    Math.abs(score.meanLogReturn - Math.log(150 / 100) / 4) < 1e-12,
    "the mean is not path-dependent",
  );
});

test("G1: a value at or below the floor is floored, not NaN", () => {
  // Aave's valueUsdc is collateral - debt without a clamp, so a liquidated agent can be worth less
  // than nothing. ln of that is NaN, which would poison the whole field's std.
  const score = scoreEpochSeries({ values: [100_000, 50_000, -2_000, 0] });
  assert.ok(score);
  assert.equal(score.floorUsdc, 1_000);
  assert.ok(Number.isFinite(score.score));
  assert.ok(score.logReturns.every(Number.isFinite));
  assert.equal(score.bankruptAtEpoch, 2);
});

test("G2: the series freezes at the floor even if the position recovers", () => {
  // Freezing is a scoring rule, not a chain rule -- the agent is never stopped from trading. Two
  // agents that both hit the floor score the same regardless of what the mark did afterwards.
  const stayedDown = scoreEpochSeries({ values: [1000, 5, 5, 5] });
  const bouncedBack = scoreEpochSeries({ values: [1000, 5, 900, 2000] });
  assert.ok(stayedDown && bouncedBack);
  assert.equal(bouncedBack.bankruptAtEpoch, 1);
  assert.deepEqual(bouncedBack.logReturns.slice(1), [0, 0]);
  assert.equal(stayedDown.score, bouncedBack.score);
});

test("a missing boundary carries the value forward instead of shortening the series", () => {
  // The gap is the environment's failure. Dropping the epoch would shrink E for exactly the agents
  // it failed to read, and a shorter series is a smaller std.
  const withGap = scoreEpochSeries({ values: [100, 110, null, 121] });
  assert.ok(withGap);
  assert.deepEqual(withGap.carriedForwardEpochs, [2]);
  assert.equal(withGap.logReturns.length, 3);
  assert.equal(withGap.logReturns[1], 0);
  // The move the missing epoch hid is not lost: it lands in the next return, measured from the
  // carried value.
  assert.ok(Math.abs(withGap.logReturns[2] - Math.log(121 / 110)) < 1e-12);
});

test("the denominator is fixed across the field, so dying early cannot pay", () => {
  // ADR 0019 §8. With E free, an agent that blew up in epoch 1 would be scored on a 1-epoch series
  // (mean = the blowup, std = 0) instead of on the week everyone else ran.
  const blownUp = scoreEpochSeries({ values: [1000, 5], epochs: 42 });
  assert.ok(blownUp);
  assert.equal(blownUp.logReturns.length, 42);
  assert.ok(
    blownUp.stdLogReturn > 0,
    "the blowup has to show up as dispersion",
  );
  assert.ok(blownUp.score < 0);

  const freeDenominator = scoreEpochSeries({ values: [1000, 5] });
  assert.ok(freeDenominator);
  assert.ok(
    freeDenominator.score < blownUp.score,
    "sanity: a 1-epoch series is not what the field is scored on",
  );
});

test("a series without a usable start is not scored at all", () => {
  // Inventing W_0 (par, or the first value that did report) would put a number on something nobody
  // measured.
  assert.equal(scoreEpochSeries({ values: [null, 100, 110] }), null);
  assert.equal(scoreEpochSeries({ values: [0, 100] }), null);
  assert.equal(scoreEpochSeries({ values: [100] }), null);
});
