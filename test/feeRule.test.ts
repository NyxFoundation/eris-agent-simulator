import test from "node:test";
import assert from "node:assert/strict";
import { checkFeeRule, participantFees } from "../sdk/src/feeRule.js";

const GWEI = 1_000_000_000n;
const CAP = 5n * GWEI;

test("checkFeeRule: maxFeePerGas above the tip is a breach whatever the cap", () => {
  // The measured front-run: tip 0.1 gwei, maxFeePerGas 7 gwei, paid 0.1 gwei, ordered first.
  assert.deepEqual(
    checkFeeRule({ maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: GWEI / 10n }, CAP),
    {
      kind: "max-fee-above-tip",
      maxFeePerGasWei: 7n * GWEI,
      maxPriorityFeePerGasWei: GWEI / 10n,
    },
  );
  // Also when the cap half is disabled (economic gas): that half retires, this one does not.
  assert.equal(
    checkFeeRule({ maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI }, 0n)?.kind,
    "max-fee-above-tip",
  );
});

test("checkFeeRule: equal fields pass up to the cap and breach above it", () => {
  assert.equal(checkFeeRule({ maxFeePerGas: CAP, maxPriorityFeePerGas: CAP }, CAP), null);
  assert.deepEqual(
    checkFeeRule({ maxFeePerGas: CAP + 1n, maxPriorityFeePerGas: CAP + 1n }, CAP),
    { kind: "over-cap", field: "maxPriorityFeePerGas", wei: CAP + 1n, capWei: CAP },
  );
  // maxFeePerGas below the tip is fine: the tx pays maxFeePerGas, which is also its order key.
  assert.equal(checkFeeRule({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 2n * GWEI }, CAP), null);
  // A tip above the cap is still over it, even with maxFeePerGas under it (the old check, kept).
  assert.equal(
    checkFeeRule({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 9n * GWEI }, CAP)?.kind,
    "over-cap",
  );
});

test("checkFeeRule: a legacy gasPrice is both the key and the price, so only the cap applies", () => {
  assert.equal(checkFeeRule({ gasPrice: 2n * GWEI }, CAP), null);
  assert.deepEqual(checkFeeRule({ gasPrice: 7n * GWEI }, CAP), {
    kind: "over-cap",
    field: "gasPrice",
    wei: 7n * GWEI,
    capWei: CAP,
  });
  assert.equal(checkFeeRule({ gasPrice: 7n * GWEI }, 0n), null);
});

test("participantFees: equal fields, baseFee + bid, clamped to the cap when one is given", () => {
  assert.deepEqual(participantFees(GWEI, 0n), { maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI });
  assert.deepEqual(participantFees(GWEI, 2n * GWEI), {
    maxFeePerGas: 3n * GWEI,
    maxPriorityFeePerGas: 3n * GWEI,
  });
  assert.deepEqual(participantFees(CAP, GWEI, CAP), { maxFeePerGas: CAP, maxPriorityFeePerGas: CAP });
  assert.deepEqual(participantFees(CAP, GWEI, 0n), {
    maxFeePerGas: CAP + GWEI,
    maxPriorityFeePerGas: CAP + GWEI,
  });
  for (const [bid, base] of [[0n, 0n], [GWEI, 0n], [CAP, 3n * GWEI]] as const)
    assert.equal(checkFeeRule(participantFees(bid, base, CAP), CAP), null);
});
