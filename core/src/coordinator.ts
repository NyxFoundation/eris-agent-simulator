// The synchronous-round approach (runSimulation) was retired in ADR 0006. This file holds only the
// environment-side shared functions for flow/submit (buildFlowContext / submit* / initialFairPrice*,
// etc., used by the realtime coordinator). observationFor has moved to sdk (@eris/sdk/observation.js) (ADR 0015).
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { accountAddress, getBalances } from "@eris/sdk/chain.js";
import type { ProtocolId, TxIntent } from "@eris/sdk/types.js";
import { baseTokens } from "@eris/sdk/markets.js";
import { enabledAdapters, getAdapter } from "@eris/sdk/protocols/registry.js";
import type { FlowKind, SimContext } from "@eris/sdk/protocols/types.js";
import { FlowProcess, type FlowOrderWire } from "./flowProcess.js";
import type { FlowTrendOverride } from "./realtime/events.js";
import type { FlowContextWire } from "./flow/logic.js";
import { readAaveFlowReserves } from "@eris/sdk/protocols/aave.js";
import { stableBalanceOf, TOKENS } from "@eris/sdk/constants.js";

// The stable a venue actually trades against. usdcUnits used to be every stable summed, which was a
// serviceable stand-in for it; since issue #27 narrowed that field to native USDC, a flow bot on
// Balancer's USDC.e leg would have sized against a balance it was not spending.
function venueStableUnits(
  protocol: ProtocolId,
  balances: Parameters<typeof stableBalanceOf>[0],
): bigint {
  return stableBalanceOf(
    balances,
    getAdapter(protocol).stableToken ?? TOKENS.USDC.address,
  );
}

// ---------------------------------------------------------------------------
// observation / flow / submit
// ---------------------------------------------------------------------------

// Pass a FlowContext to the orderflow bot process, receive FlowOrder[], and convert to TxIntent.
// The coordinator owns flow wallet selection and tx submission (the bot only decides orders).
// Assemble the FlowContext (poolPrices / aave reserves / limits). Reused every block in realtime too.
// Scale a wei cap by a float multiplier without leaving bigint arithmetic. Rounded to the nearest
// wei via basis points: the multiplier comes from an event envelope, so it is a smooth ramp and the
// rounding never accumulates.
function scaleWei(value: bigint, mult: number): bigint {
  if (mult === 1) return value;
  return (value * BigInt(Math.round(mult * 10_000))) / 10_000n;
}

