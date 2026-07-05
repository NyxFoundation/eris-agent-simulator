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
