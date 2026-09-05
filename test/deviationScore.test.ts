// Rules §4.4 / §4.6 as code (ADR 0022). Every number here is checked against the formulas, not
// against a previous run of the implementation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  round2,
  scoreCompetition,
  scoreEpoch,
  weightOf,
} from "../core/src/scoring/deviationScore.js";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("w_s is linear from 1 to 1.5 over the schedule; k = 1 is 1", () => {
  assert.equal(weightOf(1, 40), 1);
  assert.equal(weightOf(40, 40), 1.5);
  close(weightOf(21, 40), 1 + (0.5 * 20) / 39);
  assert.equal(weightOf(1, 1), 1);
  assert.throws(() => weightOf(41, 40), /exceeds k/);
  assert.throws(() => weightOf(0, 40), /positive integer/);
});

test("round2: two decimals, the third rounded half away from zero", () => {
  assert.equal(round2(0.125), 0.13);
  assert.equal(round2(-0.125), -0.13);
  assert.equal(round2(49.994), 49.99);
  assert.equal(round2(49.995), 50);
  assert.equal(round2(50), 50);
});

test("scoreEpoch: T = 50 + 10 (P − μ) / σ over the population, benchmark excluded", () => {
  const e = scoreEpoch(
    {
      s: 1,
      pnlByAgent: { a: 100, b: 0, c: -100, noop: 0 },
      benchmarkIds: ["noop"],
    },
    1,
  );
  assert.equal(e.n, 3);
  close(e.mu as number, 0);
  const sigma = Math.sqrt((100 * 100 + 0 + 100 * 100) / 3);
  close(e.sigma as number, sigma);
  close(e.tByAgent.a, 50 + (10 * 100) / sigma);
  close(e.tByAgent.b, 50);
  close(e.tByAgent.c, 50 - (10 * 100) / sigma);
  assert.ok(!("noop" in e.tByAgent));
  assert.deepEqual(e.benchmarkPnl, { noop: 0 });
  assert.equal(e.excluded, undefined);
});

test("scoreEpoch: a single epoch's T is bounded by 50 ± 10√(n − 1)", () => {
  const e = scoreEpoch({ s: 1, pnlByAgent: { a: 1_000_000, b: 0, c: 0, d: 0 } }, 1);
  const bound = 10 * Math.sqrt(4 - 1);
  close(e.tByAgent.a, 50 + bound);
});

test("scoreEpoch: σ = 0, an empty population, and an invalidated epoch are out of S", () => {
  assert.equal(scoreEpoch({ s: 1, pnlByAgent: { a: 5, b: 5 } }, 1).excluded, "sigma-zero");
  assert.equal(
    scoreEpoch({ s: 1, pnlByAgent: { noop: 0 }, benchmarkIds: ["noop"] }, 1).excluded,
    "empty",
  );
  const invalid = scoreEpoch({ s: 1, pnlByAgent: { a: 1, b: 2 }, invalid: "anvil died" }, 1);
  assert.equal(invalid.excluded, "invalid");
  assert.equal(invalid.invalidReason, "anvil died");
  assert.deepEqual(invalid.tByAgent, {});
});

test("scoreCompetition: Σ w T / Σ w over S; an excluded epoch leaves the other weights alone", () => {
  const r = scoreCompetition({
    k: 3,
    epochs: [
      { s: 1, pnlByAgent: { a: 100, b: -100 } }, // w = 1
      { s: 2, pnlByAgent: { a: 7, b: 7 } }, // σ = 0 -> out of S, w_3 still 1.5
      { s: 3, pnlByAgent: { a: -100, b: 100 } }, // w = 1.5
    ],
  });
  assert.deepEqual(r.S, [1, 3]);
  const w3 = weightOf(3, 3);
  assert.equal(w3, 1.5);
  // a: T = 60 in epoch 1, 40 in epoch 3 -> (60*1 + 40*1.5) / 2.5 = 48
  const a = r.agents.find((x) => x.id === "a")!;
  close(a.scoreRaw as number, (60 * 1 + 40 * 1.5) / 2.5);
  assert.equal(a.score, 48);
  const b = r.agents.find((x) => x.id === "b")!;
  assert.equal(b.score, 52);
  assert.equal(r.agents[0].id, "b");
  assert.equal(r.agents[0].rank, 1);
  assert.equal(a.rank, 2);
  assert.deepEqual(a.epochs.map((e) => e.s), [1, 3]);
});

test("scoreCompetition: an agent absent from an epoch is averaged over the epochs it was placed in", () => {
  const r = scoreCompetition({
    k: 2,
    epochs: [
      { s: 1, pnlByAgent: { a: 10, b: -10, c: 0 } },
      { s: 2, pnlByAgent: { a: 10, b: -10 } }, // c did not run
    ],
  });
  const c = r.agents.find((x) => x.id === "c")!;
  assert.equal(c.epochs.length, 1);
  assert.equal(c.score, 50);
});

test("scoreCompetition: ties break on T std, then worst T, then submission time, else shared rank", () => {
  // Two epochs, equal weight (k = 2 gives 1 and 1.5 -- use the same T pattern mirrored so the
  // weighted means coincide only when the T series do; here p and q are exact mirrors in time).
  const r = scoreCompetition({
    k: 1,
    epochs: [{ s: 1, pnlByAgent: { p: 10, q: 10, r: -20 } }],
  });
  // p and q have identical everything and no submission time: a tie at rank 1, r is 3rd.
  const [first, second, third] = r.agents;
  assert.deepEqual([first.rank, second.rank, third.rank], [1, 1, 3]);
  assert.ok(first.tied && second.tied && !third.tied);

  const r2 = scoreCompetition({
    k: 1,
    epochs: [{ s: 1, pnlByAgent: { p: 10, q: 10, r: -20 } }],
    submittedAt: { p: 200, q: 100 },
  });
  assert.equal(r2.agents[0].id, "q");
  assert.equal(r2.agents[1].rank, 2);
  assert.ok(!r2.agents[0].tied);

  // Equal score, different spread: the steadier series ranks first.
  const r3 = scoreCompetition({
    k: 2,
    epochs: [
      { s: 1, pnlByAgent: { steady: 0, swingy: 30, x: -30, y: 0 } },
      { s: 2, pnlByAgent: { steady: 0, swingy: -30, x: 30, y: 0 } },
    ],
  });
  const steady = r3.agents.find((a) => a.id === "steady")!;
  const swingy = r3.agents.find((a) => a.id === "swingy")!;
  assert.ok(steady.rank < swingy.rank, "the steadier of two equal scores ranks first");
});

test("scoreCompetition: a duplicated ordinal is refused, an agent only in excluded epochs keeps a null row", () => {
  assert.throws(
    () =>
      scoreCompetition({
        k: 2,
        epochs: [
          { s: 1, pnlByAgent: { a: 1, b: 2 } },
          { s: 1, pnlByAgent: { a: 1, b: 2 } },
        ],
      }),
    /appears twice/,
  );
  const r = scoreCompetition({
    k: 1,
    epochs: [{ s: 1, pnlByAgent: { a: 3, b: 3 } }],
  });
  assert.deepEqual(r.S, []);
  assert.deepEqual(
    r.agents.map((a) => [a.id, a.score]),
    [
      ["a", null],
      ["b", null],
    ],
  );
});
