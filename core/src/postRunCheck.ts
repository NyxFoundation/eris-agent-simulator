// Post-run rule checking (ADR 0006 §5). In direct mode the agent can bypass the
// pre-flight validateAction check, so rule enforcement moves to a mechanical check
// of the facts left on chain (blocks.csv). A priority fee over the cap, or a
// maxFeePerGas above the tip, is a market-distorting violation affecting --order fees
// ordering, so on detection we flag the offending agent.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFeeRule, type FeeRuleBreach } from "@eris/sdk/feeRule.js";
import { BLOCKS_CSV_INDEX } from "./logger.js";

// Issue #212: senders attributed to an agent after some of their rows were written. The coordinator
// records a derived sender's rows under the agent once it has seen the funding, but a transaction the
// address sent *before* the funding landed (a zero-fee transaction needs no ETH) went in as
// `external`. Built over the whole run, this map lets every check read those rows as the agent's
// too: lowercase sender address -> agent id.
export type DerivedOwners = ReadonlyMap<string, string>;

// The agent a blocks.csv row belongs to, or undefined for an environment or unknown sender.
function agentRowOwner(
  cols: string[],
  derived?: DerivedOwners,
): string | undefined {
  const I = BLOCKS_CSV_INDEX;
  if (cols[I.role] === "agent") return cols[I.ownerId];
  if (cols[I.role] === "external" && derived)
    return derived.get((cols[I.from] ?? "").toLowerCase());
  return undefined;
}

export type FeeViolation = {
  ownerId: string;
  hash: string;
  blockNumber: number;
  priorityFeeWei: string;
  maxPriorityFeeWei: string;
  // Which half of the fee rule (sdk/src/feeRule.ts) the tx broke. A summary.json written before
  // the maxFeePerGas half existed has no `kind`: every violation in it is over-cap.
  kind: FeeRuleBreach["kind"];
  // The signed maxFeePerGas, when blocks.csv recorded it.
  maxFeePerGasWei?: string;
};

// Pure function detecting fee-rule violations from the agent rows of blocks.csv. The fees come
// from the on-chain tx fields (not self-reported), so they cannot be tampered with.
//
// Two halves (sdk/src/feeRule.ts):
//   over-cap           the tip -- for a legacy tx, the gasPrice -- is above the cap. The oracle
//                      update is sent at cap + 1 gwei so that nothing an agent bids can precede it.
//   max-fee-above-tip  maxFeePerGas above the tip. anvil orders on maxFeePerGas and at base fee 0 the
//                      tx pays only the tip, so the excess bought position that was never paid for
//                      -- measured ahead of the oracle update while paying 0.1 gwei/gas. Checked
//                      only where blocks.csv has the maxFeePerGasWei column (older runs cannot be).
// A cap of 0 disables the first half only (the economic gas profile retires the cap, ADR 0011 §2).
export function checkFeeViolations(
  blocksCsv: string,
  maxPriorityFeeWei: bigint,
  derived?: DerivedOwners,
): FeeViolation[] {
  const I = BLOCKS_CSV_INDEX;
  const violations: FeeViolation[] = [];
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    const ownerId = agentRowOwner(cols, derived);
    if (ownerId === undefined) continue;
    let tip: bigint;
    try {
      tip = BigInt(cols[I.priorityFeeWei]);
    } catch {
      continue;
    }
    let maxFee: bigint | undefined;
    const rawMaxFee = cols[I.maxFeePerGasWei];
    if (rawMaxFee !== undefined && rawMaxFee !== "") {
      try {
        maxFee = BigInt(rawMaxFee);
      } catch {
        maxFee = undefined;
      }
    }
    const breach = checkFeeRule(
      { maxPriorityFeePerGas: tip, maxFeePerGas: maxFee },
      maxPriorityFeeWei,
    );
    if (!breach) continue;
    violations.push({
      ownerId,
      hash: cols[I.hash],
      blockNumber: Number(cols[I.blockNumber]),
      priorityFeeWei: cols[I.priorityFeeWei],
      maxPriorityFeeWei: maxPriorityFeeWei.toString(),
      kind: breach.kind,
      ...(maxFee === undefined ? {} : { maxFeePerGasWei: maxFee.toString() }),
    });
  }
  return violations;
}

export function checkRunFeeViolations(
  runDir: string,
  maxPriorityFeeWei: bigint,
  derived?: DerivedOwners,
): FeeViolation[] {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return [];
  return checkFeeViolations(
    readFileSync(path, "utf8"),
    maxPriorityFeeWei,
    derived,
  );
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
  derived?: DerivedOwners,
): GasViolation[] {
  const I = BLOCKS_CSV_INDEX;
  const violations: GasViolation[] = [];
  // (ownerId, blockNumber) -> gas. Built in one pass so the per-block totals do not need a second.
  // A derived sender's gas lands in its agent's total: that sum is the one check the gateway cannot
  // do per sender (issue #212).
  const perBlock = new Map<string, { ownerId: string; block: number; gas: bigint }>();
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    const ownerId = agentRowOwner(cols, derived);
    if (ownerId === undefined) continue;
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
  derived?: DerivedOwners,
): GasViolation[] {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return [];
  return checkGasViolations(readFileSync(path, "utf8"), limits, derived);
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
  derived?: DerivedOwners,
): UnloggedAgentTx[] {
  const I = BLOCKS_CSV_INDEX;
  const found: UnloggedAgentTx[] = [];
  for (const line of blocksCsv.split("\n").slice(1)) {
    if (line.length === 0) continue;
    const cols = line.split(",");
    // A derived sender's transaction is the agent's and its runtime never logged it (the runtime
    // only signs with the registered key), so it lands here by construction (issue #212).
    const ownerId = agentRowOwner(cols, derived);
    if (ownerId === undefined) continue;
    const submitted = submittedByOwner.get(ownerId);
    if (submitted === undefined) continue;
    const hash = cols[I.hash].toLowerCase();
    if (submitted.has(hash)) continue;
    found.push({
      ownerId,
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
  derived?: DerivedOwners,
): UnloggedAgentTx[] {
  const path = join(runDir, "blocks.csv");
  if (!existsSync(path)) return [];
  const submittedByOwner = new Map<string, Set<string>>();
  for (const id of agentIds)
    submittedByOwner.set(id, readSubmittedHashes(runDir, id));
  return findUnloggedAgentTxs(
    readFileSync(path, "utf8"),
    submittedByOwner,
    derived,
  );
}
