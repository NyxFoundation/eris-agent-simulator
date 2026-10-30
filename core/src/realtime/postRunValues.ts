// The end-of-run mark behind summary.json's netPnlUsdc, read so that one agent's position cannot
// stop the summary from being written.
//
// The loop that used to do this awaited every adapter's live `valueUsdc` with nothing around it,
// inside a post-run block that is `try {} finally {}`. A throw there skipped `logger.summary`, the
// backtest read the missing summary.json as a failed scenario, and standings.ts marked the epoch
// invalid -- out of S for everyone. An agent can make that read throw on purpose: ~3,250
// `requestWithdraw(1 wei)` to the LST vault (~250k gas each, free at tip 0) push
// `MockLSTVault.accountSummaryAt`, which loops over every request, past the 30M block gas limit the
// coordinator sets (measured on anvil 1.5.1 after `anvil_setBlockGasLimit(30M)`). Staying just under
// the threshold and crossing it only in an epoch it is losing cancels exactly those epochs.
//
// So a read that fails here is reported, not thrown: the adapter counts 0 toward this agent's
// netPnlUsdc and the record says so, as a `read-failed` holding in the shape every other
// read-failed report takes (issue #44). P does not come from here -- it is the boundary series read
// live (rules §4.4.1), where the same vault read already fails into a `read-failed` holding rather
// than a throw -- so this only decides whether netPnlUsdc is complete, never whether the epoch is.
import type { UnpricedHoldingDetail } from "@eris/sdk/protocols/types.js";

export type PostRunValueFailure = {
  // The adapter (or "wallet", for the spot balances) whose read failed.
  adapter: string;
  error: string;
};

export type PostRunValues = {
  // adapter id -> its value for this agent. 0 where the read failed (and listed in `failures`).
  protocolValues: Record<string, number>;
  totalUsdc: number;
  failures: PostRunValueFailure[];
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Every adapter's live value for one agent. A read that throws counts 0 and is returned in
 * `failures`; nothing here throws.
 */
export async function readPostRunValues<A extends { id: string }>(
  adapters: readonly A[],
  read: (adapter: A) => Promise<number>,
): Promise<PostRunValues> {
  const protocolValues: Record<string, number> = {};
  const failures: PostRunValueFailure[] = [];
  let totalUsdc = 0;
  for (const adapter of adapters) {
    try {
      const v = await read(adapter);
      // A NaN would turn the agent's whole netPnlUsdc into NaN, which JSON writes as null -- a
      // field that looks absent rather than wrong. Same treatment as a throw.
      if (!Number.isFinite(v)) throw new Error(`non-finite value ${v}`);
      protocolValues[adapter.id] = v;
      totalUsdc += v;
    } catch (error) {
      protocolValues[adapter.id] = 0;
      failures.push({ adapter: adapter.id, error: message(error) });
    }
  }
  return { protocolValues, totalUsdc, failures };
}

/** The failures as the read-failed holdings summary.json carries beside netPnlUsdc. */
export function postRunReadFailedHoldings(
  failures: readonly PostRunValueFailure[],
): UnpricedHoldingDetail[] {
  return failures.map((f) => ({
    source: `summary-value:${f.adapter}`,
    amountRaw: "",
    reason: "read-failed" as const,
    // Prose, as the field is everywhere else: read by whoever is diagnosing the number.
    read: `${f.adapter}.valueUsdc at the end of the run: ${f.error}`,
  }));
}

// A run that throws hands its caller no `{ runDir }`, and the backtest needs the directory to look
// for the boundary series the live scorer already wrote there. Carried on the error itself (the
// same object, so `isLiveWeekRefusal` and every other name check still match).
export type ErrorWithRunDir = Error & { runDir: string };

export function withRunDir(error: unknown, runDir: string): ErrorWithRunDir {
  const e = (
    error instanceof Error ? error : new Error(String(error))
  ) as ErrorWithRunDir;
  if (typeof e.runDir !== "string") e.runDir = runDir;
  return e;
}

export function runDirOfError(error: unknown): string | undefined {
  const dir = (error as { runDir?: unknown } | null)?.runDir;
  return typeof dir === "string" ? dir : undefined;
}
