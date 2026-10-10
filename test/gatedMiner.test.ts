import assert from "node:assert/strict";
import test from "node:test";
import { GatedMiner } from "../core/src/realtime/gatedMiner.js";

// ADR 0011 §5-3/4: under economicGas the environment mines, and only once the next block's prices
// are staged. A fake clock: sleep advances it, so the schedule is exact and the test is instant.

function harness(
  opts: {
    blockTimeMs?: number;
    gateTimeoutMs?: number;
    // Throw on these mine calls (1-based), to stand in for an RPC failure.
    failMines?: Set<number>;
    // Stage the start head before the miner starts, as the first pass does. Off to test the wait.
    primed?: boolean;
    // A chain head that moved without the miner (a mine that landed after its timeout, a resume).
    chainHead?: () => number;
  } = {},
) {
  let t = 0;
  const log: string[] = [];
  let head = 100;
  let calls = 0;
  const timeouts: Array<{ head: number; stagedFor: number }> = [];
  const errors: string[] = [];
  let onMine: (head: number) => void = () => {};
  const miner = new GatedMiner({
    blockTimeMs: opts.blockTimeMs ?? 2_000,
    gateTimeoutMs: opts.gateTimeoutMs ?? 6_000,
    startHead: head,
    now: () => t,
    // A macrotask, so the test's own polling runs between the miner's steps.
    sleep: async (ms) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    mine: async () => {
      calls++;
      if (opts.failMines?.has(calls)) throw new Error(`rpc down (call ${calls})`);
      head++;
      log.push(`mine ${head} @${t}`);
      onMine(head);
      return head;
    },
    onGateTimeout: (info) => timeouts.push(info),
    onMineError: ({ error }) => errors.push(String(error)),
    ...(opts.chainHead
      ? { readHead: async () => Math.max(head, opts.chainHead!()) }
      : {}),
  });
  if (opts.primed !== false) miner.stage(100, async () => {});
  return {
    miner,
    log,
    errors,
    timeouts,
    now: () => t,
    onMine: (f: (head: number) => void) => (onMine = f),
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100_000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), "condition never held");
}

test("applies the staged writes, then mines, one block time apart", async () => {
  const h = harness();
  // A pass that stages instantly for every block it sees.
  h.onMine((head) =>
    h.miner.stage(head, async () => {
      h.log.push(`write for ${head}`);
    }),
  );
  h.miner.stage(100, async () => {
    h.log.push("write for 100");
  });
  h.miner.start();
  await until(() => h.log.filter((l) => l.startsWith("mine")).length >= 3);
  await h.miner.stop();
  assert.deepEqual(h.log.slice(0, 6), [
    "write for 100",
    "mine 101 @2000",
    "write for 101",
    "mine 102 @4000",
    "write for 102",
    "mine 103 @6000",
  ]);
  assert.equal(h.timeouts.length, 0);
});

test("waits for the head block's prices before mining", async () => {
  const h = harness();
  h.miner.start();
  // Block 101 is mined on setup's prices; nothing is staged for it until t = 5,000.
  await until(() => h.log.length === 1);
  assert.equal(h.log[0], "mine 101 @2000");
  await until(() => h.now() >= 5_000);
  assert.equal(h.log.length, 1, "no block while the pass has not staged");
  h.miner.stage(101, async () => {
    h.log.push("write for 101");
  });
  await until(() => h.log.length === 3);
  await h.miner.stop();
  assert.equal(h.log[1], "write for 101");
  assert.match(h.log[2], /^mine 102 @/);
  assert.equal(h.timeouts.length, 0);
});

