import test from "node:test";
import assert from "node:assert/strict";
import { closeCrashedSegment } from "../core/src/segmentRecovery.js";

const identity = (id: string) => ({
  id,
  address: `0x${id}`,
  baseline: false,
  includedTxCount: 0,
  revertCount: 0,
});

test("a segment closed after the coordinator died reads like one the roll closed", () => {
  const { summary, records, indexAgents, toBlock } = closeCrashedSegment({
    runId: "period/segment-2",
    segment: 2,
    fromBlock: 25,
    intervalBlocks: 10,
    mode: "realtime",
    resetUnit: "continuous",
    blockTimeSec: 2,
    previous: {
      boundaryBlocks: [10, 20],
      valuesByAgent: { a: [100, 110], b: [50, 55] },
    },
    lines: [
      { blockNumber: 30, fairPriceUsdcPerWeth: 3000, values: { a: 120, b: 60 } },
      { blockNumber: 40, fairPriceUsdcPerWeth: 3010, values: { a: 130, c: 70 } },
    ],
    identities: [identity("a"), identity("b"), identity("c")],
    note: "test",
  });
  assert.equal(toBlock, 40);
  // Boundary 0 is the previous segment's last one, as the roll carries it.
  const series = (summary.valueSeries as { intervalSeries: { boundaryBlocks: number[] } })
    .intervalSeries;
  assert.deepEqual(series.boundaryBlocks, [20, 30, 40]);
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  assert.equal(byId.a.scored && byId.a.pnlUsdc, 20);
  // A final boundary that did not report falls back to the last that did (rules §4.4.2).
  assert.equal(byId.b.scored && byId.b.pnlUsdc, 5);
  // Registered during the day: no V_0, no P -- recorded as unscored, not as 0.
  assert.equal(byId.c.scored, false);
  assert.equal(indexAgents.find((a) => a.id === "c")?.scored, false);
  assert.equal(summary.finalFairPriceUsdcPerWeth, 3010);
});
