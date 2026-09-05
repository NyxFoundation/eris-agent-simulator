import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFeeViolations,
  countRevertedTxs,
  findUnloggedAgentTxs,
  readSubmittedHashes,
  reconcileRunAgentTxs,
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

test("findUnloggedAgentTxs: an included tx the agent never reported sending is flagged, per agent", () => {
  const found = findUnloggedAgentTxs(
    csv([
      // reported (hash case differs between the chain and the log; both are normalised)
      "10,100,1,0xAAA,0x111,1,success,arb,agent,swap,,",
      // not reported: the mark this check exists for
      "10,100,2,0xbbb,0x111,1,success,arb,agent,swap,,",
      // an external participant (no entry in the map): nothing to reconcile against, skipped
      "10,100,3,0xccc,0x222,1,success,ext,agent,direct,,",
      // environment txs are never the agent's
      "11,101,0,0xddd,0x333,1,success,oracle,system,oracleUpdate,,",
    ]),
    new Map([
      ["arb", new Set(["0xaaa"])],
      ["quiet", new Set<string>()],
    ]),
  );
  assert.deepEqual(found, [{ ownerId: "arb", hash: "0xbbb", blockNumber: 100 }]);
});

test("readSubmittedHashes: only `submitted` mempool entries count; a missing log is an empty set", () => {
  const runDir = mkdtempSync(join(tmpdir(), "eris-postrun-"));
  mkdirSync(join(runDir, "agents"));
  writeFileSync(
    join(runDir, "agents", "arb.jsonl"),
    [
      JSON.stringify({ kind: "mempool", event: "submitted", hash: "0xAAA", nonce: 1 }),
      JSON.stringify({ kind: "mempool", event: "submit_failed", error: "nonce too low" }),
      JSON.stringify({ kind: "mempool", event: "rejected", reason: "over cap" }),
      JSON.stringify({ round: 100, reason: "gap too small" }),
      "not json at all",
      JSON.stringify({ kind: "mempool", event: "submitted", hash: "0xbbb" }),
    ].join("\n") + "\n",
  );
  assert.deepEqual([...readSubmittedHashes(runDir, "arb")].sort(), ["0xaaa", "0xbbb"]);
  assert.deepEqual(readSubmittedHashes(runDir, "never-wrote"), new Set());
});

test("reconcileRunAgentTxs: an agent with no log at all has every included tx flagged; no blocks.csv means nothing to say", () => {
  const runDir = mkdtempSync(join(tmpdir(), "eris-postrun-"));
  assert.deepEqual(reconcileRunAgentTxs(runDir, ["arb"]), []);
  mkdirSync(join(runDir, "agents"));
  writeFileSync(
    join(runDir, "blocks.csv"),
    csv([
      "10,100,1,0xaaa,0x111,1,success,arb,agent,swap,,",
      "10,100,2,0xbbb,0x111,1,reverted,arb,agent,swap,,",
      "10,100,3,0xccc,0x222,1,success,ext,agent,direct,,",
    ]) + "\n",
  );
  assert.deepEqual(reconcileRunAgentTxs(runDir, ["arb"]), [
    { ownerId: "arb", hash: "0xaaa", blockNumber: 100 },
    { ownerId: "arb", hash: "0xbbb", blockNumber: 100 },
  ]);
});
