import test from "node:test";
import assert from "node:assert/strict";
import { GMX_KEEPER_EXECUTE_GAS } from "../sdk/src/protocols/gmx.js";

// Issue #216 (2). The keeper declares this on every executeOrder, at a fee above the participant
// cap, so what it declares is what the block loses before any participant is placed. The numbers
// here are the measurement the constant was set from (blocks.csv `gasUsed`, 49,498 keeper
// transactions over 35 runs) and GMX's own gas reservations; a change to the constant has to be
// re-measured, not just re-typed.
const MEASURED_MAX_GAS_USED = 2_788_217n;
// GasUtils: the fill runs with declared - minHandleExecutionErrorGasToForward (1M); the general
// profile also wants increaseOrderGasLimit (3.9M) + minAdditionalGasForExecution (1M) up front.
const ERROR_HANDLING_RESERVE = 1_000_000n;
const GENERAL_PROFILE_FLOOR = 3_900_000n + 1_000_000n;
// sdk/src/config.ts `blockGasLimit` default = rules §2.6.
const BLOCK_GAS_LIMIT = 30_000_000n;

test("keeper gas covers the largest measured fill with the error-handling reserve on top", () => {
  assert.ok(
    GMX_KEEPER_EXECUTE_GAS >= MEASURED_MAX_GAS_USED + ERROR_HANDLING_RESERVE,
    `${GMX_KEEPER_EXECUTE_GAS} < ${MEASURED_MAX_GAS_USED} + ${ERROR_HANDLING_RESERVE}`,
  );
  assert.ok(GMX_KEEPER_EXECUTE_GAS >= GENERAL_PROFILE_FLOOR + 100_000n);
});

test("two keeper orders leave at least half the block to participants", () => {
  assert.ok(GMX_KEEPER_EXECUTE_GAS * 2n <= BLOCK_GAS_LIMIT / 2n);
});
