// The practice period's P (core/src/scoring/practiceReturn.ts). Checked against the formula and
// against the one property the choice rests on: with equal starts it ranks exactly like USDC P.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRACTICE_MIN_CAPITAL_FRACTION,
  practiceReturns,
} from "../core/src/scoring/practiceReturn.js";
import { scoreEpoch } from "../core/src/scoring/deviationScore.js";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("P is V_K / V_0 − 1", () => {
  const r = practiceReturns({
    a: { initialValueUsdc: 100_000, finalValueUsdc: 101_000 },
    b: { initialValueUsdc: 50_000, finalValueUsdc: 49_000 },
  });
  close(r.returnByAgent.a, 0.01);
  close(r.returnByAgent.b, -0.02);
  assert.deepEqual(r.notPlaced, {});
});

test("with equal starts the T are the competition's, to the last digit", () => {
  const ends = {
    a: { initialValueUsdc: 100_000, finalValueUsdc: 103_000 },
    b: { initialValueUsdc: 100_000, finalValueUsdc: 99_000 },
    c: { initialValueUsdc: 100_000, finalValueUsdc: 100_500 },
  };
  const usdc = Object.fromEntries(
    Object.entries(ends).map(([id, e]) => [
      id,
      e.finalValueUsdc - e.initialValueUsdc,
    ]),
  );
  const onUsdc = scoreEpoch({ s: 1, pnlByAgent: usdc }, 1).tByAgent;
  const onReturn = scoreEpoch(
    { s: 1, pnlByAgent: practiceReturns(ends).returnByAgent },
    1,
  ).tByAgent;
  for (const id of Object.keys(ends)) close(onReturn[id], onUsdc[id]);
});

test("with drifted starts it scores the day, not the capital", () => {
  // Same +1% day. On USDC the bigger wallet wins by 3x; on returns they tie.
  const r = practiceReturns({
    rich: { initialValueUsdc: 300_000, finalValueUsdc: 303_000 },
    poor: { initialValueUsdc: 100_000, finalValueUsdc: 101_000 },
    flat: { initialValueUsdc: 100_000, finalValueUsdc: 100_000 },
  });
  const t = scoreEpoch({ s: 1, pnlByAgent: r.returnByAgent }, 1).tByAgent;
  close(t.rich, t.poor);
  assert.ok(t.rich > t.flat);
});

test("an agent starting below the floor, or at zero, is not placed rather than scored 0", () => {
  const r = practiceReturns({
    a: { initialValueUsdc: 100_000, finalValueUsdc: 100_000 },
    b: { initialValueUsdc: 100_000, finalValueUsdc: 100_000 },
    // median start is 100k; the bar is 10k
    dust: { initialValueUsdc: 50, finalValueUsdc: 100 },
    edge: {
      initialValueUsdc: PRACTICE_MIN_CAPITAL_FRACTION * 100_000,
      finalValueUsdc: 10_000,
    },
    broke: { initialValueUsdc: -20, finalValueUsdc: 5 },
  });
  assert.equal(r.notPlaced.dust, "below-capital-floor");
  assert.equal(r.notPlaced.broke, "non-positive-start");
  assert.equal("dust" in r.returnByAgent, false);
  assert.equal("broke" in r.returnByAgent, false);
  // Exactly at the bar is placed.
  close(r.returnByAgent.edge, 0);
});

test("the benchmark is reported, and neither sets the bar nor is held to it", () => {
  const r = practiceReturns(
    {
      a: { initialValueUsdc: 1_000, finalValueUsdc: 1_010 },
      noop: { initialValueUsdc: 50, finalValueUsdc: 50 },
    },
    ["noop"],
  );
  // Had noop's 50 been in the median, the bar would be 52.5 and a would still pass; had noop been
  // held to a's bar (100), it would drop out. Neither happens.
  close(r.returnByAgent.noop, 0);
  close(r.returnByAgent.a, 0.01);
});

test("ends that are not numbers are skipped, not placed", () => {
  const r = practiceReturns({
    a: { initialValueUsdc: 100, finalValueUsdc: Number.NaN },
  });
  assert.deepEqual(r, { returnByAgent: {}, notPlaced: {} });
});
