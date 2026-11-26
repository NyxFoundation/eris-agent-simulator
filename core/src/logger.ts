import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { safeStringify } from "@eris/sdk/logger.js";

export { safeStringify };

// Column schema for blocks.csv (single source of truth). Readers (postRunCheck, etc.) use this index.
export const BLOCKS_CSV_COLUMNS = [
  "round",
  "blockNumber",
  "txIndex",
  "hash",
  "from",
  "priorityFeeWei",
  "status",
  "ownerId",
  "role",
  "actionType",
  "bundleId",
  "bundleIndex",
  // ADR 0021 §4: the function the tx called, decoded from its own calldata. Appended last so that
  // every reader keyed on BLOCKS_CSV_INDEX keeps working against runs recorded before it existed.
  //
  // It replaces a join against the agents' self-reported logs, which only ever worked while the
  // coordinator was the thing starting the agents. `actionType` says what the *sender intended* and
  // exists only for txs the environment submitted; this says what the chain was asked to do, for
  // every tx in the block including a participant's.
  "method",
  // Issue #40 T0: the gas the transaction actually burned. Appended last, so every reader keyed on
  // BLOCKS_CSV_INDEX keeps working against runs recorded before it existed.
  //
  // Rules §5 caps the *number* of transactions per agent per block, not their gas, so a contract
  // that eats the block gas limit can starve other participants -- and the environment's own oracle
  // update, which is what makes it an attack on the competition rather than on a counterparty. The
  // cap is enforced up front by the RPC gateway and detected afterwards from this column, the same
  // mechanical shape as the priority-fee cap (the value comes from the receipt, not self-reported).
  "gasUsed",
  // The signed maxFeePerGas (for a legacy / 0x01 tx, its gasPrice). Appended last, so every reader
  // keyed on BLOCKS_CSV_INDEX keeps working against runs recorded before it existed.
  //
  // anvil `--order fees` sorts the block on this field, not on the tip, while at base fee 0 a tx
  // pays min(maxFeePerGas, tip). A tx signed with maxFeePerGas above its tip is ordered ahead of bids
  // that pay more (measured 2026-09-27: ahead of the oracle update's 6/6 gwei, paying 0.1 gwei/gas),
  // and `priorityFeeWei` alone cannot show it. postRunCheck reads the pair (sdk/src/feeRule.ts).
  "maxFeePerGasWei",
  // Issue #208: the tx's own `to` and `value`, so value carried between two registered addresses can
  // be read off this file after the run (core/src/rosterTransfers.ts) the way the fee and gas
  // columns are -- from the chain's record, not from anything the agent reports. `to` is empty for
  // a deployment. Appended last, so every positional reader keeps working on older runs, which
  // simply have no ETH-transfer check.
  "to",
  "valueWei",
  // Issue #212: for a row whose sender is not the agent's registered wallet but an address that
  // wallet funded (directly or through other addresses it funded), the address that funded it.
  // Empty for every other row. The row's ownerId / role are already the agent's, so every reader
  // keyed on them attributes the transaction to the agent; this column says why. Appended last, so
  // every reader keyed on BLOCKS_CSV_INDEX keeps working against runs recorded before it existed.
  "derivedFrom",
] as const;

export const BLOCKS_CSV_INDEX = Object.fromEntries(
  BLOCKS_CSV_COLUMNS.map((name, i) => [name, i]),
) as Record<(typeof BLOCKS_CSV_COLUMNS)[number], number>;

// What a run writes. An interface, not just a class, because a long-lived devnet rolls its output
// into segments (ADR 0021 §6) and everything that writes has to follow without knowing it happened.
export interface RunArtifactWriter {
  readonly runDir: string;
  event(event: Record<string, unknown>): void;
  blockRow(row: BlockRowInput): void;
  summary(summary: Record<string, unknown>): void;
  artifact(filename: string, data: unknown): void;
  append(filename: string, row: unknown): void;
}

export type BlockRowInput = {
  round: number;
  blockNumber: bigint;
  txIndex: number;
  hash: string;
  from: string;
  priorityFeeWei: bigint;
  status: string;
  ownerId: string;
  role: string;
  actionType?: string;
  bundleId?: string;
  bundleIndex?: number;
  method?: string;
  gasUsed?: bigint;
  maxFeePerGasWei?: bigint;
  to?: string;
  valueWei?: bigint;
  derivedFrom?: string;
};

// The two fee columns of a mined transaction, from its own on-chain fields (not self-reported).
// A typed tx records its tip and maxFeePerGas. A legacy / 0x01 tx has neither: its gasPrice is both
// the order key and, at base fee 0, the priority fee paid, so it goes in both columns. It used to
// fall through to 0 (viem returns no maxPriorityFeePerGas for legacy), which exempted every legacy
// tx from the fee cap whatever its gasPrice. `fallbackPriorityFeeWei` is what the environment
// recorded when it sent the tx itself, for a transaction that carries no fee field at all.
export function txFeeColumns(
  tx: {
    type?: string;
    maxFeePerGas?: bigint | null;
    maxPriorityFeePerGas?: bigint | null;
    gasPrice?: bigint | null;
  },
  fallbackPriorityFeeWei?: bigint,
): { priorityFeeWei: bigint; maxFeePerGasWei?: bigint } {
  const priced = tx.type === "legacy" || tx.type === "eip2930";
  const tip =
    tx.maxPriorityFeePerGas ?? (priced ? tx.gasPrice : undefined) ?? undefined;
  const maxFee = tx.maxFeePerGas ?? (priced ? tx.gasPrice : undefined) ?? undefined;
  return {
    priorityFeeWei: tip ?? fallbackPriorityFeeWei ?? 0n,
    ...(maxFee === undefined ? {} : { maxFeePerGasWei: maxFee }),
  };
}