export async function buildFlowContext(
  ctx: SimContext,
  enabledIds: ProtocolId[],
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
  round: number,
  // A flowTrend episode's effect on this block's uninformed flow (issue #56). Omitted = no episode
  // is open, which is also what every non-realtime caller passes.
  flowTrend?: FlowTrendOverride,
): Promise<FlowContextWire> {
  const poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>> =
    {};
  for (const id of ["uniswap", "balancer", "curve"] as const) {
    if (!enabledIds.includes(id)) continue;
    const s = stateById.get(id) as { priceUsdcPerWeth?: number } | undefined;
    if (s && typeof s.priceUsdcPerWeth === "number")
      poolPrices[id] = s.priceUsdcPerWeth;
  }

  // Every read below is independent -- one wallet's balance says nothing about another's -- so they
  // are issued together rather than in a chain of awaits.
  //
  // This is the environment loop's bottleneck, and it is a latency problem rather than a workload
  // one. The client batches contract reads into Multicall3 (`batch: true`), but only within a single
  // await: a sequential loop over 8 flow wallets and 4 aave actors is ~16 round trips no matter how
  // well each one batches. Measured at 4ms per round trip on an idle chain (60ms per block, fine)
  // and ~20ms once agents were active enough to keep anvil's execution queue busy -- 331ms per
  // block against a 2s budget, which cost 43 blocks of a 504-block run (issue #56).
  const aaveActorKeys = enabledIds.includes("aave")
    ? Array.from(
        { length: ctx.config.aaveFlowActorCount },
        (_, i) => `aave:actor${i}`,
      )
    : [];
  const flowWalletRefs = enabledIds.flatMap((protocol) =>
    (["informed", "uninformed"] as FlowKind[]).map((kind) => ({
      protocol,
      kind,
    })),
  );
  const [aaveActorReads, flowWalletBalances] = await Promise.all([
    Promise.all(
      aaveActorKeys.map(async (key) => {
        const wallet = ctx.flowWalletByKey(key);
        const [reserves, balances] = await Promise.all([
          readAaveFlowReserves(ctx.publicClient, wallet.address),
          getBalances(ctx.publicClient, wallet.address),
        ]);
        return { key, reserves, balances };
      }),
    ),
    Promise.all(
      flowWalletRefs.map(({ protocol, kind }) =>
        getBalances(ctx.publicClient, ctx.flowWallet(protocol, kind).address),
      ),
    ),
  ]);
  const aaveActors: FlowContextWire["aaveActors"] = enabledIds.includes("aave")
    ? aaveActorReads.map(({ key, reserves, balances }) => ({
        key,
        wethSupplied: reserves.wethSupplied.toString(),
        usdcBorrowed: reserves.usdcBorrowed.toString(),
        wethWei: balances.wethWei.toString(),
        usdcUnits: venueStableUnits("aave", balances).toString(),
      }))
    : undefined;
  const flowBalances: FlowContextWire["flowBalances"] = {};
  flowWalletRefs.forEach(({ protocol, kind }, i) => {
    const b = flowWalletBalances[i];
    flowBalances[`${protocol}:${kind}`] = {
      wethWei: b.wethWei.toString(),
      usdcUnits: venueStableUnits(protocol, b).toString(),
    };
  });

  // ADR 0013 Phase 8: AMM flow context for non-WETH bases. Only include bases whose flow max > 0 and
  // whose price is available (omit when max=0/unset -> buildFlowOrders doesn't iterate that base and
  // consumes no RNG = byte-compatible).
  const extraBases: NonNullable<FlowContextWire["extraBases"]> = [];
  for (const t of baseTokens()) {
    if (t.symbol === "WETH") continue;
    const max = ctx.config.baseFlowMax?.[t.symbol] ?? 0n;
    if (max <= 0n) continue;
    const basePoolPrices: NonNullable<
      FlowContextWire["extraBases"]
    >[number]["poolPrices"] = {};
    for (const id of ["uniswap", "balancer", "curve"] as const) {
      if (!enabledIds.includes(id)) continue;
      const s = stateById.get(id) as
        | {
            markets?: Array<{
              market: { base: string };
              priceUsdcPerWeth: number;
            }>;
          }
        | undefined;
      const ms = s?.markets?.find((m) => m.market.base === t.symbol);
      if (
        ms &&
        typeof ms.priceUsdcPerWeth === "number" &&
        ms.priceUsdcPerWeth > 0
      )
        basePoolPrices[id] = ms.priceUsdcPerWeth;
    }
    const fairPriceUsd = ctx.fairPrices?.[t.symbol] ?? 0;
    if (fairPriceUsd <= 0 || Object.keys(basePoolPrices).length === 0) continue;
    const maxStr = max.toString();
    extraBases.push({
      base: t.symbol,
      poolPrices: basePoolPrices,
      fairPriceUsd,
      uninformedFlowMaxBaseWei: maxStr,
      informedFlowMaxBaseWei: maxStr,
      balancerFlowMaxBaseWei: maxStr,
      curveFlowMaxBaseWei: maxStr,
    });
  }

  return {
    round,
    fairPriceUsdcPerWeth: fairPrice,
    protocols: enabledIds,
    poolPrices,
    // The persisted uninformed trend derives its direction from this rather than from the shared
    // RNG stream (which would shift every downstream draw). Without it the direction would be a
    // function of the block window alone -- identical on every seed, and therefore memorizable.
    flowSeed: ctx.config.flowSeed,
    ...(aaveActors ? { aaveActors } : {}),
    flowBalances,
    // If flow holds base inventory (flowWethWei>0), allow selling (gated by balance).
    // Independent of the agent's USDC-only (initialWethWei=0). Force USDC only when both are 0.
    usdcOnlyFlow:
      ctx.config.initialWethWei === 0n && ctx.config.flowWethWei === 0n,
    ...(extraBases.length > 0 ? { extraBases } : {}),
    limits: {
      // The three uninformed-flow knobs are the ones a flowTrend episode leans on: how big the
      // orders are, how long a direction is held, and whether the venues lean together. The bot
      // reads them off the wire every block, so an episode is expressed by sending different
      // numbers rather than by teaching the bot about events.
      uninformedFlowMaxWethWei: scaleWei(
        ctx.config.uninformedFlowMaxWethWei,
        flowTrend?.sizeMult ?? 1,
      ).toString(),
      uninformedFlowCountPerBlock: String(ctx.config.uninformedFlowCount),
      uninformedFlowPersistBlocks: String(
        flowTrend?.persistBlocks ?? ctx.config.uninformedFlowPersistBlocks,
      ),
      uninformedFlowTrendCorrelation: String(
        flowTrend?.trendCorrelation ??
          ctx.config.uninformedFlowTrendCorrelation,
      ),
      informedFlowMaxWethWei: ctx.config.informedFlowMaxWethWei.toString(),
      balancerFlowMaxWethWei: ctx.config.balancerFlowMaxWethWei.toString(),
      curveFlowMaxWethWei: ctx.config.curveFlowMaxWethWei.toString(),
      gmxFlowMaxSizeUsd: ctx.config.gmxFlowMaxSizeUsd.toString(),
      gmxFlowActivityProb: String(ctx.config.gmxFlowActivityProb),
      gmxFlowMaxBurst: String(ctx.config.gmxFlowMaxBurst),
      aaveFlowMaxWethWei: ctx.config.aaveFlowMaxWethWei.toString(),
      aaveFlowBorrowUsdcUnits: ctx.config.aaveFlowBorrowUsdcUnits.toString(),
      aaveFlowActivityProb: String(ctx.config.aaveFlowActivityProb),
      informedArbFeeBps: String(ctx.config.informedArbFeeBps),
      uninformedArrivalRate: String(ctx.config.uninformedFlowArrivalRate),
      uninformedSizeSigma: String(ctx.config.uninformedFlowSizeSigma),
      gmxArrivalRate: String(ctx.config.gmxFlowArrivalRate),
      gmxSizeSigma: String(ctx.config.gmxFlowSizeSigma),
      aaveActorSizeSigma: String(ctx.config.aaveFlowActorSizeSigma),
      defaultPriorityFeeWei: ctx.config.defaultPriorityFeeWei.toString(),
    },
  };
}

