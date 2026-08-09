// Scenario-matrix aggregation (ADR 0017 §4).
//
// The properties worth pinning are the ones that decide a competition: a regime with a bigger
// opportunity must not dominate the ranking, a crashed agent must not out-rank a finisher, and an
// environment failure must not be charged to the participants.
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeStandings,
  scenarioZScores,
  DISQUALIFIED_Z_PENALTY,
  type ScenarioResult,
} from "../core/src/backtest/standings.js";

const agent = (id: string, netPnlUsdc: number, disqualified?: string) => ({
  id,
  netPnlUsdc,
  ...(disqualified !== undefined ? { disqualified } : {}),
});

test("z-scores are centered on the scenario's finishers", () => {
  const { z } = scenarioZScores(
    [agent("a", 800), agent("b", 200), agent("c", -100)],
    "netPnlUsdc",
  );
  // mean 300, population sd sqrt(140000) ~ 374.17
  assert.ok(Math.abs(z.a - 1.336) < 0.01, `z.a=${z.a}`);
  assert.ok(Math.abs(z.b - -0.267) < 0.01, `z.b=${z.b}`);
  assert.ok(Math.abs(z.c - -1.069) < 0.01, `z.c=${z.c}`);
  // Centering means they sum to zero: nobody gains ground without someone losing it.
  assert.ok(Math.abs(z.a + z.b + z.c) < 1e-9);
});

test("a tie gives everyone zero rather than dividing by zero", () => {
  const { z } = scenarioZScores(
    [agent("a", 0), agent("b", 0), agent("c", 0)],
    "netPnlUsdc",
  );
  assert.deepEqual(z, { a: 0, b: 0, c: 0 });
});

test("a lone finisher scores zero (there is nobody to be better than)", () => {
  const { z } = scenarioZScores([agent("a", 500)], "netPnlUsdc");
  assert.deepEqual(z, { a: 0 });
});

test("a disqualified agent lands below the worst finisher", () => {
  const { z, disqualified } = scenarioZScores(
    [agent("a", 800), agent("b", 200), agent("c", 9999, "process died")],
    "netPnlUsdc",
  );
  assert.equal(disqualified.c, "process died");
  const worstFinisher = Math.min(z.a, z.b);
  assert.equal(z.c, worstFinisher - DISQUALIFIED_Z_PENALTY);
  // Crucially: a huge raw score does not rescue it.
  assert.ok(z.c < z.a && z.c < z.b);
});

test("an agent with no readable metric is disqualified, not scored as zero", () => {
  // Scoring it as 0 would place it mid-pack in a scenario where everyone lost money.
  const { z, disqualified } = scenarioZScores(
    [agent("a", -500), agent("b", -300), { id: "c" }],
    "netPnlUsdc",
  );
  assert.match(disqualified.c, /no netPnlUsdc/);
  assert.ok(z.c < z.a && z.c < z.b);
});

test("regime equal weighting stops the big-opportunity regime from deciding the ranking", () => {
  // crash pays in the hundreds, calm in the tens. On a raw sum a wins; the ranking should say b.
  const results: ScenarioResult[] = [
    {
      regime: "crash",
      seed: 1,
      agents: [agent("a", 800), agent("b", 200), agent("c", -100)],
    },
    {
      regime: "calm",
      seed: 1,
      agents: [agent("a", 10), agent("b", 40), agent("c", 25)],
    },
  ];
  const rawSum = { a: 810, b: 240, c: -75 };
  assert.ok(rawSum.a > rawSum.b, "precondition: a wins on the raw sum");

  const standings = computeStandings(results, "netPnlUsdc");
  assert.deepEqual(
    standings.agents.map((x) => x.id),
    ["b", "a", "c"],
  );
});

test("seed count inside a regime does not change that regime's weight", () => {
  // calm is run three times and crash once. calm must still be worth exactly half the total.
  const calm = (seed: number): ScenarioResult => ({
    regime: "calm",
    seed,
    agents: [agent("a", 10), agent("b", 40)],
  });
  const many = computeStandings(
    [
      { regime: "crash", seed: 1, agents: [agent("a", 800), agent("b", 200)] },
      calm(1),
      calm(2),
      calm(3),
    ],
    "netPnlUsdc",
  );
  const one = computeStandings(
    [
      { regime: "crash", seed: 1, agents: [agent("a", 800), agent("b", 200)] },
      calm(1),
    ],
    "netPnlUsdc",
  );
  const totalOf = (s: typeof many, id: string) =>
    s.agents.find((x) => x.id === id)?.total ?? NaN;
  assert.ok(Math.abs(totalOf(many, "a") - totalOf(one, "a")) < 1e-9);
  assert.ok(Math.abs(totalOf(many, "b") - totalOf(one, "b")) < 1e-9);
});

test("a scenario with no summary is excluded, not scored as a row of zeros", () => {
  const standings = computeStandings(
    [
      { regime: "calm", seed: 1, agents: [agent("a", 100), agent("b", -100)] },
      { regime: "calm", seed: 2, error: "anvil died" },
    ],
    "netPnlUsdc",
  );
  assert.equal(standings.scenarios.length, 1);
  assert.deepEqual(standings.excludedScenarios, [
    { regime: "calm", seed: 2, error: "anvil died" },
  ]);
  // The surviving scenario alone decides the ranking; the dead one dilutes nothing.
  const a = standings.agents.find((x) => x.id === "a");
  assert.equal(a?.scenariosScored, 1);
  assert.ok((a?.total ?? 0) > 0);
});

test("disqualifications are counted per agent", () => {
  const standings = computeStandings(
    [
      {
        regime: "crash",
        seed: 1,
        agents: [agent("a", 100), agent("b", 0, "fee cap violation")],
      },
      {
        regime: "crash",
        seed: 2,
        agents: [agent("a", 100), agent("b", 50)],
      },
    ],
    "netPnlUsdc",
  );
  const b = standings.agents.find((x) => x.id === "b");
  assert.equal(b?.disqualifications, 1);
  assert.equal(b?.scenariosScored, 2);
});

test("the metric is selectable, and the two can disagree on the winner", () => {
  // a is up on gross PnL purely by holding a rising asset; b took the edge.
  const results: ScenarioResult[] = [
    {
      regime: "calm",
      seed: 1,
      agents: [
        { id: "a", netPnlUsdc: 1000, alphaUsdc: 0 },
        { id: "b", netPnlUsdc: 200, alphaUsdc: 200 },
      ],
    },
  ];
  assert.equal(computeStandings(results, "netPnlUsdc").agents[0].id, "a");
  assert.equal(computeStandings(results, "alphaUsdc").agents[0].id, "b");
});
