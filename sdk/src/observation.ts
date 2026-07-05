// Observation reconstruction (ADR 0006 / ADR 0015).
// In direct mode the agent runtime (example/agents/runtime/read.ts) assembles the AgentObservation
// from the chain itself every block. The environment's (core) scoring/diagnostics use the same shape,
// so the "chain state + config → AgentObservation" conversion lives in the sdk as a contract.
import type { Address } from "viem";
import type { SimConfig } from "./config.js";
import { balanceToInventory } from "./pnl.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
  ProtocolObservations,
} from "./types.js";
import { tokenInfo } from "./markets.js";
import type { ProtocolAdapter, SimContext } from "./protocols/types.js";

export async function observationFor(
  ctx: SimContext,
  adapters: ProtocolAdapter[],
  stateById: Map<ProtocolId, unknown>,
  runId: string,
  round: number,
  blockNumber: bigint,
  agentAddress: Address,
  fairPrice: number,
  balances: BalanceSnapshot,
  history: AgentObservation["history"],
  config: SimConfig,
  enabledIds: ProtocolId[],
): Promise<AgentObservation> {
  // Per-protocol observations are independent reads, so issue them in parallel. With the agent client
  // (batch=true), same-tick reads are auto-aggregated into a single Multicall3, so parallel issuance directly reduces round-trip count.
  const protocols: ProtocolObservations = {};
  await Promise.all(
    adapters.map(async (adapter) => {
      const obs = await adapter.observe(
        ctx,
        stateById.get(adapter.id),
        agentAddress,
        fairPrice,
      );
      (protocols as Record<string, unknown>)[adapter.id] = obs;
    }),
  );
  return {
    kind: "observation",
    runId,
    round,
    blockNumber: blockNumber.toString(),
    agentAddress,
    fairPriceUsdcPerWeth: fairPrice,
    oraclePrices: { wethUsd: fairPrice, usdcUsd: 1 },
    // ADR 0013: USD prices/balances of all bases. With WETH only, fairPricesUsd={WETH:fairPrice}
    // matches the existing field (backward compatible). Only strategies that look at WBTC reference it.
    fairPricesUsd: ctx.fairPrices ?? { WETH: fairPrice },
    ...(balances.bases
      ? {
          baseBalances: Object.fromEntries(
            Object.entries(balances.bases).map(([k, v]) => [k, v.toString()]),
          ),
        }
      : {}),
    // ADR 0013: decimals of each base. For unit conversion of base amounts in a process-separated agent (with WETH only, {WETH:18}).
    baseDecimals: Object.fromEntries(
      Object.keys(ctx.fairPrices ?? { WETH: fairPrice }).map((b) => [
        b,
        tokenInfo(b).decimals,
      ]),
    ),
    enabledProtocols: enabledIds,
    balances: {
      ethWei: balances.ethWei.toString(),
      wethWei: balances.wethWei.toString(),
      usdcUnits: balances.usdcUnits.toString(),
    },
    inventory: balanceToInventory(balances, fairPrice),
    history: history.slice(-20),
    limits: {
      maxWethInWei: config.maxAgentWethInWei.toString(),
      maxUsdcInUnits: config.maxAgentUsdcInUnits.toString(),
      defaultPriorityFeePerGasWei: config.defaultPriorityFeeWei.toString(),
      // Economization (ADR 0011 §2): since priority-fee cap enforcement is retired, effectively drop
      // the cap presented to the agent too (bids self-limit by opportunity value = realistic priority
      // gas auction). validateAction's pre-submit check also reads this value, so if we do not raise it
      // here high bids get silently rejected. 10^18 wei/gas is an effectively unlimited guard (only
      // rejects broken huge bids; actual spend is bound to the endowment by the EIP-1559 balance constraint).
      maxPriorityFeePerGasWei: (config.economicGas
        ? 1_000_000_000_000_000_000n
        : config.maxPriorityFeeWei
      ).toString(),
      defaultSlippageBps: 50,
      maxBundleActions: config.maxBundleActions,
      maxLpWethWei: config.maxLpWethWei.toString(),
      maxLpUsdcUnits: config.maxLpUsdcUnits.toString(),
      maxOpenPositions: config.maxOpenPositions,
      maxGmxSizeUsd: config.maxGmxSizeUsd.toString(),
      maxAaveSupplyWethWei: config.maxAaveSupplyWethWei.toString(),
      maxAaveBorrowUsdcUnits: config.maxAaveBorrowUsdcUnits.toString(),
      // ADR 0013: expose per-base caps. WETH is the existing value; additional bases come from config's per-base map (default 0).
      baseLimits: buildBaseLimits(config),
    },
    protocols,
  };
}

// ADR 0013: build the base symbol -> per-round cap map from config. WETH reuses the existing
// WETH-specific caps (byte-compatible); additional bases use the per-base values of MAX_AGENT/MAX_LP/MAX_AAVE_SUPPLY (default 0).
function buildBaseLimits(
  config: SimConfig,
): NonNullable<AgentObservation["limits"]["baseLimits"]> {
  const out: NonNullable<AgentObservation["limits"]["baseLimits"]> = {};
  const bases = new Set<string>([
    "WETH",
    ...Object.keys(config.maxAgentBaseIn),
    ...Object.keys(config.maxLpBase),
    ...Object.keys(config.maxAaveSupplyBase),
  ]);
  for (const base of bases) {
    const maxSwap =
      base === "WETH"
        ? config.maxAgentWethInWei
        : (config.maxAgentBaseIn[base] ?? 0n);
    const maxLp =
      base === "WETH" ? config.maxLpWethWei : (config.maxLpBase[base] ?? 0n);
    const maxAave =
      base === "WETH"
        ? config.maxAaveSupplyWethWei
        : (config.maxAaveSupplyBase[base] ?? 0n);
    out[base] = {
      maxSwapInBaseWei: maxSwap.toString(),
      maxLpBaseWei: maxLp.toString(),
      maxAaveSupplyBaseWei: maxAave.toString(),
    };
  }
  return out;
}
