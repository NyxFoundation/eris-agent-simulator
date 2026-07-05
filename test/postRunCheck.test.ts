import test from "node:test";
import assert from "node:assert/strict";
import { checkFeeViolations } from "../core/src/postRunCheck.js";

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
