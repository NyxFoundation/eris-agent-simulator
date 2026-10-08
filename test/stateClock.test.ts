// Issue #263: a dump deployed on a warped clock, loaded into a node whose next block is on wall
// clock. The alignment reads the head, mines one block to see where the clock really is, and
// moves it up to the head only when it fell behind.
import test from "node:test";
import assert from "node:assert/strict";
import { alignClockToState, clockShortfall, STATE_CLOCK_EVENT } from "../core/src/realtime/stateClock.js";

function node(timestamps: bigint[]) {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  let i = 0;
  const client = {
    getBlock: async () => ({ timestamp: timestamps[Math.min(i, timestamps.length - 1)] }),
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params });
      if (method === "anvil_mine" || method === "evm_mine") i++;
      return null;
    },
  };
  const events: Record<string, unknown>[] = [];
  const logger = { event: (e: Record<string, unknown>) => events.push(e) };
  // biome-ignore lint/suspicious/noExplicitAny: stubs for the two things the alignment touches
  return { client: client as any, logger: logger as any, calls, events };
}

test("the shortfall is the head minus the next block, never negative", () => {
  assert.equal(clockShortfall(1_000n, 400n), 600);
  assert.equal(clockShortfall(1_000n, 1_000n), 0);
  assert.equal(clockShortfall(1_000n, 5_000n), 0);
});

test("a node behind the state's head is moved up to it, once, and the run records it", async () => {
  // head at 1000; the probe block lands at 400 (wall clock); after the warp the next block is 1001.
  const n = node([1_000n, 400n, 1_001n]);
  const report = await alignClockToState(n.client, n.logger);
  assert.deepEqual(report, { stateHeadUnix: 1000, probeUnix: 400, toUnix: 1001, warpedSeconds: 601 });
  const methods = n.calls.map((c) => c.method);
  assert.deepEqual(methods, ["anvil_mine", "evm_increaseTime", "anvil_mine"]);
  assert.deepEqual(n.calls[1].params, ["0x259"], "601 seconds, hex-encoded as the cheatcode takes it");
  assert.equal(n.events.length, 1);
  assert.equal(n.events[0].type, STATE_CLOCK_EVENT);
});

test("a node already past the head mines its probe block and warps nothing", async () => {
  const n = node([1_000n, 1_002n]);
  assert.equal(await alignClockToState(n.client, n.logger), undefined);
  assert.deepEqual(n.calls.map((c) => c.method), ["anvil_mine"]);
  assert.deepEqual(n.events, []);
});
