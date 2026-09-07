// Anvil flushes the block-production backlog automine left behind the moment the mining mode
// changes: a burst of empty blocks milliseconds apart, right after setIntervalMining (measured
// 2026-09-07: 71 on the depeg roster, 260 after an evm_revert). The coordinator waits for the chain
// to go quiet before it takes the next block as runStartBlock, and these tests pin down what "quiet"
// means against a scripted chain: the flush is recognised and counted, the interval miner's own
// block is not mistaken for it, and a chain that never settles is reported rather than waited on
// forever.
import test from "node:test";
import assert from "node:assert/strict";
import { waitForMiningToSettle } from "../sdk/src/chain.js";

// A chain scripted as (time ms → block number) steps, driven by a fake clock the helper advances
// through its own sleep. The helper's reads see the block number the script has reached.
function scriptedChain(steps: Array<[atMs: number, block: number]>) {
  let t = 0;
  const blockAt = (): number => {
    let b = steps[0][1];
    for (const [at, block] of steps) if (at <= t) b = block;
    return b;
  };
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    getBlockNumber: async () => blockAt(),
  };
}

test("a burst of empty blocks is waited out and counted as the flush", async () => {
  // 70 blocks over 700 ms (10 ms apart), then nothing.
  const steps: Array<[number, number]> = [[0, 1053]];
  for (let i = 1; i <= 70; i++) steps.push([i * 10, 1053 + i]);
  const chain = scriptedChain(steps);
  const r = await waitForMiningToSettle(chain.getBlockNumber, {
    quietMs: 500,
    maxWaitMs: 60_000,
    pollMs: 50,
    now: chain.now,
    sleep: chain.sleep,
  });
  assert.equal(r.settled, true);
  assert.equal(r.startBlock, 1053);
  assert.equal(r.endBlock, 1123);
  assert.equal(r.blocksMined, 70);
  assert.equal(r.burstBlocks, 70);
  // Quiet from t=700; recognised at the first poll ≥ 500 ms later.
  assert.ok(r.waitedMs >= 1200 && r.waitedMs < 1300, `waited ${r.waitedMs}`);
});

test("a chain with no backlog settles after one quiet gap and reports no flush", async () => {
  const chain = scriptedChain([[0, 1217]]);
  const r = await waitForMiningToSettle(chain.getBlockNumber, {
    quietMs: 500,
    maxWaitMs: 60_000,
    pollMs: 50,
    now: chain.now,
    sleep: chain.sleep,
  });
  assert.equal(r.settled, true);
  assert.equal(r.blocksMined, 0);
  assert.equal(r.burstBlocks, 0);
  assert.equal(r.waitedMs, 500);
});

test("the interval miner's own block is not counted as the flush", async () => {
  // A 5-block flush in the first 50 ms, then the 2 s interval block at t=2000.
  const chain = scriptedChain([
    [0, 100],
    [10, 103],
    [40, 105],
    [2000, 106],
  ]);
  const r = await waitForMiningToSettle(chain.getBlockNumber, {
    quietMs: 500,
    maxWaitMs: 60_000,
    pollMs: 50,
    now: chain.now,
    sleep: chain.sleep,
  });
  assert.equal(r.settled, true);
  assert.equal(r.burstBlocks, 5);
  // The flush ended at t=40; quiet by t=550 -- before the interval block, which is not waited for.
  assert.equal(r.endBlock, 105);
  assert.equal(r.blocksMined, 5);
});

test("a chain that never goes quiet is reported, not waited on forever", async () => {
  // One block every 100 ms, indefinitely.
  const steps: Array<[number, number]> = [];
  for (let i = 0; i <= 2000; i++) steps.push([i * 100, i]);
  const chain = scriptedChain(steps);
  const r = await waitForMiningToSettle(chain.getBlockNumber, {
    quietMs: 500,
    maxWaitMs: 10_000,
    pollMs: 50,
    now: chain.now,
    sleep: chain.sleep,
  });
  assert.equal(r.settled, false);
  assert.ok(
    r.waitedMs >= 10_000 && r.waitedMs < 10_100,
    `waited ${r.waitedMs}`,
  );
  assert.equal(r.burstBlocks, r.blocksMined);
  assert.ok(r.blocksMined >= 99, `mined ${r.blocksMined}`);
});
