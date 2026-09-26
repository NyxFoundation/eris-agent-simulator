import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
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

export class RunLogger implements RunArtifactWriter {
  readonly runDir: string;

  constructor(root: string, runId: string) {
    this.runDir = join(root, runId);
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(join(this.runDir, "events.jsonl"), "");
    writeFileSync(
      join(this.runDir, "blocks.csv"),
      `${BLOCKS_CSV_COLUMNS.join(",")}\n`,
    );
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
      `${row.round},${row.blockNumber.toString()},${row.txIndex},${row.hash},${row.from},${row.priorityFeeWei.toString()},${row.status},${row.ownerId},${row.role},${row.actionType ?? ""},${row.bundleId ?? ""},${row.bundleIndex ?? ""},${row.method ?? ""},${row.gasUsed?.toString() ?? ""},${row.maxFeePerGasWei?.toString() ?? ""}\n`,
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
