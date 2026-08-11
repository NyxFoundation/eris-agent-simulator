import test from "node:test";
import assert from "node:assert/strict";
import {
  checkFeeViolations,
  countRevertedTxs,
} from "../core/src/postRunCheck.js";

const HEADER =
  "round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex";

function csv(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

const MAX = 5_000_000_000n; // 5 gwei

test("checkFeeViolations: detects only agent txs that exceed the cap", () => {
  const violations = checkFeeViolations(
    csv([
      "10,100,1,0xaaa,0x111,5000000000,success,arb,agent,swap,,",
      "10,100,2,0xbbb,0x222,5000000001,success,cheater,agent,direct,,",
      "11,101,0,0xccc,0x333,6000000000,success,oracle,system,oracleUpdate,,",
    ]),
    MAX,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].ownerId, "cheater");
  assert.equal(violations[0].hash, "0xbbb");
  assert.equal(violations[0].blockNumber, 100);
  assert.equal(violations[0].priorityFeeWei, "5000000001");
});

test("checkFeeViolations: exactly at the cap is not a violation, empty CSV is an empty array", () => {
  assert.deepEqual(
    checkFeeViolations(
      csv(["1,1,0,0x1,0x1,5000000000,success,a,agent,swap,,"]),
      MAX,
    ),
    [],
  );
  assert.deepEqual(checkFeeViolations(`${HEADER}\n`, MAX), []);
});

test("checkFeeViolations: skips rows with an invalid fee value", () => {
  assert.deepEqual(
    checkFeeViolations(
      csv(["1,1,0,0x1,0x1,notanumber,success,a,agent,swap,,"]),
      MAX,
    ),
    [],
  );
});

// A reverted environment shock must be visible (ADR 0017 regime 3).
//
// A whale order goes out through the ordinary flow relay, which catches *submission* errors. An
// on-chain revert is not one: the tx lands, the schedule logs that the whale fired, and only
// blocks.csv records that it did nothing. A missing token approval once turned the whale regime
// into calm for a whole run with every other log looking healthy.
test("countRevertedTxs: separates reverted from executed for one owner", () => {
  const rows = csv([
    "1,100,7,0xaaa,0xw,100000000,reverted,flow-whale:uninformed,uninformed-flow,swap,,",
    "2,101,7,0xbbb,0xw,100000000,success,flow-whale:uninformed,uninformed-flow,balancerSwap,,",
    "3,102,7,0xccc,0xw,100000000,reverted,flow-whale:uninformed,uninformed-flow,curveSwap,,",
    // another owner's revert must not be counted
    "4,103,1,0xddd,0xa,100000000,reverted,arb,agent,swap,,",
  ]);
  assert.deepEqual(countRevertedTxs(rows, "flow-whale:uninformed"), {
    total: 3,
    reverted: 2,
  });
});

test("countRevertedTxs: an owner with no txs is zero, not an error", () => {
  // The whale wallet exists only when the schedule has a whale; asking about it otherwise is normal.
  assert.deepEqual(countRevertedTxs(csv([]), "flow-whale:uninformed"), {
    total: 0,
    reverted: 0,
  });
});
