// While a run is in progress, a public viewer used to see `blocks 0–0` and every venue `—` for the
// whole period — which is exactly when a self-hosted participant wants to know whether their
// transaction landed (issue #84 A). The chain is closed to them, but blocks.csv is not, and the two
// have to combine into one list without double-counting and without lying about what it covers.
import test from "node:test";
import assert from "node:assert/strict";
import {
  coversWindow,
  mergeLiveBlocks,
} from "../dashboard/src/data/liveBlocks.js";

const row = (blockNumber: number, hash: string) => ({ blockNumber, hash });

test("the coordinator's record leads and the chain adds only what is past it", () => {
  const { rows } = mergeLiveBlocks({
    csvRows: [row(100, "0xa"), row(101, "0xb")],
    csvFrom: 100,
    csvCapped: false,
    // The chain window overlaps: 101 is already recorded, 102 is not.
    chainRows: [row(101, "0xb"), row(102, "0xc")],
    chainFrom: 101,
  });
  assert.deepEqual(
    rows.map((r) => r.hash),
    ["0xa", "0xb", "0xc"],
    "the recorded row wins; the chain contributes the block it has not reached",
  );
});

test("a transaction the record has under a different case is still the same transaction", () => {
  const { rows } = mergeLiveBlocks({
    csvRows: [row(100, "0xAB")],
    csvFrom: 100,
    csvCapped: false,
    chainRows: [row(101, "0xab")],
    chainFrom: 100,
  });
  assert.equal(rows.length, 1, "hashes compare case-insensitively");
});

test("coverage is the range fetched, not where the first transaction happens to sit", () => {
  // Ten quiet blocks then one busy one: the quiet blocks are covered, and a round over them has a
  // count of zero rather than "not counted".
  const { blocksFrom } = mergeLiveBlocks({
    csvRows: [row(1_390, "0xa")],
    csvFrom: 1_380,
    csvCapped: false,
    chainRows: [],
    chainFrom: null,
  });
  assert.equal(blocksFrom, 1_380);
});

test("once the cap cuts the front off, coverage moves with it", () => {
  // A day-long segment outgrows what a page holds. What fell off is not covered any more, and
  // saying otherwise would report 0 for the morning.
  const { blocksFrom } = mergeLiveBlocks({
    csvRows: [row(9_000, "0xa"), row(9_001, "0xb")],
    csvFrom: 1_380,
    csvCapped: true,
    chainRows: [],
    chainFrom: null,
  });
  assert.equal(blocksFrom, 9_000);
});

test("with no record and no chain, nothing is covered — which is not the same as nothing happened", () => {
  const { rows, blocksFrom } = mergeLiveBlocks({
    csvRows: [],
    csvFrom: null,
    csvCapped: false,
    chainRows: [],
    chainFrom: null,
  });
  assert.deepEqual(rows, []);
  assert.equal(blocksFrom, null);
});

test("the chain alone covers its own window", () => {
  const { blocksFrom } = mergeLiveBlocks({
    csvRows: [],
    csvFrom: null,
    csvCapped: false,
    chainRows: [row(1_500, "0xa")],
    chainFrom: 1_471,
  });
  assert.equal(
    blocksFrom,
    1_471,
    "the operator's view, where the chain is readable",
  );
});

test("a round is counted when the view covers its window, and not counted when it does not", () => {
  // A round's window is exclusive of its first block, so a round starting one block before the
  // coverage is still fully inside it.
  assert.equal(coversWindow(1_379, 1_380, true), true);
  assert.equal(coversWindow(1_378, 1_380, true), false);
  assert.equal(coversWindow(1_400, 1_380, true), true);
  // Nothing covered on a live run: no round has a count.
  assert.equal(coversWindow(1_400, null, true), false);
  // An archived run has the whole file; there is no window to be outside of.
  assert.equal(coversWindow(0, null, false), true);
});
