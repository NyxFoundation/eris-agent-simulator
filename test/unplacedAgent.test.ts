// An agent that joined part-way through has no P for the segment it joined in, and a zero is not
// the same statement (issue #84 X2).
//
// The failure was end to end, which is why this test is too. `LiveScorer.addAgent` leaves the
// boundaries before a registration null -- correctly -- and the segment writer collapsed the
// missing P into `netPnlUsdc: 0`; the standings read that as a P of exactly zero, and a zero beats
// every agent that lost. A participant registered at 14:00 outranked the field on a day they were
// never measured in.
//
// Two halves, and they have to agree: what the writer records, and what the reader makes of it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  segmentAgentRecord,
  segmentIndexAgent,
  sliceEpochSeries,
} from "../core/src/segments.js";
import { epochPnlFromSeries } from "../core/src/scoring/epochPnl.js";
import { scenarioAgentP } from "../dashboard/src/data/scenarioP.js";
import { scoreEpoch } from "../core/src/scoring/deviationScore.js";

const identity = (id: string) => ({
  id,
  address: `0x${id}`,
  baseline: false,
  includedTxCount: 3,
  revertCount: 0,
});

test("an agent with no starting value is recorded as unscored, not as zero", () => {
  // What addAgent leaves behind: nulls for every boundary before the registration.
  const joined = epochPnlFromSeries([null, null, 10_000]);
  assert.equal(joined, null, "no V_0 is no P");
  const record = segmentAgentRecord(identity("carol"), joined);
  assert.equal(record.scored, false);
  assert.ok(
    !("netPnlUsdc" in record),
    "the record carries no PnL field at all, so nothing can read one as 0",
  );
  assert.match(record.unscoredReason ?? "", /no P for this segment/);
  // The agent stays in the record: the transaction views and the participant lookup need it.
  assert.equal(record.id, "carol");
  assert.equal(record.includedTxCount, 3);
});

test("an agent measured at both ends keeps its P", () => {
  const record = segmentAgentRecord(
    identity("alice"),
    epochPnlFromSeries([10_000, 10_500, 9_800]),
  );
  assert.equal(record.scored, true);
  assert.equal(record.scored && record.pnlUsdc, -200);
  assert.equal(record.scored && record.netPnlUsdc, -200);
});

test("the period index carries the same distinction the summary does", () => {
  const scored = segmentIndexAgent(
    segmentAgentRecord(identity("alice"), epochPnlFromSeries([100, 90])),
  );
  const unscored = segmentIndexAgent(
    segmentAgentRecord(identity("carol"), null),
  );
  assert.equal(scored.pnlUsdc, -10);
  assert.equal(scored.scored, true);
  assert.equal(unscored.scored, false);
  assert.ok(
    !("netPnlUsdc" in unscored),
    "no number to be mistaken for a result",
  );
});

test("the dashboard reads a missing P as not placed, and a zero P as zero", () => {
  // A series that holds the agent decides on its own: falling through to a stored number is what
  // turned a missing measurement into a P of 0.
  assert.equal(
    scenarioAgentP({ netPnlUsdc: 0 }, [null, null, 10_000]),
    undefined,
  );
  assert.equal(
    scenarioAgentP({ scored: false, pnlUsdc: 0 }, undefined),
    undefined,
  );
  assert.equal(
    scenarioAgentP({ netPnlUsdc: 12 }, undefined),
    12,
    "no series: the stored number",
  );
  assert.equal(
    scenarioAgentP({ pnlUsdc: 5, netPnlUsdc: 9 }, undefined),
    5,
    "P wins over net PnL",
  );
  assert.equal(
    scenarioAgentP({}, [100, 130]),
    30,
    "the series, when the record has no P",
  );
  assert.equal(scenarioAgentP({}, [0, 0]), 0, "a real zero is still a zero");
});

test("an unplaced agent is out of the population, not at the top of it", () => {
  // The shape of the day the walk-through found: everyone else lost, and the agent that was never
  // measured came fourth of five on a P of zero.
  const placed = { alice: -500, bob: -200, dave: -900 };
  const withPhantomZero = scoreEpoch(
    { s: 1, pnlByAgent: { ...placed, carol: 0 } },
    1,
  );
  assert.ok(
    withPhantomZero.tByAgent.carol > withPhantomZero.tByAgent.bob,
    "the zero it used to be given beat every loser",
  );
  const asRecorded = scoreEpoch({ s: 1, pnlByAgent: placed }, 1);
  assert.equal(asRecorded.n, 3, "the field is who was measured");
  assert.ok(!("carol" in asRecorded.tByAgent));
});

test("a segment that starts on a boundary still measures everyone who was there", () => {
  // The carry rule and the unplaced rule are different things: an agent present at the segment's
  // opening boundary has a P for it even when the slice carries no earlier boundary.
  const cut = sliceEpochSeries(
    { boundaryBlocks: [100, 110, 120], valuesByAgent: { alice: [1, 2, 3] } },
    110,
    120,
  );
  assert.deepEqual(cut.boundaryBlocks, [110, 120]);
  assert.equal(
    segmentAgentRecord(
      identity("alice"),
      epochPnlFromSeries(cut.valuesByAgent.alice),
    ).scored,
    true,
  );
});
