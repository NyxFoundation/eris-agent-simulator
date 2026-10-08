// Issue #275: when the runtime notices a block decides which of two equal 5 gwei bids goes first.
//
// The old watcher polled every blockTime/4 = 500 ms, so each agent noticed blocks a fixed 0-500 ms
// late for the whole epoch, set by when its process started. These tests run the watcher against a
// simulated chain on a virtual clock: after a few blocks it notices within one dense interval plus
// the round trip, whatever it started at, and it never notices later than the old poll would have.
import test from "node:test";
import assert from "node:assert/strict";
import {
  blockWatchTiming,
  nextPollDelayMs,
  watchBlocks,
} from "../example/agents/runtime/blockWatch.js";

const timing = blockWatchTiming(2_000);

test("blockWatchTiming keeps the old interval as the coarse poll", () => {
  assert.equal(timing.coarseMs, 500);
  assert.equal(blockWatchTiming(400).coarseMs, 100);
});

test("nextPollDelayMs: coarse until the window, dense inside it, coarse again when the block is late", () => {
  // Before the first block there is nothing to predict from.
  assert.equal(nextPollDelayMs(0, null, timing), 500);
  // Seen at 1,000: due at 3,000, the window is [2,850, 3,400).
  assert.equal(nextPollDelayMs(1_000, 1_000, timing), 500);
  // The last coarse wait is cut short so the window opens on time.
  assert.equal(nextPollDelayMs(2_600, 1_000, timing), 250);
  assert.equal(nextPollDelayMs(2_850, 1_000, timing), 25);
  assert.equal(nextPollDelayMs(3_399, 1_000, timing), 25);
  // Late past the window: back to the old interval, never a busy loop.
  assert.equal(nextPollDelayMs(3_400, 1_000, timing), 500);
});

type Run = {
  // Per block: how long after it was made the watcher noticed it.
  delays: Map<number, number>;
  polls: number;
};

/// Drive the watcher on a virtual clock against a chain that makes block k at phase + k * 2,000 ms.
/// Each poll costs `rttMs` of virtual time.
async function simulate(opts: {
  startAt: number;
  phaseMs: number;
  rttMs: number;
  untilMs: number;
}): Promise<Run> {
  let t = opts.startAt;
  const made = (bn: number) => opts.phaseMs + bn * 2_000;
  const head = () => Math.floor((t - opts.phaseMs) / 2_000);
  const run: Run = { delays: new Map(), polls: 0 };
  await new Promise<void>((resolve) => {
    const stop = watchBlocks({
      timing,
      now: () => t,
      getBlockNumber: async () => {
        run.polls += 1;
        t += opts.rttMs;
        return BigInt(head());
      },
      onBlock: (bn) => run.delays.set(bn, t - made(bn)),
      sleep: async (ms) => {
        t += ms;
        if (t >= opts.untilMs) {
          stop();
          resolve();
        }
      },
    });
  });
  return run;
}

test("watchBlocks converges onto the chain's phase from any start, and never notices later than the old poll", async () => {
  for (const startAt of [0, 130, 260, 390, 499, 1_234, 1_999]) {
    const run = await simulate({ startAt, phaseMs: 0, rttMs: 4, untilMs: 60_000 });
    const blocks = [...run.delays.keys()].sort((a, b) => a - b);
    assert.ok(blocks.length >= 28, `start ${startAt}: saw ${blocks.length} blocks`);
    // The first block existed before the watcher started; its "delay" is the start time.
    for (const bn of blocks.slice(1)) {
      const delay = run.delays.get(bn)!;
      // The old watcher's worst case, plus one round trip.
      assert.ok(delay <= 500 + 4, `start ${startAt}, block ${bn}: ${delay} ms`);
      // After a few blocks: within one dense interval and one round trip.
      if (bn >= blocks[0] + 5)
        assert.ok(delay <= 25 + 4, `start ${startAt}, block ${bn}: ${delay} ms`);
    }
    // About ten requests a block (five a second), against two for the old poll.
    assert.ok(run.polls / blocks.length <= 12, `start ${startAt}: ${run.polls} polls`);
  }
});

test("watchBlocks: two agents started apart notice each block within one dense interval of each other", async () => {
  const a = await simulate({ startAt: 0, phaseMs: 700, rttMs: 4, untilMs: 40_000 });
  const b = await simulate({ startAt: 377, phaseMs: 700, rttMs: 4, untilMs: 40_000 });
  let compared = 0;
  for (const [bn, da] of a.delays) {
    const db = b.delays.get(bn);
    if (db === undefined || bn < 8) continue;
    assert.ok(Math.abs(da - db) <= 25, `block ${bn}: ${da} vs ${db} ms`);
    compared += 1;
  }
  assert.ok(compared >= 10);
});

test("watchBlocks keeps polling at the old interval when blocks stop coming", async () => {
  // One block at 0 and then nothing until 10 s: a stalled chain must not be polled every 25 ms.
  let t = 0;
  let polls = 0;
  await new Promise<void>((resolve) => {
    const stop = watchBlocks({
      timing,
      now: () => t,
      getBlockNumber: async () => {
        polls += 1;
        return 1n;
      },
      onBlock: () => {},
      sleep: async (ms) => {
        t += ms;
        if (t >= 10_000) {
          stop();
          resolve();
        }
      },
    });
  });
  // Window [1,850, 2,400) at 25 ms is ~22 polls; the rest of the 10 s at 500 ms is ~16 more.
  assert.ok(polls <= 45, `${polls} polls`);
});

test("watchBlocks reports a failing poll and keeps going", async () => {
  let t = 0;
  let calls = 0;
  const errors: unknown[] = [];
  const seen: number[] = [];
  await new Promise<void>((resolve) => {
    const stop = watchBlocks({
      timing,
      now: () => t,
      getBlockNumber: async () => {
        calls += 1;
        if (calls === 2) throw new Error("socket hang up");
        return BigInt(Math.floor(t / 2_000));
      },
      onBlock: (bn) => seen.push(bn),
      onError: (error) => errors.push(error),
      sleep: async (ms) => {
        t += ms;
        if (t >= 6_500) {
          stop();
          resolve();
        }
      },
    });
  });
  assert.equal(errors.length, 1);
  assert.deepEqual(seen, [0, 1, 2, 3]);
});
