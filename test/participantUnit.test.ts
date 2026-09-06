// Rules §2.2: a participant unit may enter two submissions and is scored on the higher. The
// standings can only do that if they know which agents are one unit, so `participant` has to survive
// every hop from the roster to matrix.json. Pinned hop by hop; the scoring arithmetic is untouched
// and still ranks agents.
import test from "node:test";
import assert from "node:assert/strict";
import { validateAgentsFile } from "../core/src/config.js";
import {
  scoresFromSummary,
  type RunSummary,
} from "../core/src/backtest/scenarioScores.js";
import { computeStandings } from "../core/src/backtest/standings.js";

test("the roster keeps `participant` and refuses one that is not a name", () => {
  const [a, b] = validateAgentsFile(
    {
      agents: [
        { id: "team-x-a", wallet: "AUTO", participant: "team-x" },
        { id: "solo", wallet: "AGENT1_PRIVATE_KEY" },
      ],
    },
    "test",
  );
  assert.equal(a.participant, "team-x");
  assert.equal(b.participant, undefined);
  for (const participant of ["", "   ", 42, { name: "x" }])
    assert.throws(
      () =>
        validateAgentsFile(
          { agents: [{ id: "a", wallet: "AUTO", participant }] },
          "test",
        ),
      /participant must be a non-empty string/,
    );
});

test("`participant` travels from summary.json into the matrix record", () => {
  const summary: RunSummary = {
    runDir: "runs/x",
    agents: [
      { id: "team-x-a", participant: "team-x", pnlUsdc: 10 },
      { id: "team-x-b", participant: "team-x", pnlUsdc: -4 },
      { id: "solo", pnlUsdc: 1 },
      { id: "noop", baseline: true, pnlUsdc: 0 },
    ],
    violations: [],
  };
  const scores = scoresFromSummary(summary, []);
  assert.equal(scores.find((s) => s.id === "team-x-a")?.participant, "team-x");
  assert.equal(scores.find((s) => s.id === "team-x-b")?.participant, "team-x");
  // Absent means absent, not null or "": the agent is its own unit.
  assert.equal("participant" in scores.find((s) => s.id === "solo")!, false);

  // And on into the standings, beside the flags, without changing a score: T is still per agent.
  const standings = computeStandings(
    [{ s: 1, regime: "calm", seed: 1, agents: scores }],
    1,
  );
  const a = standings.agents.find((x) => x.id === "team-x-a")!;
  const b = standings.agents.find((x) => x.id === "team-x-b")!;
  assert.equal(a.participant, "team-x");
  assert.equal(b.participant, "team-x");
  assert.equal(
    standings.agents.find((x) => x.id === "solo")!.participant,
    undefined,
  );
  assert.ok(a.score !== null && b.score !== null && a.score > b.score);
});
