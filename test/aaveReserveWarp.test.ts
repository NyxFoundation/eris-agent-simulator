// The Aave setup warp exists for one hazard: a reserve's lastUpdateTimestamp ahead of the clock,
// which underflows `block.timestamp - lastUpdate` (panic 0x11). A reserve updated in the current
// second is not that hazard (Aave returns early on dt == 0), and warping on it moved the practice
// chain an hour forward on a coordinator restart.
import test from "node:test";
import assert from "node:assert/strict";
import { aaveReserveWarpSeconds } from "../sdk/src/protocols/aave.js";

test("a reserve updated in the current second does not move the clock", () => {
  assert.equal(aaveReserveWarpSeconds(1_000n, 1_000n), 0);
});

test("a clock already past every reserve is left alone", () => {
  assert.equal(aaveReserveWarpSeconds(1_000n, 1_001n), 0);
});

test("a reserve ahead of the clock is warped past, with the buffer", () => {
  assert.equal(aaveReserveWarpSeconds(1_000n, 400n), 600 + 3600);
});
