// Can this agent actually use the chain it was pointed at?
//
// An agent that starts, cannot reach its RPC, and keeps looping leaves behind exactly what an agent
// that chose not to trade leaves behind: `includedTxCount: 0`, `netPnlUsdc: 0`, `violations: []`,
// an empty `stderrTail`. Nothing in summary.json separates the two, and the difference is the whole
// result. Measured on a containerised agent whose RPC URL resolved inside the container instead of
// on the host: 25 log lines in the first ten seconds (23 failed approvals, then silence) and not one
// line for the remaining two minutes and forty-eight seconds of a 100-block run, while
// `docker stats` showed 111 MiB and 0.8% CPU the whole time.
//
// RealtimeAgentProcess.onExit already reports a child that dies -- its comment says why, in these
// words: "an agent that crashes mid-run just stops trading, and the run looks like one where it
// chose not to act -- indistinguishable in summary.json, and the difference is the whole result".
// It only fires for a process that exits, so the fix is to exit rather than to keep a loop running
// over a chain that is not there.
//
// This runs before the first read and costs one `eth_chainId` plus one `eth_getCode` per
// load-bearing contract, all in a single batch.
import type { PublicClient } from "viem";
import {
  checkDeployment,
  deploymentMismatchMessage,
} from "@eris/sdk/deploymentCheck.js";
import type { ProtocolId } from "@eris/sdk/types.js";

export type PreflightFailure = {
  /** Which of the three questions failed, for tests and for callers that want to branch. */
  kind: "unreachable" | "chain-id" | "deployment";
  message: string;
};

const sleepMs = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Returns null when the chain is usable, or the first failure that makes this agent inert.
 *
 * Reachability is retried: a self-hosted agent (ADR 0021) is started by hand or by a supervisor and
 * may come up a moment before the node accepts connections, and a restart loop is a worse answer to
 * that than waiting two seconds. The other two questions are not retried -- a wrong chain id and a
 * missing deployment do not become right by asking again.
 */
export async function preflightChain(opts: {
  publicClient: PublicClient;
  rpcUrl: string;
  /** The id transactions will be signed for (config.chainId), not the one the node reports. */
  expectedChainId: number;
  enabledIds: ProtocolId[];
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PreflightFailure | null> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? sleepMs;

  let chainId: number | undefined;
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      chainId = await opts.publicClient.getChainId();
      break;
    } catch (err) {
      lastError =
        err instanceof Error ? err.message.split("\n")[0] : String(err);
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  if (chainId === undefined)
    return {
      kind: "unreachable",
      message:
        `cannot reach the chain at ${opts.rpcUrl} — ${attempts} attempts over ` +
        `${((attempts - 1) * delayMs) / 1000}s all failed: ${lastError}\n` +
        "  Stopping here on purpose: this process runs perfectly well without a chain, and a run\n" +
        "  where it did records 0 transactions and 0 PnL — the same thing an agent that decided to\n" +
        "  sit still records.\n" +
        "  Running in a container? 127.0.0.1 is the container, not the host.",
    };

  if (chainId !== opts.expectedChainId)
    return {
      kind: "chain-id",
      message:
        `chain id mismatch: the node at ${opts.rpcUrl} reports ${chainId}, this agent is ` +
        `configured for ${opts.expectedChainId}\n` +
        `  Transactions are signed for ${opts.expectedChainId}, so every send would be rejected\n` +
        "  while reads kept working — the agent would look alive and place nothing.\n" +
        "  The chain comes from ANVIL_RPC_URL / CHAIN_ID, the id from run.chainId (or the address\n" +
        "  overlay in sdk/src/constants.local.ts). Point both at the same chain.",
    };

  const check = await checkDeployment({
    publicClient: opts.publicClient,
    enabledIds: opts.enabledIds,
    chainId,
  });
  if (check.missing.length > 0)
    return {
      kind: "deployment",
      message: deploymentMismatchMessage(check, opts.rpcUrl),
    };

  return null;
}
