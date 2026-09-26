// Refuse a local deployment on which GMX has no funding (or, on a chain that is never reset, say so
// loudly and carry on -- see gmxFundingEnforcement).
//
// Funding is non-zero only on deploys baked after deployer/vendor/gmx-localhost.patch gained funding
// parameters (commit a35cf3e, 2026-09-02). Upstream's hardhat profile leaves
// fundingIncreaseFactorPerSecond at 0, and with it 0 the adaptive path never runs: the funding rate
// every reader sees is 0 on every block and the observation says `fundingModeled: false`. A state
// dump baked before that commit still loads, runs and scores -- as a different economy from the one
// the regimes are calibrated for (the crowded side of a perp pays nothing for being crowded), with
// nothing in the run saying so. So the coordinator reads the one key that decides it for every
// configured market at setup, and stops -- on anvil, where the fix is a re-bake. The practice devnet
// (chainMode external) is one chain for the whole period and is never reset: stopping there would
// take the period down on the next restart with nothing to re-bake, so it records and warns instead.
//
// The key and the "modeled" decision come from sdk/src/protocols/gmxKeys.ts, the single source both
// the observation and the post-run market series read, so this check cannot disagree with what an
// agent is shown.
import type { Address, PublicClient } from "viem";
import type { ChainMode } from "@eris/sdk/chain.js";
import { GMX } from "@eris/sdk/constants.js";
import {
  gmxDataStoreReadAbi,
  gmxFundingFields,
  gmxFundingIncreaseFactorKey,
} from "@eris/sdk/protocols/gmxKeys.js";

/** One market's funding configuration as read from its DataStore. */
export type GmxFundingConfigRead = {
  base: string;
  market: Address;
  // FUNDING_INCREASE_FACTOR_PER_SECOND. Absent when the read failed, which is not a zero.
  fundingIncreaseFactorPerSecond?: bigint;
  error?: string;
};

export type GmxFundingCheck = {
  ok: boolean;
  markets: Array<{
    base: string;
    market: Address;
    fundingIncreaseFactorPerSecond: string | null;
    fundingModeled: boolean | null;
  }>;
  // "<base> (<market>)" for each market whose deploy does not model funding.
  unmodeled: string[];
  // "<base> (<market>): <error>" for each market whose config could not be read.
  unread: string[];
};

/**
 * The decision, pure. Every market must be read and must model funding: a market whose config
 * could not be read fails too, since "could not tell" is the silent acceptance this exists to stop.
 */
export function gmxFundingCheck(
  reads: readonly GmxFundingConfigRead[],
): GmxFundingCheck {
  const markets: GmxFundingCheck["markets"] = [];
  const unmodeled: string[] = [];
  const unread: string[] = [];
  for (const r of reads) {
    const label = `${r.base} (${r.market})`;
    const modeled =
      r.fundingIncreaseFactorPerSecond === undefined
        ? undefined
        : gmxFundingFields({
            fundingIncreaseFactorPerSecond: r.fundingIncreaseFactorPerSecond,
          }).fundingModeled;
    markets.push({
      base: r.base,
      market: r.market,
      fundingIncreaseFactorPerSecond:
        r.fundingIncreaseFactorPerSecond?.toString() ?? null,
      fundingModeled: modeled ?? null,
    });
    if (modeled === undefined)
      unread.push(`${label}: ${r.error ?? "read failed"}`);
    else if (!modeled) unmodeled.push(label);
  }
  return {
    ok: unmodeled.length === 0 && unread.length === 0,
    markets,
    unmodeled,
    unread,
  };
}

/**
 * What a failed check does. On anvil (backtest, sim:realtime) the run stops: the chain is rebuilt
 * from a dump every run, so re-baking is the fix and running on is scoring the wrong economy. On an
 * external chain it only warns: the practice devnet is never reset, so there is nothing to re-bake
 * mid-period, and stopping would end the period on the next coordinator restart.
 */
export function gmxFundingEnforcement(
  check: GmxFundingCheck,
  chainMode: ChainMode,
): "pass" | "warn" | "fail" {
  if (check.ok) return "pass";
  return chainMode === "external" ? "warn" : "fail";
}

/** What to tell the operator when the check fails: what is wrong and the commands that fix it. */
export function gmxFundingMissingMessage(
  check: GmxFundingCheck,
  chainMode: ChainMode = "anvil",
): string {
  const lines: string[] = [];
  if (check.unmodeled.length > 0)
    lines.push(
      `GMX funding is not modeled on this deployment: FUNDING_INCREASE_FACTOR_PER_SECOND is 0 for ` +
        `${check.unmodeled.join(", ")}, so the funding rate would read 0 on every block and every ` +
        "agent would see fundingModeled: false -- a different economy from the one the regimes are " +
        "calibrated for. The deploy or state dump predates GMX funding (deployer/vendor/" +
        "gmx-localhost.patch, commit a35cf3e, 2026-09-02).",
    );
  if (check.unread.length > 0)
    lines.push(
      `Could not read GMX's funding configuration for ${check.unread.join("; ")}, so this run ` +
        "cannot tell whether the deployment models funding.",
    );
  if (chainMode === "external")
    lines.push(
      "Continuing anyway: this is an external chain that is never reset, so it cannot be re-baked " +
        "in place (the run records gmx_funding_check ok:false). Fix for the next deployment of this " +
        "chain: deploy it with the current deployer (`cd deployer && npm run clean:vendors && " +
        "./scripts/setup-vendors.sh && npm run deploy -- --keep-fresh`), then point the addresses " +
        "at it with `DEPLOYMENTS_JSON=<path> npm run gen:local-constants`.",
    );
  else
    lines.push(
      "Fix: redeploy with the current deployer on a fresh anvil (`cd deployer && npm run " +
        "clean:vendors && ./scripts/setup-vendors.sh && npm run deploy -- --keep-fresh`), then " +
        "`npm run gen:local-constants`, and re-bake the backtest state with `npm run gen:state-dump`.",
    );
  return lines.join("\n");
}

/** Read FUNDING_INCREASE_FACTOR_PER_SECOND for every market (base -> market address). */
export async function readGmxFundingConfig(
  publicClient: Pick<PublicClient, "readContract">,
  markets: Readonly<Record<string, Address>>,
): Promise<GmxFundingConfigRead[]> {
  const out: GmxFundingConfigRead[] = [];
  for (const [base, market] of Object.entries(markets)) {
    try {
      const value = (await publicClient.readContract({
        address: GMX.DataStore,
        abi: gmxDataStoreReadAbi,
        functionName: "getUint",
        args: [gmxFundingIncreaseFactorKey(market)],
      })) as bigint;
      out.push({ base, market, fundingIncreaseFactorPerSecond: value });
    } catch (error) {
      out.push({
        base,
        market,
        error:
          error instanceof Error ? error.message.split("\n")[0] : String(error),
      });
    }
  }
  return out;
}
