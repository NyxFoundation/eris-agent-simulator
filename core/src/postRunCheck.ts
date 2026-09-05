// Post-run rule checking (ADR 0006 §5). In direct mode the agent can bypass the
// pre-flight validateAction check, so rule enforcement moves to a mechanical check
// of the facts left on chain (blocks.csv). A priority fee over the cap is a
// market-distorting violation affecting --order fees ordering, so on detection we
// flag the offending agent and also invalidate that run (evaluate re-runs it).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKS_CSV_INDEX } from "./logger.js";

export type FeeViolation = {
  ownerId: string;
  hash: string;
  blockNumber: number;
  priorityFeeWei: string;
  maxPriorityFeeWei: string;
};

// Pure function detecting priority fee cap violations from the agent rows of blocks.csv.
// The fee comes from the on-chain tx field (not self-reported), so it cannot be tampered with.
export function checkFeeViolations(
  blocksCsv: string,
  maxPriorityFeeWei: bigint,
): FeeViolation[] {
  const I = BLOCKS_CSV_INDEX;
  const violations: FeeViolation[] = [];
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    if (cols[I.role] !== "agent") continue;
    let fee: bigint;
    try {
      fee = BigInt(cols[I.priorityFeeWei]);
    } catch {
      continue;
    }
    if (fee > maxPriorityFeeWei) {
      violations.push({
        ownerId: cols[I.ownerId],
        hash: cols[I.hash],
        blockNumber: Number(cols[I.blockNumber]),
        priorityFeeWei: cols[I.priorityFeeWei],
        maxPriorityFeeWei: maxPriorityFeeWei.toString(),
      });
    }
  }
  return violations;
}

export function checkRunFeeViolations(
  runDir: string,
  maxPriorityFeeWei: bigint,
): FeeViolation[] {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return [];
  return checkFeeViolations(readFileSync(path, "utf8"), maxPriorityFeeWei);
}

// Gas-budget violations (issue #40 T0).
//
// Rules §5 caps the *number* of transactions an agent may put in a block, not their gas. That is
// enough while every transaction is a swap; it stops being enough the moment agents deploy their own
// contracts, because a single call into code somebody wrote to be expensive can eat the block gas
// limit and starve everyone else — including the environment's own oracle update, which is what
// turns it from a trade against a counterparty into an attack on the competition.
//
// Two ceilings, both measured from the receipt rather than from anything the agent reports:
//   perTx     one transaction's gas.
//   perBlock  one agent's gas across all its transactions in one block.
//
// The RPC gateway refuses an over-cap transaction up front (it can read the signed gas limit before
// the transaction ever reaches the node). This is the after-the-fact half: the gateway can be
// bypassed by a self-hosted participant sending straight to a node, and what lands on chain is the
// authority. A zero ceiling disables the corresponding check.
export type GasViolation = {
  ownerId: string;
  kind: "per-tx" | "per-block";
  blockNumber: number;
  // The offending transaction, or "" for a per-block total (which is not one transaction).
  hash: string;
  gasUsed: string;
  limit: string;
};

export function checkGasViolations(
  blocksCsv: string,
  limits: { maxTxGas: bigint; maxAgentBlockGas: bigint },
): GasViolation[] {
  const I = BLOCKS_CSV_INDEX;
  const violations: GasViolation[] = [];
  // (ownerId, blockNumber) -> gas. Built in one pass so the per-block totals do not need a second.
  const perBlock = new Map<string, { ownerId: string; block: number; gas: bigint }>();
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    if (cols[I.role] !== "agent") continue;
    const raw = cols[I.gasUsed];
    // Runs recorded before the column existed have no gas to check. Silently skipping them is
    // right: the alternative is reading "" as zero and reporting a clean bill of health for a run
    // that was never measured.
    if (raw === undefined || raw === "") continue;
    let gas: bigint;
    try {
      gas = BigInt(raw);
    } catch {
      continue;
    }
    const blockNumber = Number(cols[I.blockNumber]);
    const ownerId = cols[I.ownerId];
    if (limits.maxTxGas > 0n && gas > limits.maxTxGas) {
      violations.push({
        ownerId,
        kind: "per-tx",
        blockNumber,
        hash: cols[I.hash],
        gasUsed: gas.toString(),
        limit: limits.maxTxGas.toString(),
      });
    }
    const key = `${ownerId}|${blockNumber}`;
    const entry = perBlock.get(key);
    if (entry) entry.gas += gas;
    else perBlock.set(key, { ownerId, block: blockNumber, gas });
  }
  if (limits.maxAgentBlockGas > 0n) {
    for (const { ownerId, block, gas } of perBlock.values()) {
      if (gas <= limits.maxAgentBlockGas) continue;
      violations.push({
        ownerId,
        kind: "per-block",
        blockNumber: block,
        hash: "",
        gasUsed: gas.toString(),
        limit: limits.maxAgentBlockGas.toString(),
      });
    }
  }
  return violations;
}

export function checkRunGasViolations(
  runDir: string,
  limits: { maxTxGas: bigint; maxAgentBlockGas: bigint },
): GasViolation[] {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return [];
  return checkGasViolations(readFileSync(path, "utf8"), limits);
}

// Environment-owned transactions that reverted, by owner (ADR 0017 regime 3).
//
// The environment's own shocks must not fail quietly. A whale order is submitted through the same
// relay as ordinary flow, and that path catches submission errors -- but an on-chain revert is not a
// submission error: the tx lands, the event log says the whale fired, and only blocks.csv records
// that it did nothing. That is how a missing token approval turned the whale regime into calm with
// every log looking healthy.
export function countRevertedTxs(
  blocksCsv: string,
  ownerId: string,
): { total: number; reverted: number } {
  const I = BLOCKS_CSV_INDEX;
  let total = 0;
  let reverted = 0;
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    if (cols[I.ownerId] !== ownerId) continue;
    total++;
    if (cols[I.status] === "reverted") reverted++;
  }
  return { total, reverted };
}

export function countRunRevertedTxs(
  runDir: string,
  ownerId: string,
): { total: number; reverted: number } {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return { total: 0, reverted: 0 };
  return countRevertedTxs(readFileSync(path, "utf8"), ownerId);
}