// Convert the FlowOrder[] returned by the bot into TxIntent[] bound to flow wallets.
export function flowOrdersToIntents(
  ctx: SimContext,
  orders: FlowOrderWire[],
): TxIntent[] {
  const intents: TxIntent[] = [];
  for (const order of orders) {
    const wallet = order.walletKey
      ? ctx.flowWalletByKey(order.walletKey)
      : ctx.flowWallet(order.walletProtocol ?? order.protocol, order.kind);
    intents.push({
      ownerId: wallet.id,
      role: order.kind === "informed" ? "informed-flow" : "uninformed-flow",
      privateKey: wallet.privateKey,
      protocol: order.protocol,
      action: order.action,
      priorityFeeWei: BigInt(order.priorityFeeWei),
      gmxOrder: order.protocol === "gmx",
    });
  }
  return intents;
}

// Pass a FlowContext to the orderflow bot process, receive FlowOrder[], and convert to TxIntent.
// The coordinator owns flow wallet selection and tx submission (the bot only decides orders).
export async function requestFlowIntents(
  ctx: SimContext,
  flowProcess: FlowProcess,
  enabledIds: ProtocolId[],
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
  round: number,
  timeoutMs: number,
): Promise<TxIntent[]> {
  const context = await buildFlowContext(
    ctx,
    enabledIds,
    stateById,
    fairPrice,
    round,
  );
  const orders = await flowProcess.requestOrders(context, timeoutMs);
  return flowOrdersToIntents(ctx, orders);
}

export async function submitIntent(
  ctx: SimContext,
  intent: TxIntent,
  stateById: Map<ProtocolId, unknown>,
): Promise<Hex[]> {
  const adapter = enabledAdapters().find((a) => a.id === intent.protocol);
  if (!adapter) throw new Error(`adapter not enabled: ${intent.protocol}`);
  const owner = accountAddress(intent.privateKey);
  const txs = await adapter.buildTxs(
    ctx,
    owner,
    intent.action,
    stateById.get(intent.protocol),
  );
  const account = privateKeyToAccount(intent.privateKey);
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  const hashes: Hex[] = [];
  for (const tx of txs) {
    // Under realtime mining, gas estimated at "submit-time state" diverges from "execution-time state".
    // eth_estimateGas returns the minimum gas that succeeds, so when actual gas slightly exceeds the
    // minimum estimate (e.g. Aave interest index updates), it reverts out-of-gas (the main cause of flow
    // tx failures). Prevent this by explicitly specifying a 2x buffer (gas is charged by usage and the cap
    // guarantees landing; it fits comfortably within the block gas limit).
    let gas: bigint;
    try {
      const est = await ctx.publicClient.estimateGas({
        account,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
      });
      gas = est * 2n;
    } catch {
      gas = 2_000_000n;
    }
    const hash = await ctx.walletClient.sendTransaction({
      account,
      chain: ctx.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      gas,
      maxFeePerGas: baseFee + intent.priorityFeeWei,
      maxPriorityFeePerGas: intent.priorityFeeWei,
    });
    hashes.push(hash);
  }
  return hashes;
}

export async function initialFairPrice(
  ctx: SimContext,
  enabledIds: ProtocolId[],
): Promise<number> {
  if (enabledIds.includes("uniswap")) {
    const { getPoolPriceUsdcPerWeth } =
      await import("@eris/sdk/protocols/uniswap.js");
    return getPoolPriceUsdcPerWeth(ctx.publicClient);
  }
  return 3000;
}

// ADR 0013: initial fair price for an additional base (WBTC, etc.). Uses that base's uniswap market
// pool price, or the default (WBTC=60000) if unavailable. WETH falls back to the usual initialFairPrice.
export async function initialFairPriceFor(
  ctx: SimContext,
  base: string,
  enabledIds: ProtocolId[],
): Promise<number> {
  if (base === "WETH") return initialFairPrice(ctx, enabledIds);
  if (enabledIds.includes("uniswap")) {
    const { getPoolState } = await import("@eris/sdk/protocols/uniswap.js");
    const s = await getPoolState(ctx.publicClient);
    const m = s.markets.find((ms) => ms.market.base === base);
    if (m) return m.priceUsdcPerWeth;
  }
  return base === "WBTC" ? 60000 : 3000;
}
