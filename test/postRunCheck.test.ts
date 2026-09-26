import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKS_CSV_COLUMNS,
  BLOCKS_CSV_INDEX,
  RunLogger,
  txFeeColumns,
} from "../core/src/logger.js";
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

// The maxFeePerGas half of the fee rule (sdk/src/feeRule.ts). anvil orders the block on
// maxFeePerGas while at base fee 0 the tx pays only the tip; measured 2026-09-27, a tx with tip
// 0.1 gwei and maxFeePerGas 7 gwei landed at txIndex 0 ahead of a 6/6 gwei tx shaped like the
// oracle update. With only priorityFeeWei recorded that tx looked like the cheapest in the block.
const HEADER_WITH_MAX_FEE = BLOCKS_CSV_COLUMNS.join(",");
// round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex,method,gasUsed,maxFeePerGasWei
function row(fee: string, maxFee: string, owner = "cheater", role = "agent"): string {
  return `10,100,0,0x${owner},0x111,${fee},success,${owner},${role},direct,,,,21000,${maxFee}`;
}

test("checkFeeViolations: maxFeePerGas above the tip is a violation even under the cap", () => {
  const violations = checkFeeViolations(
    [
      HEADER_WITH_MAX_FEE,
      row("100000000", "7000000000"), // the measured front-run: paid 0.1 gwei, ordered at 7
      row("1000000000", "1000000000", "honest"), // maxFee = tip
      row("2000000000", "1000000000", "under"), // maxFee below the tip pays maxFee: fine
      row("6000000000", "6000000000", "oracle", "system"), // the environment is not checked
    ].join("\n"),
    MAX,
  );
  assert.deepEqual(violations, [
    {
      ownerId: "cheater",
      hash: "0xcheater",
      blockNumber: 100,
      priorityFeeWei: "100000000",
      maxPriorityFeeWei: MAX.toString(),
      kind: "max-fee-above-tip",
      maxFeePerGasWei: "7000000000",
    },
  ]);
});

test("checkFeeViolations: a cap of 0 (economic gas) retires the cap half, not the maxFeePerGas half", () => {
  const csvText = [
    HEADER_WITH_MAX_FEE,
    row("9000000000", "9000000000", "bidder"),
    row("100000000", "7000000000"),
  ].join("\n");
  assert.deepEqual(
    checkFeeViolations(csvText, 0n).map((v) => [v.ownerId, v.kind]),
    [["cheater", "max-fee-above-tip"]],
  );
  assert.deepEqual(
    checkFeeViolations(csvText, MAX).map((v) => [v.ownerId, v.kind]),
    [
      ["bidder", "over-cap"],
      ["cheater", "max-fee-above-tip"],
    ],
  );
});

test("checkFeeViolations: a legacy tx records its gasPrice in both columns and is held to the cap", () => {
  // It used to record 0 (viem gives a legacy tx no maxPriorityFeePerGas), which exempted every
  // legacy transaction from the cap whatever its gasPrice.
  const legacy = txFeeColumns({ type: "legacy", gasPrice: 7_000_000_000n });
  assert.deepEqual(legacy, {
    priorityFeeWei: 7_000_000_000n,
    maxFeePerGasWei: 7_000_000_000n,
  });
  const violations = checkFeeViolations(
    [
      HEADER_WITH_MAX_FEE,
      row(legacy.priorityFeeWei.toString(), legacy.maxFeePerGasWei!.toString(), "legacy"),
    ].join("\n"),
    MAX,
  );
  assert.deepEqual(violations.map((v) => v.kind), ["over-cap"]);
});

test("txFeeColumns: typed txs record both on-chain fields; a tx with neither falls back", () => {
  assert.deepEqual(
    txFeeColumns({
      type: "eip1559",
      maxPriorityFeePerGas: 100_000_000n,
      maxFeePerGas: 7_000_000_000n,
      // viem fills gasPrice of a mined 1559 tx with the effective price; it must not be used
      gasPrice: 100_000_000n,
    }),
    { priorityFeeWei: 100_000_000n, maxFeePerGasWei: 7_000_000_000n },
  );
  assert.deepEqual(
    txFeeColumns({ type: "eip2930", gasPrice: 2_000_000_000n }),
    { priorityFeeWei: 2_000_000_000n, maxFeePerGasWei: 2_000_000_000n },
  );
  assert.deepEqual(txFeeColumns({}, 42n), { priorityFeeWei: 42n });
});

test("blocks.csv: maxFeePerGasWei is appended last, so every existing column keeps its index", () => {
  assert.equal(BLOCKS_CSV_INDEX.priorityFeeWei, 5);
  assert.equal(BLOCKS_CSV_INDEX.method, 12);
  assert.equal(BLOCKS_CSV_INDEX.gasUsed, 13);
  assert.equal(BLOCKS_CSV_INDEX.maxFeePerGasWei, BLOCKS_CSV_COLUMNS.length - 1);
  const root = mkdtempSync(join(tmpdir(), "eris-blocks-"));
  const logger = new RunLogger(root, "run");
  logger.blockRow({
    round: 7,
    blockNumber: 7n,
    txIndex: 0,
    hash: "0xabc",
    from: "0x111",
    status: "success",
    ownerId: "cheater",
    role: "agent",
    gasUsed: 21_000n,
    ...txFeeColumns({
      type: "eip1559",
      maxPriorityFeePerGas: 100_000_000n,
      maxFeePerGas: 7_000_000_000n,
    }),
  });
  const text = readFileSync(join(logger.runDir, "blocks.csv"), "utf8");
  const [header, line] = text.trim().split("\n");
  assert.equal(header, BLOCKS_CSV_COLUMNS.join(","));
  const cols = line.split(",");
  assert.equal(cols.length, BLOCKS_CSV_COLUMNS.length);
  assert.equal(cols[BLOCKS_CSV_INDEX.priorityFeeWei], "100000000");
  assert.equal(cols[BLOCKS_CSV_INDEX.maxFeePerGasWei], "7000000000");
  assert.deepEqual(
    checkFeeViolations(text, MAX).map((v) => v.kind),
    ["max-fee-above-tip"],
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
