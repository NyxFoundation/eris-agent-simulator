// Every candidate metric read off one stored series (issue #56). What is pinned here is the
// relationships the catalogue asserts between them -- if those hold, a disagreement in the table is
// a real disagreement about ranking rather than an arithmetic slip in one of the readings.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bordaTotals,
  metricsForAgent,
  metricsForRun,
  rankBy,
} from "../core/src/scoring/metrics.js";

const flat = (v: number, n: number) => Array.from({ length: n + 1 }, () => v);

test("M4 is E times M9's mean term", () => {
  // The catalogue's reason for treating case A as "M9 without the risk term": the log returns
  // telescope, so the excess growth over the run is the mean excess return times the epoch count.
  const bench = [100, 102, 101, 104];
  const values = [100, 103, 104, 110];
  const m = metricsForAgent("a", values, bench);
  assert.ok(m);
  assert.ok(
    Math.abs(m.excessLogGrowth - m.meanLogReturn * m.epochs) < 1e-12,
    "M4 and M9's mean term disagree",
  );
});

test("M7 at rho = 1 degenerates to the mean log return", () => {
  // MPPM's 1/(1-rho) is undefined there, and the limit is the log-utility case -- which is exactly
  // why the catalogue files M4, M6 and M7 as one family.
  const bench = [100, 102, 101, 104];
  const values = [100, 103, 104, 110];
  const m = metricsForAgent("a", values, bench, { rho: 1 });
  assert.ok(m);
  assert.ok(Math.abs(m.mppm - m.meanLogReturn) < 1e-12);
});

test("the benchmark is normalised by its own start, not the agent's", () => {
  // The baseline entry is funded like everyone else here, but nothing in the metric should depend on
  // that: a benchmark ten times the size has to give the same excess growth.
  const values = [100, 110];
  const small = metricsForAgent("a", values, [100, 105]);
  const large = metricsForAgent("a", values, [1000, 1050]);
  assert.ok(small && large);
  assert.ok(Math.abs(small.excessLogGrowth - large.excessLogGrowth) < 1e-12);
});

test("an agent that matched the benchmark scores zero on every risk-adjusted metric", () => {
  const bench = [100, 97, 105, 101];
  const m = metricsForAgent("twin", [...bench], bench);
  assert.ok(m);
  assert.equal(m.score, 0);
  assert.equal(m.excessLogGrowth, 0);
  assert.equal(m.sharpePerEpoch, 0);
  // M1 is the exception, and that is the point of having it in the table: it still reports the
  // benchmark's own drift as if the agent had earned it.
  assert.ok(Math.abs(m.totalPnlUsdc - 1) < 1e-12);
});

test("rankings and Borda run off the same numbers", () => {
  const run = metricsForRun(
    "r1",
    {
      noop: flat(100, 3),
      winner: [100, 105, 110, 120],
      loser: [100, 99, 98, 97],
    },
    "noop",
  );
  assert.deepEqual(rankBy(run, "score"), ["winner", "noop", "loser"]);
  const totals = bordaTotals([run, run], "score");
  assert.equal(totals.winner, 2);
  assert.equal(totals.noop, 4);
  assert.equal(totals.loser, 6);
});

test("a run with no benchmark still reports, on raw returns", () => {
  // Reported rather than refused: an old run without a baseline entry is still worth reading, as
  // long as nothing claims its figures are excess.
  const run = metricsForRun("r", { solo: [100, 110, 121] }, undefined);
  assert.equal(run.agents.length, 1);
  assert.ok(run.agents[0].excessLogGrowth > 0);
});
