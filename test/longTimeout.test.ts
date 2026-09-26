// The practice period's run.seconds ceiling (42 days) is past setTimeout's 32-bit limit, which Node
// replaces with 1 ms: a run without stress events (so with its time limit on) ended before its
// first block. setLongTimeout chains timers up to the deadline instead.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { MAX_TIMEOUT_MS, setLongTimeout } from "../core/src/realtime/longTimeout.js";

const DAY = 86_400_000;

test("a 42-day timer fires after 42 days, not after 1 ms", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let fired = 0;
    setLongTimeout(() => fired++, 42 * DAY);
    mock.timers.tick(1);
    assert.equal(fired, 0, "not the overflowed 1 ms");
    mock.timers.tick(MAX_TIMEOUT_MS);
    assert.equal(fired, 0, "not at the first link of the chain");
    mock.timers.tick(42 * DAY - MAX_TIMEOUT_MS - 2);
    assert.equal(fired, 0, "not a millisecond early");
    mock.timers.tick(1);
    assert.equal(fired, 1);
    mock.timers.tick(10 * DAY);
    assert.equal(fired, 1, "once");
  } finally {
    mock.timers.reset();
  }
});

test("a short timer behaves like setTimeout, and cancel stops a chained one", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    let fired = 0;
    setLongTimeout(() => fired++, 1_000);
    mock.timers.tick(1_000);
    assert.equal(fired, 1);
    const cancel = setLongTimeout(() => fired++, 30 * DAY);
    mock.timers.tick(MAX_TIMEOUT_MS + 5);
    cancel();
    mock.timers.tick(30 * DAY);
    assert.equal(fired, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a non-positive delay is refused rather than fired at once", () => {
  assert.throws(() => setLongTimeout(() => {}, 0), /positive/);
});
