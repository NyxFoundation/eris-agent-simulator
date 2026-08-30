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
] as const;

export const BLOCKS_CSV_INDEX = Object.fromEntries(
  BLOCKS_CSV_COLUMNS.map((name, i) => [name, i]),
) as Record<(typeof BLOCKS_CSV_COLUMNS)[number], number>;

export class RunLogger {
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

  blockRow(row: {
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
  }): void {
    appendFileSync(
      join(this.runDir, "blocks.csv"),
      `${row.round},${row.blockNumber.toString()},${row.txIndex},${row.hash},${row.from},${row.priorityFeeWei.toString()},${row.status},${row.ownerId},${row.role},${row.actionType ?? ""},${row.bundleId ?? ""},${row.bundleIndex ?? ""}\n`,
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
