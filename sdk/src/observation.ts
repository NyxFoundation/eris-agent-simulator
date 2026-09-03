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
import { tokenInfo, tokenInfoByAddress } from "./markets.js";
import {
  readStablePrices,
  stableKeyFor,
  stablePriceUsdc,
  type StablePrices,
} from "./stables.js";
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
  // Issue #27: what each market-priced stable is worth right now. Read alongside the venues so it
  // rides the same batch, and so the agent's own inventory total agrees with the scorer's.
  const stablePricesPromise = readStablePrices(
    ctx.publicClient,
    Object.keys(balances.stables ?? {}) as Address[],
  );
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
  const stablePrices = await stablePricesPromise;
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
      ...(balances.stables
        ? { stables: buildStableBalances(balances.stables, stablePrices) }
        : {}),
    },
    inventory: balanceToInventory(balances, fairPrice, stablePrices),
    history: history.slice(-20),
    // No order-size caps: the competition removed them outright rather than raising them, so the
    // only thing bounding a trade is the balance behind it. What is left here is the fee/slippage
    // defaults the runtime needs when the action does not name its own.
    limits: {
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
    },
    protocols,
  };
}

// The per-stable breakdown an agent sizes and marks against (issue #27 (a) step 1). Keyed by
// registry symbol so a strategy can name the stable it wants; the raw address rides along because
// per-venue validation checks that.
function buildStableBalances(
  stables: Record<string, bigint>,
  prices: StablePrices,
): NonNullable<AgentObservation["balances"]["stables"]> {
  const quoted = new Set(
    prices.quotes.filter((q) => q.quoted).map((q) => q.token.toLowerCase()),
  );
  const out: NonNullable<AgentObservation["balances"]["stables"]> = {};
  for (const [token, balance] of Object.entries(stables)) {
    const address = token as Address;
    // The fork's USDC.e / USD₮0 are outside the registry and 6-decimal by the same convention that
    // makes them dollars.
    const decimals = tokenInfoByAddress(address)?.decimals ?? 6;
    out[stableKeyFor(address)] = {
      token,
      decimals,
      balance: balance.toString(),
      priceUsdc: stablePriceUsdc(prices, address),
      marketQuoted: quoted.has(token.toLowerCase()),
    };
  }
  return out;
}