/** How many names claimRunDir tries (the bare id, then `-2` .. `-<n>`) before it gives up. */
export const RUN_DIR_CLAIM_ATTEMPTS = 100;

/**
 * Claim the directory for a run that starts now, and return the id it ended up with.
 *
 * Run ids are the start time to the millisecond, and RunLogger opens its directory with a recursive
 * mkdir, which succeeds on a directory that is already there. So two runs started in the same
 * millisecond under one runs/ shared a directory and neither noticed. Observed 2026-10-22: two
 * backtests side by side on one host, each with its own --state and port, named a run the same; both
 * wrote into one runs/<runId>/, agent-view/<agent>/run-start.json included, and one run's agents
 * counted their blocks from the other run's start and sat idle for the last 122 of 360 blocks. Nothing
 * failed, and the matrix came out complete.
 *
 * The claim is a non-recursive mkdir, which the OS either performs or refuses with EEXIST: of two
 * processes asking for one name exactly one gets it, with no check-then-create gap to lose in. A name
 * that is taken is tried again with a suffix (`<id>-2`, `<id>-3`, ...). The bare id stays the common
 * case and the suffix goes after it, so whatever reads a run id as a date (agentState's snapshot
 * pruning, the dashboard's display name) still finds the date at the front. Any other error is not
 * "taken" and is thrown as it is.
 *
 * Only for a run that starts fresh. A run that resumes (a practice period after a restart,
 * realtime/periodResume.ts) reopens the directory it already has with `append` and does not come
 * through here.
 */
export function claimRunDir(
  root: string,
  baseId: string,
  attempts: number = RUN_DIR_CLAIM_ATTEMPTS,
): string {
  // The root is shared and may not exist yet. Creating it is not the claim; creating the child is.
  mkdirSync(root, { recursive: true });
  for (let n = 1; n <= attempts; n++) {
    const id = n === 1 ? baseId : `${baseId}-${n}`;
    try {
      mkdirSync(join(root, id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(
    `no free run directory under ${root}: ${baseId} and its suffixes up to -${attempts} are all taken`,
  );
}

export class RunLogger implements RunArtifactWriter {
  readonly runDir: string;

  // `append`: open a directory that already has a run in it and add to it (a practice period that
  // resumes after a restart, core/src/realtime/periodResume.ts) instead of starting both files over.
  constructor(root: string, runId: string, opts: { append?: boolean } = {}) {
    this.runDir = join(root, runId);
    mkdirSync(this.runDir, { recursive: true });
    const events = join(this.runDir, "events.jsonl");
    const blocks = join(this.runDir, "blocks.csv");
    if (!opts.append || !existsSync(events)) writeFileSync(events, "");
    if (!opts.append || !existsSync(blocks))
      writeFileSync(blocks, `${BLOCKS_CSV_COLUMNS.join(",")}\n`);
  }

  event(event: Record<string, unknown>): void {
    appendFileSync(
      join(this.runDir, "events.jsonl"),
      `${safeStringify({ ts: new Date().toISOString(), ...event })}\n`,
    );
  }

  blockRow(row: BlockRowInput): void {
    appendFileSync(
      join(this.runDir, "blocks.csv"),
      `${row.round},${row.blockNumber.toString()},${row.txIndex},${row.hash},${row.from},${row.priorityFeeWei.toString()},${row.status},${row.ownerId},${row.role},${row.actionType ?? ""},${row.bundleId ?? ""},${row.bundleIndex ?? ""},${row.method ?? ""},${row.gasUsed?.toString() ?? ""},${row.maxFeePerGasWei?.toString() ?? ""},${row.to ?? ""},${row.valueWei?.toString() ?? ""},${row.derivedFrom ?? ""}\n`,
    );
  }

  summary(summary: Record<string, unknown>): void {
    writeFileSync(
      join(this.runDir, "summary.json"),
      `${safeStringify(summary, 2)}\n`,
    );
  }

  // A standalone JSON artifact in the run dir (e.g. market.json, issue #63 Phase 2). Unindented:
  // these are bulk series meant for programmatic consumption, not for reading in an editor.
  artifact(filename: string, data: unknown): void {
    writeFileSync(join(this.runDir, filename), `${safeStringify(data)}\n`);
  }

  // One line appended to a jsonl artifact. Distinct from `event`, which is the run's single
  // chronological log: a series with its own file can be tailed on its own, which is what makes
  // live standings possible without reading a week of events (ADR 0021 §3).
  append(filename: string, row: unknown): void {
    appendFileSync(join(this.runDir, filename), `${safeStringify(row)}\n`);
  }
}