test("a pass that never stages does not stop the chain", async () => {
  const h = harness({ gateTimeoutMs: 6_000 });
  h.miner.start();
  await until(() => h.log.length === 3);
  await h.miner.stop();
  // 101 at 2,000; 102 waited the full gate from 4,000 and was mined on the old prices; 103 is
  // behind schedule (6,000) and comes half a block after 102, catching up.
  assert.equal(h.log[0], "mine 101 @2000");
  assert.equal(h.log[1], "mine 102 @10000");
  assert.match(h.log[2], /^mine 103 @1[67]\d{3}$/);
  assert.deepEqual(
    h.timeouts.map(({ head, stagedFor }) => ({ head, stagedFor })),
    [
      { head: 101, stagedFor: 100 },
      { head: 102, stagedFor: 100 },
    ],
  );
  assert.equal(h.miner.stats().gateTimeouts, 2);
});

test("a stage that arrives late is applied once, and an older one never replaces it", async () => {
  const h = harness();
  let applied = 0;
  h.miner.stage(100, async () => {
    applied++;
  });
  h.miner.stage(99, async () => {
    throw new Error("stale stage applied");
  });
  h.miner.start();
  await until(() => h.log.length === 1);
  await h.miner.stop();
  assert.equal(applied, 1);
});

test("stop applies a stage the loop did not get to, without mining", async () => {
  const h = harness();
  h.miner.start();
  await until(() => h.log.length === 1);
  // The final pass stages, and the run ends before the next tick.
  h.miner.stage(101, async () => {
    h.log.push("write for 101");
  });
  await h.miner.stop();
  assert.deepEqual(h.log, ["mine 101 @2000", "write for 101"]);
});

test("a failed mine is reported and retried, and the loop keeps going", async () => {
  const h = harness({ failMines: new Set([2]) });
  h.onMine((head) => h.miner.stage(head, async () => {}));
  h.miner.start();
  await until(() => h.log.length === 3);
  await h.miner.stop();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /rpc down \(call 2\)/);
  assert.deepEqual(
    h.log.map((l) => l.split(" @")[0]),
    ["mine 101", "mine 102", "mine 103"],
  );
});

test("a slow stretch is caught up at half-block spacing, then the grid holds", async () => {
  const h = harness();
  let slow = true;
  // The pass for 101 takes 5 s to stage; every other pass stages at once.
  h.onMine((head) => {
    if (head === 101 && slow) {
      slow = false;
      return;
    }
    h.miner.stage(head, async () => {});
  });
  h.miner.start();
  await until(() => h.log.length >= 1);
  await until(() => h.now() >= 7_000);
  h.miner.stage(101, async () => {});
  await until(() => h.log.length >= 6);
  await h.miner.stop();
  const at = h.log.map((l) => Number(l.split("@")[1]));
  // 102 was due at 4,000 and went at ~7,000; the next ones come 1 s apart until back on the 2 s grid.
  assert.ok(at[1] >= 7_000 && at[1] < 7_100, `${at[1]}`);
  assert.ok(at[2] - at[1] >= 1_000 && at[2] - at[1] < 1_100, `${at[2] - at[1]}`);
  assert.equal(at[5] % 2_000, 0, `back on the grid: ${at}`);
});

test("halt stops mining at once; stop still flushes the last stage", async () => {
  const h = harness();
  h.miner.start();
  await until(() => h.log.length === 1);
  h.miner.halt();
  h.miner.stage(101, async () => {
    h.log.push("write for 101");
  });
  await h.miner.stop();
  assert.deepEqual(h.log, ["mine 101 @2000", "write for 101"]);
});

test("the first block waits for the first pass, like every other", async () => {
  const h = harness({ primed: false });
  h.miner.start();
  await until(() => h.now() >= 3_000);
  assert.equal(h.log.length, 0, "no block before the first pass staged");
  h.miner.stage(100, async () => {
    h.log.push("write for 100");
  });
  await until(() => h.log.length === 2);
  await h.miner.stop();
  assert.equal(h.log[0], "write for 100");
  assert.match(h.log[1], /^mine 101 @/);
  assert.equal(h.timeouts.length, 0);
});

