// Scenario-matrix standings under rules §4.4 (ADR 0023). The properties worth pinning are the ones
// that decide a competition: the benchmark never enters the population, an epoch the environment
// lost is never charged to some participants only, and a stopped agent is scored on what it left
// behind rather than disqualified.
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeStandings,
  type ScenarioResult,
} from "../core/src/backtest/standings.js";
import { weightOf } from "../core/src/scoring/deviationScore.js";

const agent = (
  id: string,
  pnlUsdc: number,
  extra: Partial<{ baseline: boolean; flags: string[] }> = {},
) => ({ id, pnlUsdc, pnlSource: "epoch-boundaries" as const, ...extra });

test("the benchmark is valued and reported but never in the population", () => {
  const s = computeStandings(
    [
      {
        s: 1,
        regime: "calm",
        seed: 1,
        agents: [agent("a", 100), agent("b", -100), agent("noop", 0, { baseline: true })],
      },
    ],
    1,
  );
  assert.equal(s.epochs[0].n, 2);
  assert.deepEqual(s.agents.map((a) => a.id), ["a", "b"]);
  assert.deepEqual(s.benchmarks, [{ id: "noop", pnlByEpoch: { 1: 0 } }]);
  assert.equal(s.agents[0].score, 60);
  assert.equal(s.agents[1].score, 40);
});

test("an epoch with no summary is invalid for everyone and leaves the other weights alone", () => {
  const results: ScenarioResult[] = [
    { s: 1, regime: "calm", seed: 1, agents: [agent("a", 10), agent("b", -10)] },
    { s: 2, regime: "crash", seed: 1, error: "anvil died" },
    { s: 3, regime: "whale", seed: 1, agents: [agent("a", 10), agent("b", -10)] },
  ];
  const s = computeStandings(results, 3);
  assert.deepEqual(s.S, [1, 3]);
  assert.equal(s.epochs[1].excluded, "invalid");
  assert.equal(s.epochs[1].invalidReason, "anvil died");
  assert.equal(s.epochs[2].w, weightOf(3, 3));
  assert.equal(s.agents[0].id, "a");
  assert.equal(s.agents[0].score, 60);
});

test("a stopped agent keeps its P and its flags; it is not disqualified", () => {
  const s = computeStandings(
    [
      {
        s: 1,
        regime: "calm",
        seed: 1,
        agents: [
          agent("a", 50),
          agent("crashed", -50, { flags: ["process exited early: code 137"] }),
        ],
      },
    ],
    1,
  );
  const crashed = s.agents.find((a) => a.id === "crashed")!;
  assert.equal(crashed.score, 40);
  assert.deepEqual(crashed.flags, ["calm#1: process exited early: code 137"]);
});

test("an agent without a P for an epoch was not placed in it and is scored on the rest", () => {
  const s = computeStandings(
    [
      { s: 1, regime: "calm", seed: 1, agents: [agent("a", 10), agent("b", -10), { id: "c" }] },
      { s: 2, regime: "calm", seed: 2, agents: [agent("a", 10), agent("b", -10), agent("c", 0)] },
    ],
    2,
  );
  const c = s.agents.find((a) => a.id === "c")!;
  assert.equal(c.epochs.length, 1);
  assert.equal(c.score, 50);
  assert.equal(s.epochs[0].n, 2);
});

test("epochs carry their scenario identity and run directory back out", () => {
  const s = computeStandings(
    [{ s: 1, regime: "depeg", seed: 701, runDir: "runs/x", agents: [agent("a", 1), agent("b", 2)] }],
    1,
  );
  assert.equal(s.epochs[0].regime, "depeg");
  assert.equal(s.epochs[0].seed, 701);
  assert.equal(s.epochs[0].runDir, "runs/x");
});
