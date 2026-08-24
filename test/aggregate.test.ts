// Cross-scenario aggregation candidates (ADR 0020 §5). These are the properties the comparison
// depends on: if the aggregators do not differ in the way they are supposed to, comparing them on
// real data measures nothing.
import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateScenarios,
  orderOf,
  sdInflationFromExtreme,
  transformScenario,
  type ScenarioRow,
} from "../core/src/scoring/aggregate.js";

test("mean keeps the raw metric, zscore normalizes it, borda keeps only the order", () => {
  const byAgent = { a: 100, b: 10, c: 1 };

  assert.deepEqual(transformScenario(byAgent, "mean"), byAgent);

  const z = transformScenario(byAgent, "zscore");
  // Mean 37, population sd sqrt((63^2+27^2+36^2)/3) = sqrt(1998) ~= 44.7.
  assert.equal(Math.round(z.a * 1000) / 1000, 1.409);
  assert.ok(z.a > z.b && z.b > z.c);
  assert.ok(Math.abs(z.a + z.b + z.c) < 1e-9);

  // Points, not places, so that higher is better for every aggregator.
  assert.deepEqual(transformScenario(byAgent, "borda"), { a: 2, b: 1, c: 0 });
});

test("borda is blind to how big the win was; zscore and mean are not", () => {
  // The same order, but the leader's margin is 100x wider in the second scenario.
  const narrow = { a: 3, b: 2, c: 1 };
  const blowout = { a: 300, b: 2, c: 1 };
  assert.deepEqual(
    transformScenario(narrow, "borda"),
    transformScenario(blowout, "borda"),
  );
  assert.notEqual(
    transformScenario(narrow, "zscore").a,
    transformScenario(blowout, "zscore").a,
  );
});

test("borda ties share the places they span, so the column total is fixed", () => {
  const tied = transformScenario({ a: 5, b: 5, c: 1 }, "borda");
  assert.deepEqual(tied, { a: 1.5, b: 1.5, c: 0 });
  // n(n-1)/2 regardless of how the field ties.
  const total = Object.values(tied).reduce((x, y) => x + y, 0);
  assert.equal(total, 3);
  const untied = transformScenario({ a: 5, b: 4, c: 1 }, "borda");
  assert.equal(
    Object.values(untied).reduce((x, y) => x + y, 0),
    3,
  );
});

test("a tied field gains nobody ground under zscore", () => {
  assert.deepEqual(transformScenario({ a: 7, b: 7 }, "zscore"), { a: 0, b: 0 });
});

test("regimes are weighted equally however many seeds each contributed", () => {
  // `calm` runs three times and `crash` once. Agent b wins every calm scenario by a little; agent a
  // wins the single crash scenario by a lot. Equal weight per regime is what makes this a tie.
  const rows = [
    { regime: "calm", seed: 1, byAgent: { a: 0, b: 1 } },
    { regime: "calm", seed: 2, byAgent: { a: 0, b: 1 } },
    { regime: "calm", seed: 3, byAgent: { a: 0, b: 1 } },
    { regime: "crash", seed: 1, byAgent: { a: 1, b: 0 } },
  ];
  const borda = aggregateScenarios(rows, "borda");
  const byId = Object.fromEntries(borda.map((r) => [r.id, r]));
  assert.equal(byId.a.total, 0.5);
  assert.equal(byId.b.total, 0.5);
  assert.deepEqual(byId.a.byRegime, { calm: 0, crash: 1 });
  assert.equal(byId.b.scenariosScored, 4);
});

test("an agent missing from a scenario is skipped there, not scored zero", () => {
  // A zero is a real result -- it is exactly what noop earns -- so spending it on a missing
  // measurement would place a failed agent mid-pack in any scenario where the field lost money.
  const rows: ScenarioRow[] = [
    { regime: "calm", seed: 1, byAgent: { a: -10, b: -20 } },
    { regime: "calm", seed: 2, byAgent: { a: -10, b: -20, c: -15 } },
  ];
  const mean = aggregateScenarios(rows, "mean");
  const c = mean.find((r) => r.id === "c");
  assert.equal(c?.scenariosScored, 1);
  assert.equal(c?.total, -15);
  // Not last: a zero would have put it above both finishers here.
  assert.deepEqual(orderOf(mean), ["a", "c", "b"]);
});

test("sd inflation reproduces issue #55 as a number", () => {
  // The shape #55 reported: a field clustered together plus one participant far below it. The z
  // divisor is the field's sd, so the outlier compresses everyone else by the ratio measured here.
  const field = { a: 10, b: 20, c: 30, d: 40, outlier: -1113 };
  const { ratio, agentId } = sdInflationFromExtreme(field);
  assert.equal(agentId, "outlier");
  assert.ok(ratio > 8, `expected a large inflation, got ${ratio}`);

  // An evenly spread field is not one agent's doing.
  const even = sdInflationFromExtreme({ a: 1, b: 2, c: 3, d: 4 });
  assert.ok(even.ratio < 1.5, `expected ~no inflation, got ${even.ratio}`);
});

test("sd inflation is infinite when the rest of the field ties exactly", () => {
  const { ratio } = sdInflationFromExtreme({ a: 5, b: 5, c: 5, d: 900 });
  assert.equal(ratio, Number.POSITIVE_INFINITY);
});
