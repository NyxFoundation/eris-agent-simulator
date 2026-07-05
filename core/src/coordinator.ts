// The synchronous-round approach (runSimulation) was retired in ADR 0006. This file holds only the
// environment-side shared functions for flow/submit (buildFlowContext / submit* / initialFairPrice*,
// etc., used by the realtime coordinator). observationFor has moved to sdk (@eris/sdk/observation.js) (ADR 0015).
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { accountAddress, getBalances } from "@eris/sdk/chain.js";
import type { ProtocolId, RawTxIntent, TxIntent } from "@eris/sdk/types.js";
import { baseTokens } from "@eris/sdk/markets.js";
import { enabledAdapters } from "@eris/sdk/protocols/registry.js";
import type { FlowKind, SimContext } from "@eris/sdk/protocols/types.js";
import { FlowProcess, type FlowOrderWire } from "./flowProcess.js";
import type { FlowContextWire } from "./flow/logic.js";
import { readAaveFlowReserves } from "@eris/sdk/protocols/aave.js";

// ---------------------------------------------------------------------------
// observation / flow / submit
// ---------------------------------------------------------------------------

// Pass a FlowContext to the orderflow bot process, receive FlowOrder[], and convert to TxIntent.
// The coordinator owns flow wallet selection and tx submission (the bot only decides orders).
// Assemble the FlowContext (poolPrices / aave reserves / limits). Reused every block in realtime too.
export async function buildFlowContext(
  ctx: SimContext,
  enabledIds: ProtocolId[],
  stateById: Map<ProtocolId, unknown>,
  fairPrice: number,
  round: number,
): Promise<FlowContextWire> {
  const poolPrices: Partial<Record<"uniswap" | "balancer" | "curve", number>> =
    {};
  for (const id of ["uniswap", "balancer", "curve"] as const) {
    if (!enabledIds.includes(id)) continue;
    const s = stateById.get(id) as { priceUsdcPerWeth?: number } | undefined;
    if (s && typeof s.priceUsdcPerWeth === "number")
      poolPrices[id] = s.priceUsdcPerWeth;
  }

  // The aave borrower pool depends on each actor wallet's reserve + balance. The coordinator does the
  // RPC reads and passes them in (the bot never touches the RPC). Read each actor's persistent position
  // (supply/borrow) and balance.
  let aaveActors: FlowContextWire["aaveActors"];
  if (enabledIds.includes("aave")) {
    aaveActors = [];
    for (let i = 0; i < ctx.config.aaveFlowActorCount; i++) {
      const key = `aave:actor${i}`;
      const wallet = ctx.flowWalletByKey(key);
      const r = await readAaveFlowReserves(ctx.publicClient, wallet.address);
      const b = await getBalances(ctx.publicClient, wallet.address);
      aaveActors.push({
        key,
        wethSupplied: r.wethSupplied.toString(),
        usdcBorrowed: r.usdcBorrowed.toString(),
        wethWei: b.wethWei.toString(),
        usdcUnits: b.usdcUnits.toString(),
      });
    }
  }
  const flowBalances: FlowContextWire["flowBalances"] = {};
  for (const protocol of enabledIds) {
    for (const kind of ["informed", "uninformed"] as FlowKind[]) {
      const wallet = ctx.flowWallet(protocol, kind);
      const b = await getBalances(ctx.publicClient, wallet.address);
      flowBalances[`${protocol}:${kind}`] = {
        wethWei: b.wethWei.toString(),
        usdcUnits: b.usdcUnits.toString(),
      };
    }
  }

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
    ...(aaveActors ? { aaveActors } : {}),
    flowBalances,
    // If flow holds base inventory (flowWethWei>0), allow selling (gated by balance).
    // Independent of the agent's USDC-only (initialWethWei=0). Force USDC only when both are 0.
    usdcOnlyFlow:
      ctx.config.initialWethWei === 0n && ctx.config.flowWethWei === 0n,
    ...(extraBases.length > 0 ? { extraBases } : {}),
    limits: {
      uninformedFlowMaxWethWei: ctx.config.uninformedFlowMaxWethWei.toString(),
      uninformedFlowCountPerBlock: String(ctx.config.uninformedFlowCount),
      uninformedFlowPersistBlocks: String(
        ctx.config.uninformedFlowPersistBlocks,
      ),
      informedFlowMaxWethWei: ctx.config.informedFlowMaxWethWei.toString(),
      balancerFlowMaxWethWei: ctx.config.balancerFlowMaxWethWei.toString(),
      curveFlowMaxWethWei: ctx.config.curveFlowMaxWethWei.toString(),
      gmxFlowMaxSizeUsd: ctx.config.gmxFlowMaxSizeUsd.toString(),
      gmxFlowActivityProb: String(ctx.config.gmxFlowActivityProb),
      gmxFlowMaxBurst: String(ctx.config.gmxFlowMaxBurst),
      aaveFlowMaxWethWei: ctx.config.aaveFlowMaxWethWei.toString(),
      maxAaveBorrowUsdcUnits: ctx.config.maxAaveBorrowUsdcUnits.toString(),
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

export async function submitRawTxIntent(
  ctx: SimContext,
  intent: RawTxIntent,
): Promise<Hex> {
  const account = privateKeyToAccount(intent.privateKey);
  const block = await ctx.publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? 0n;
  return ctx.walletClient.sendTransaction({
    account,
    chain: ctx.chain,
    to: intent.rawTx.to as Address,
    data: intent.rawTx.data as Hex,
    value: intent.rawTx.value ? BigInt(intent.rawTx.value) : 0n,
    maxFeePerGas: baseFee + intent.priorityFeeWei,
    maxPriorityFeePerGas: intent.priorityFeeWei,
  });
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