test("a head that moved without the miner is gated on, not skipped", async () => {
  // The chain is at 105 (say a mine that timed out here landed anyway); the miner thought 100.
  const h = harness({ chainHead: () => 105 });
  h.miner.start();
  await until(() => h.now() >= 3_000);
  assert.equal(h.log.length, 0, "105's prices are not staged, so nothing is mined");
  h.miner.stage(105, async () => {});
  await until(() => h.log.length === 1);
  await h.miner.stop();
});

test("a price set that cannot be written holds the block, and the chain goes on after three ticks", async () => {
  const h = harness();
  let attempts = 0;
  // Every apply of this stage fails: the first two ticks hold the block, the third mines anyway.
  h.miner.stage(100, async () => {
    attempts++;
    throw new Error("node refused the write");
  });
  const held: Array<{ heldTicks: number; minedAnyway: boolean }> = [];
  (h.miner as unknown as { opts: { onApplyHeld: (i: { heldTicks: number; minedAnyway: boolean }) => void } }).opts.onApplyHeld =
    (i) => held.push({ heldTicks: i.heldTicks, minedAnyway: i.minedAnyway });
  h.miner.start();
  await until(() => h.log.length === 1);
  await h.miner.stop();
  assert.deepEqual(held, [
    { heldTicks: 1, minedAnyway: false },
    { heldTicks: 2, minedAnyway: false },
    { heldTicks: 3, minedAnyway: true },
  ]);
  assert.equal(attempts, 6, "each tick tries twice");
  assert.equal(h.miner.stats().held, 2);
});

test("a stage with a commit writes and mines in one call; a failed commit falls back to two", async () => {
  let t = 0;
  let head = 100;
  const log: string[] = [];
  const miner: GatedMiner = new GatedMiner({
    blockTimeMs: 2_000,
    gateTimeoutMs: 6_000,
    startHead: head,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    mine: async () => {
      head++;
      log.push(`mine ${head}`);
      return head;
    },
    // The pass for each new head stages at once: 101's commit fails, so it goes in two steps.
    onMined: (h) => {
      if (h === 101)
        miner.stage(
          101,
          async () => {
            log.push("apply 101");
          },
          async () => {
            throw new Error("batch refused");
          },
        );
    },
  });
  miner.stage(
    100,
    async () => {
      log.push("apply 100 (unused)");
    },
    async () => {
      head++;
      log.push(`commit 100 -> ${head}`);
      return head;
    },
  );
  miner.start();
  await until(() => log.includes("mine 102"));
  await miner.stop();
  assert.deepEqual(log, ["commit 100 -> 101", "apply 101", "mine 102"]);
  assert.equal(miner.stats().mined, 2);
});

test("a commit that reports the head from before its mine still moves the miner on, and gates the next block", async () => {
  // anvil answers a batch's members concurrently: an eth_blockNumber read in the commit's batch came
  // back with the pre-mine number (PR #287 review). The miner must still count the block, report the
  // new head, and not mine another one until a new stage arrives -- even with no head read to fix it.
  let t = 0;
  let chain = 100;
  const mined: number[] = [];
  const timeouts: number[] = [];
  const miner: GatedMiner = new GatedMiner({
    blockTimeMs: 2_000,
    gateTimeoutMs: 6_000,
    startHead: chain,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    mine: async () => {
      chain++;
      return chain;
    },
    onMined: (h) => mined.push(h),
    onGateTimeout: (info) => timeouts.push(info.head),
  });
  miner.stage(
    100,
    async () => {},
    async () => {
      const before = chain;
      chain++;
      return before; // the stale answer
    },
  );
  miner.start();
  await until(() => mined.length === 1);
  assert.deepEqual(mined, [101], "onMined gets the block the commit mined");
  // No stage for 101: the next tick waits the whole gate rather than mining on no new prices.
  await until(() => t >= 7_000);
  assert.equal(chain, 101, "nothing mined while 101's prices are missing");
  await until(() => timeouts.length === 1);
  await miner.stop();
  assert.deepEqual(timeouts, [101]);
});
