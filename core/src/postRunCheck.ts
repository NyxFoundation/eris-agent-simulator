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

// On-chain transactions from an agent's wallet that the agent's own runtime never reported sending.
//
// The runtime self-reports every send to agents/<id>.jsonl (`kind: "mempool", event: "submitted"`,
// with the hash; ADR 0006 §5), and blocks.csv records what the chain included, attributed to the
// agent by its wallet address. A tx in the second and not in the first was sent by something other
// than the process the coordinator started: a participant driving the wallet by hand, or a second
// process holding the key. Both are the human intervention the rules forbid after the freeze (§8),
// and neither leaves any other trace -- the tx is signed by the right key and lands like any other.
//
// A report, not a verdict. A runtime that dies between sendRawTransaction returning and the log
// line being appended leaves the same mark, so the operator reads this next to the agent's exit
// record and stderr. Only agents that have an entry in `submittedByOwner` are checked: an external
// participant (ADR 0021) keeps its log on its own machine, so there is nothing to reconcile against.
export type UnloggedAgentTx = {
  ownerId: string;
  hash: string;
  blockNumber: number;
};

export function findUnloggedAgentTxs(
  blocksCsv: string,
  submittedByOwner: ReadonlyMap<string, ReadonlySet<string>>,
): UnloggedAgentTx[] {
  const I = BLOCKS_CSV_INDEX;
  const found: UnloggedAgentTx[] = [];
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    if (cols[I.role] !== "agent") continue;
    const submitted = submittedByOwner.get(cols[I.ownerId]);
    if (submitted === undefined) continue;
    const hash = cols[I.hash].toLowerCase();
    if (submitted.has(hash)) continue;
    found.push({
      ownerId: cols[I.ownerId],
      hash,
      blockNumber: Number(cols[I.blockNumber]),
    });
  }
  return found;
}

// The hashes an agent's runtime reported sending, from its own log. A missing log is an empty set:
// an agent that never wrote a line and still has transactions on chain is exactly the case above.
export function readSubmittedHashes(runDir: string, agentId: string): Set<string> {
  const path = join(runDir, "agents", `${agentId}.jsonl`);
  const hashes = new Set<string>();
  if (!existsSync(path)) return hashes;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.kind !== "mempool" || e.event !== "submitted") continue;
    if (typeof e.hash === "string") hashes.add(e.hash.toLowerCase());
  }
  return hashes;
}

export function reconcileRunAgentTxs(
  runDir: string,
  agentIds: readonly string[],
): UnloggedAgentTx[] {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return [];
  const submittedByOwner = new Map<string, Set<string>>();
  for (const id of agentIds)
    submittedByOwner.set(id, readSubmittedHashes(runDir, id));
  return findUnloggedAgentTxs(readFileSync(path, "utf8"), submittedByOwner);
}
