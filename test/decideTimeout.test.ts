// The per-decision bound of rules §2.3, as bot.ts applies it to every decide().
import test from "node:test";
import assert from "node:assert/strict";
import {
  DECIDE_TIMEOUT_MS,
  DecideTimeoutError,
  withDecideTimeout,
} from "../example/agents/runtime/decideTimeout.js";

test("the bound is the rules' 5,000 ms", () => {
  assert.equal(DECIDE_TIMEOUT_MS, 5000);
});

test("a decide() that awaits forever is cut off with a timeout error naming the block", async () => {
  const never = new Promise<never>(() => {});
  await assert.rejects(
    () => withDecideTimeout(never, 123, 30),
    (error: unknown) =>
      error instanceof DecideTimeoutError && /block 123 is no action/.test(error.message),
  );
});

test("a decide() that answers in time passes its action through, promise or plain value", async () => {
  assert.deepEqual(
    await withDecideTimeout(Promise.resolve({ type: "noop" }), 1, 1000),
    { type: "noop" },
  );
  assert.equal(await withDecideTimeout(null, 1, 1000), null);
});

test("a decide() that rejects in time surfaces its own error, not a timeout", async () => {
  await assert.rejects(
    () => withDecideTimeout(Promise.reject(new Error("strategy bug")), 1, 1000),
    /strategy bug/,
  );
});

test("the timer is cleared on the way out (no dangling handle keeps the process alive)", async () => {
  // If the timer were left armed, node --test would report the handle; a passing run is the assertion.
  await withDecideTimeout(Promise.resolve(1), 1, 60_000);
});
