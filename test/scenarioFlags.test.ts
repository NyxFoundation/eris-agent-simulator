// Issue #102 (#91 F2): an epoch in which every agent died was written up as a scored epoch. The
// per-agent flags say who died; the epoch-level flag says that nobody was left, where a reader of
// the standings looks.
import test from "node:test";
import assert from "node:assert/strict";
import { scenarioFlags } from "../core/src/backtest/scenarioScores.js";
import { computeStandings } from "../core/src/backtest/standings.js";

const alive = (id: string) => ({ id, pnlUsdc: 1 });
const dead = (id: string) => ({
  id,
  pnlUsdc: 0,
  flags: ["process exited early: exit code 1"],
});

test("every non-baseline agent gone is an uncontested epoch; the baseline does not count", () => {
  assert.deepEqual(scenarioFlags([alive("a"), alive("b")]), []);
  assert.deepEqual(scenarioFlags([]), []);
  const flags = scenarioFlags([
    dead("a"),
    dead("b"),
    { id: "noop", pnlUsdc: 0, baseline: true },
  ]);
  assert.equal(flags.length, 1);
  assert.match(flags[0], /^uncontested: every non-baseline agent \(2\) exited early/);
  // A dead baseline alone does not make the epoch uncontested.
  assert.deepEqual(
    scenarioFlags([alive("a"), { ...dead("noop"), baseline: true }]),
    [],
  );
});

test("a partly dead field is counted, not called uncontested", () => {
  assert.deepEqual(scenarioFlags([dead("a"), alive("b"), alive("c")]), [
    "1 of 3 non-baseline agents exited early",
  ]);
});

test("the epoch flag reaches standings.json beside the epoch it describes", () => {
  const standings = computeStandings(
    [
      { s: 1, regime: "calm", seed: 1, agents: [alive("a"), { id: "b", pnlUsdc: -1 }] },
      {
        s: 2,
        regime: "crash",
        seed: 1,
        agents: [dead("a"), dead("b")],
        flags: scenarioFlags([dead("a"), dead("b")]),
      },
    ],
    2,
  );
  assert.equal(standings.epochs[0].flags, undefined);
  assert.match(standings.epochs[1].flags?.[0] ?? "", /^uncontested/);
});
