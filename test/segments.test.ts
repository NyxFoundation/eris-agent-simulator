// ADR 0021 §6: the chain runs for a week, the output is cut into days.
//
// The part worth pinning is the seam. An epoch boundary belongs to the segment it falls in, but the
// *return* into a segment's first boundary comes from the last boundary of the one before — so a
// slice that starts strictly at the segment loses one epoch per segment, seven over a week, and
// nothing about the resulting scores would look wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SegmentedRun, sliceEpochSeries } from "../core/src/segments.js";

const series = {
  boundaryBlocks: [100, 110, 120, 130, 140],
  valuesByAgent: { a: [1, 2, 3, 4, 5], b: [10, 20, 30, 40, 50] },
};

test("a segment starting mid-epoch carries the boundary before it", () => {
  // The roll landed at 125, between boundaries. The epoch that ends at 130 began at 120, outside
  // this segment — without carrying 120 the segment would open with no value to return from, and
  // that epoch would belong to nobody.
  const cut = sliceEpochSeries(series, 125, 140);
  assert.deepEqual(cut.boundaryBlocks, [120, 130, 140]);
  assert.deepEqual(cut.valuesByAgent.a, [3, 4, 5]);
});

test("a segment starting on a boundary carries nothing extra", () => {
  // The common case: the roll is checked right after the boundary read, so it lands on one. That
  // boundary is already the segment's opening value; carrying another would hand the previous
  // segment's last return to this one as well — the same epoch scored twice.
  const cut = sliceEpochSeries(series, 120, 140);
  assert.deepEqual(cut.boundaryBlocks, [120, 130, 140]);
  assert.deepEqual(cut.valuesByAgent.a, [3, 4, 5]);
});

test("the first segment has no boundary before it and does not invent one", () => {
  const cut = sliceEpochSeries(series, 100, 120);
  assert.deepEqual(cut.boundaryBlocks, [100, 110, 120]);
  assert.deepEqual(cut.valuesByAgent.b, [10, 20, 30]);
});

test("segments partition the epochs: every return belongs to exactly one", () => {
  // The seam is shared but the *returns* are not — which is the property that matters, because the
  // score averages returns.
  const first = sliceEpochSeries(series, 100, 120);
  const second = sliceEpochSeries(series, 120, 140);
  const returns = (s: { boundaryBlocks: number[] }) =>
    s.boundaryBlocks.slice(1).map((b, i) => `${s.boundaryBlocks[i]}->${b}`);
  assert.deepEqual(
    [...returns(first), ...returns(second)],
    ["100->110", "110->120", "120->130", "130->140"],
  );
});

test("a segment holding no boundary yields no epoch rather than a phantom one", () => {
  const cut = sliceEpochSeries(series, 141, 150);
  assert.deepEqual(cut.boundaryBlocks, [140]); // only the carried one
  assert.equal(cut.boundaryBlocks.length - 1, 0);
});

test("rolling writes a competition index whose entries are contiguous and unique", () => {
  const root = mkdtempSync(join(tmpdir(), "eris-seg-"));
  const run = new SegmentedRun({
    root,
    competitionId: "period",
    hours: 24,
    scenarioSet: "practice",
  });
  run.noteFirstBlock(100);
  const first = run.runDir;
  run.event({ type: "hello" });
  run.roll(120, [{ id: "a", score: 1 }]);
  const second = run.runDir;
  run.roll(140, [{ id: "a", score: 2 }]);
  run.finish(160, [{ id: "a", score: 3 }]);

  assert.notEqual(first, second, "each segment is its own directory");
  const index = JSON.parse(
    readFileSync(join(root, "period", "matrix.json"), "utf8"),
  );
  // Truthfully continuous: these are cuts of one world, so `npm run metrics` will not mix them
  // with scenario runs (ADR 0020 §1).
  assert.equal(index.resetUnit, "continuous");
  assert.equal(index.scenarios.length, 3);
  assert.deepEqual(
    index.scenarios.map((s: { fromBlock: number; toBlock: number }) => [
      s.fromBlock,
      s.toBlock,
    ]),
    [
      [100, 120],
      [120, 140],
      [140, 160],
    ],
    "segments tile the chain with no gap",
  );
  // runDir is what identifies a scenario downstream — a label can repeat when two segments start in
  // the same minute, and keying on it once collapsed six segments into one.
  const dirs = index.scenarios.map((s: { runDir: string }) => s.runDir);
  assert.equal(new Set(dirs).size, dirs.length);
  for (const dir of dirs)
    assert.ok(existsSync(join(root, dir.split("/").slice(1).join("/"))));
});
