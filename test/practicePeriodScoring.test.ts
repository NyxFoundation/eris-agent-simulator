// The practice period's standings, end to end over the pieces that are importable under node: what
// the segment writer records -> the ends the dashboard reads back -> the return -> the equal-weight
// score. (dashboard/src/data/standings.ts wires exactly these; it imports through the `@core` alias,
// which node does not resolve.)
import test from "node:test";
import assert from "node:assert/strict";
import { segmentAgentRecord, segmentIndexAgent } from "../core/src/segments.js";
import { epochPnlFromSeries } from "../core/src/scoring/epochPnl.js";
import { practiceReturns } from "../core/src/scoring/practiceReturn.js";
import { scoreCompetition } from "../core/src/scoring/deviationScore.js";
import { scenarioAgentEnds } from "../dashboard/src/data/scenarioP.js";

const identity = (id: string, baseline = false) => ({
  id,
  address: `0x${id}`,
  baseline,
  includedTxCount: 1,
  revertCount: 0,
});

// One day: every agent's boundary series, written and read back the way a segment is.
function day(
  series: Record<string, Array<number | null>>,
  baseline: string[] = [],
) {
  const ends: Record<
    string,
    { initialValueUsdc: number; finalValueUsdc: number }
  > = {};
  for (const [id, values] of Object.entries(series)) {
    const record = segmentIndexAgent(
      segmentAgentRecord(
        identity(id, baseline.includes(id)),
        epochPnlFromSeries(values),
      ),
    ) as Parameters<typeof scenarioAgentEnds>[0];
    const e = scenarioAgentEnds(record, values);
    if (e) ends[id] = e;
  }
  return practiceReturns(ends, baseline);
}

test("a period is scored on each day's return, every day weighted the same", () => {
  // Day 1 leaves `big` with twice the capital. On day 2 both make +1%: in USDC `big` would win the
  // day by 2x; on returns they tie, and so the period score is decided by day 1 alone.
  const d1 = day(
    {
      big: [100_000, 200_000],
      small: [100_000, 100_000],
      mid: [100_000, 150_000],
      noop: [100_000, 100_000],
    },
    ["noop"],
  );
  const d2 = day(
    {
      big: [200_000, 202_000],
      small: [100_000, 101_000],
      mid: [150_000, 150_000],
      noop: [100_000, 100_000],
    },
    ["noop"],
  );
  const r = scoreCompetition({
    k: 2,
    weighting: "equal",
    epochs: [
      { s: 1, pnlByAgent: d1.returnByAgent, benchmarkIds: ["noop"] },
      { s: 2, pnlByAgent: d2.returnByAgent, benchmarkIds: ["noop"] },
    ],
  });
  const t2 = r.epochs[1].tByAgent;
  assert.ok(Math.abs(t2.big - t2.small) < 1e-9, "same return, same T");
  assert.equal(r.epochs[1].w, 1);
  assert.equal(r.agents[0].id, "big");
  assert.equal(r.epochs[0].n, 3, "the benchmark is not in the field");
});

test("a mid-day registrant is still not placed, and the floor is its own reason", () => {
  const d = day({
    a: [100_000, 101_000],
    b: [100_000, 99_000],
    late: [null, 100_000],
    dust: [20, 40],
  });
  assert.equal("late" in d.returnByAgent, false);
  assert.equal(
    "late" in d.notPlaced,
    false,
    "no ends at all -- the unscored record says why",
  );
  assert.equal(d.notPlaced.dust, "below-capital-floor");
  assert.deepEqual(Object.keys(d.returnByAgent).sort(), ["a", "b"]);
});
