// Issue #140: the evaluation interval's `epoch` names became `interval`, and the old names are still
// read until the results are published. What has to hold across the rename, besides the scores
// (intervalRenamePin.test.ts): an old config still configures the same run, a config that states
// one length under both names is refused, and an artifact written under either name reads the same.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../core/src/config.js";
import { buildSource } from "../core/src/runConfig.js";
import {
  intervalBlocksOf,
  intervalSeriesFields,
  intervalSeriesOf,
  isIntervalBoundaryEvent,
  type IntervalSeries,
} from "../core/src/intervalSeries.js";

function stderrOf(fn: () => void): string {
  const write = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = write;
  }
  return out;
}

const intervalBlocks = (run: Record<string, unknown>) =>
  loadConfig(buildSource({ run })).intervalBlocks;

test("run.intervalBlocks / run.intervalSeconds configure the interval", () => {
  assert.equal(intervalBlocks({}), 12, "the default is unchanged");
  assert.equal(intervalBlocks({ intervalBlocks: 30 }), 30);
  assert.equal(
    intervalBlocks({ intervalSeconds: 1800, blockTimeSec: 2 }),
    900,
    "seconds convert at the block time",
  );
});

test("the old names still configure the same interval, and say they are old", () => {
  let blocks = 0;
  const said = stderrOf(() => {
    blocks = intervalBlocks({ epochBlocks: 30 });
  });
  assert.equal(blocks, 30);
  assert.match(said, /run\.epochBlocks is now run\.intervalBlocks/);
  // The practice period's file, as it was when its coordinator started (#132).
  assert.equal(intervalBlocks({ epochSeconds: 1800, blockTimeSec: 2 }), 900);
  assert.equal(
    stderrOf(() => intervalBlocks({ intervalBlocks: 30 })),
    "",
    "the new name is silent",
  );
});

test("an agent process loads the same file and does not repeat the warning", () => {
  const before = process.env.ERIS_AGENT_ID;
  process.env.ERIS_AGENT_ID = "a";
  try {
    assert.equal(
      stderrOf(() => intervalBlocks({ epochBlocks: 30 })),
      "",
    );
  } finally {
    if (before === undefined) delete process.env.ERIS_AGENT_ID;
    else process.env.ERIS_AGENT_ID = before;
  }
});

test("one length under both names is refused, whichever pair", () => {
  stderrOf(() => {
    assert.throws(
      () => intervalBlocks({ intervalBlocks: 12, epochBlocks: 12 }),
      /run\.intervalBlocks and run\.epochBlocks both set/,
    );
    assert.throws(
      () =>
        intervalBlocks({
          intervalSeconds: 1800,
          epochSeconds: 1800,
          blockTimeSec: 2,
        }),
      /run\.intervalSeconds and run\.epochSeconds both set/,
    );
  });
});

test("seconds beside blocks is still refused, across the old and new names", () => {
  stderrOf(() => {
    for (const run of [
      { intervalSeconds: 1800, intervalBlocks: 12 },
      { intervalSeconds: 1800, epochBlocks: 12 },
      { epochSeconds: 1800, intervalBlocks: 12 },
      { epochSeconds: 1800, epochBlocks: 12 },
    ])
      assert.throws(
        () => intervalBlocks({ ...run, blockTimeSec: 2 }),
        /both set\. An interval has one length/,
      );
  });
});

const SERIES: IntervalSeries = {
  intervalBlocks: 12,
  intervals: 2,
  boundaryBlocks: [100, 112, 124],
  valuesByAgent: { a: [10, 11, null], b: [5, 6, 7] },
};

test("summary.json carries the series under both names, the old one in its old shape", () => {
  const fields = intervalSeriesFields(SERIES, {
    source: "live-interval-boundaries",
    boundaries: 3,
    failedBoundaries: 0,
    intervalBlocks: 12,
    markMedianBlocks: 5,
  });
  assert.deepEqual(fields.intervalSeries, SERIES);
  // What a dashboard or script built before the rename reads.
  assert.deepEqual(fields.epochSeries, {
    epochBlocks: 12,
    epochs: 2,
    boundaryBlocks: [100, 112, 124],
    valuesByAgent: { a: [10, 11, null], b: [5, 6, 7] },
  });
  assert.deepEqual(fields.epochSeriesMeta, {
    source: "live-epoch-boundaries",
    boundaries: 3,
    failedBoundaries: 0,
    epochBlocks: 12,
    markMedianBlocks: 5,
  });
  assert.equal(fields.intervalSeriesMeta?.intervalBlocks, 12);
});

test("the reader finds the series under either name, and the same series", () => {
  const both = intervalSeriesFields(SERIES);
  assert.deepEqual(intervalSeriesOf(both), SERIES);
  assert.deepEqual(
    intervalSeriesOf({ intervalSeries: both.intervalSeries }),
    SERIES,
  );
  assert.deepEqual(
    intervalSeriesOf({ epochSeries: both.epochSeries }),
    SERIES,
    "a summary written before the rename",
  );
  assert.equal(intervalSeriesOf({ source: "live-observation" }), undefined);
  assert.equal(intervalSeriesOf(undefined), undefined);
});

test("the interval length and the boundary event are read under either name", () => {
  assert.equal(
    intervalBlocksOf({ intervalBlocks: 900, epochBlocks: 900 }),
    900,
  );
  assert.equal(intervalBlocksOf({ epochBlocks: 12 }), 12);
  assert.equal(intervalBlocksOf({}), 0);
  assert.ok(isIntervalBoundaryEvent("interval_boundary"));
  assert.ok(isIntervalBoundaryEvent("epoch_boundary"));
  assert.ok(!isIntervalBoundaryEvent("interval_boundary_failed"));
});
