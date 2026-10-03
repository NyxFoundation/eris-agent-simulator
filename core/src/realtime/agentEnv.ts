/**
 * agentEnv.ts: which extra env keys the coordinator hands a launched agent, as a function of the
 * config alone.
 *
 * Everything an agent is handed at the start of an epoch is something it can read before the first
 * price moves, so anything that differs between regimes names the regime. That used to be four of
 * the twelve: the registry's address only in `launch`, the vuln factory only in `vuln`, the Aave
 * victims only in `lending-incident`, the Liquity victims only in `cdp-incident` -- and knowing you
 * are in one of the last two is knowing the crash is coming. The first two are now the same in every
 * run (the registry is on in every official regime, the vuln factory is deployed in every run).
 *
 * The victim lists remain, deliberately listed here rather than hidden: the victims are on-chain
 * from block 0 whether or not their addresses are handed out, so removing the env would not remove
 * the signal. Closing that needs the victims to exist in every regime (decoys), which changes what
 * the regimes are and is decided separately. `test/regimeStartInvariance.test.ts` holds every other
 * key equal across the official regimes, so a new regime-dependent key fails there instead of
 * shipping.
 *
 * The coordinator checks the env it built against this shape before launching anyone, so the two
 * cannot drift apart.
 */
import type { SimConfig } from "@eris/sdk/config.js";

/** Keys present in every run. */
export const AGENT_ENV_ALWAYS = [
  "ERIS_VULN_FACTORY",
  "ERIS_VULN_FROM_BLOCK",
  "ERIS_VULN_LLM",
  "ERIS_MAX_TX_GAS",
  "ERIS_MAX_AGENT_BLOCK_GAS",
] as const;

/** Present when agent-created markets are on (every official regime). */
export const AGENT_ENV_REGISTRY = [
  "ERIS_MARKET_REGISTRY_ADDRESS",
  "ERIS_LENDING_ADDRESS",
  "ERIS_MARKET_REGISTRY_FROM_BLOCK",
] as const;

/**
 * Keys whose presence still depends on the regime. Known, and the reason is above: the victims are
 * visible on-chain from block 0 regardless, so this list shrinks only when the victims do.
 */
export const REGIME_REVEALING_AGENT_ENV = {
  ERIS_LIQUIDATION_VICTIMS: "Aave victim cohort (stress.victimCount > 0)",
  ERIS_LIQUITY_VICTIMS: "Liquity victim cohort (stress.liquityVictimCount > 0)",
} as const;

/** The extra env keys the coordinator hands every launched agent under this config. */
export function agentExtraEnvKeys(
  config: Pick<
    SimConfig,
    "agentMarkets" | "stressVictimCount" | "stressLiquityVictimCount"
  >,
  opts: { segmented: boolean },
): string[] {
  const keys: string[] = [...AGENT_ENV_ALWAYS];
  if (config.agentMarkets) keys.push(...AGENT_ENV_REGISTRY);
  if (opts.segmented) keys.push("ERIS_RUN_DIR_POINTER");
  if (config.stressVictimCount > 0) keys.push("ERIS_LIQUIDATION_VICTIMS");
  if (config.stressLiquityVictimCount > 0) keys.push("ERIS_LIQUITY_VICTIMS");
  return keys.sort();
}

/** Throws when the env the coordinator built is not the shape the config says it should be. */
export function assertAgentExtraEnvShape(
  config: Parameters<typeof agentExtraEnvKeys>[0],
  env: Record<string, string>,
  opts: { segmented: boolean },
): void {
  const want = agentExtraEnvKeys(config, opts);
  const got = Object.keys(env).sort();
  if (want.join(",") !== got.join(","))
    throw new Error(
      `agent env shape mismatch: built [${got.join(", ")}], the config says [${want.join(", ")}]. ` +
        "Every key an agent is handed at the start is readable before the first price moves, so a " +
        "key that appears only in some regimes names the regime. Add the key to core/src/realtime/agentEnv.ts " +
        "(and make it regime-independent, or list it in REGIME_REVEALING_AGENT_ENV with the reason).",
    );
}
