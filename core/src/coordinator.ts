// 同期ラウンド方式（runSimulation）は ADR 0006 で退役済み。本ファイルは flow/submit の
// 環境側共有関数のみ（buildFlowContext / submit* / initialFairPrice* 等。realtime coordinator が
// 利用する）。observationFor は sdk（@eris/sdk/observation.js）へ移設済み（ADR 0015）。
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
// 観測 / flow / submit
// ---------------------------------------------------------------------------

// orderflow bot プロセスに FlowContext を渡して FlowOrder[] を受け取り、TxIntent に変換する。
// flow ウォレットの選択と tx 提出は coordinator が所有（bot は注文を決めるだけ）。
// FlowContext を組み立てる（poolPrices / aave reserves / limits）。realtime でも毎ブロック再利用する。
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

  // aave 借り手プールは各 actor ウォレットの reserve + 残高に依存する。RPC 読取は coordinator 側で
  // 行い渡す（bot は RPC に触れない原則）。actor ごとに持続ポジション（supply/borrow）と残高を読む。
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

  // ADR 0013 Phase 8: WETH 以外の base の AMM flow context。flow max>0 かつ価格が揃う base のみ
  // 載せる（max=0/未設定なら省略 → buildFlowOrders が当該 base を反復せず RNG 非消費 = byte 互換）。
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
    // flow が base 在庫を持つ（flowWethWei>0）なら売りを許可する（残高で gate）。
    // agent の USDC-only（initialWethWei=0）とは独立。両方 0 のときだけ強制 USDC。
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
      defaultPriorityFeeWei: ctx.config.defaultPriorityFeeWei.toString(),
    },
  };
}

// bot が返した FlowOrder[] を flow ウォレット紐付けの TxIntent[] に変換する。
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

// orderflow bot プロセスに FlowContext を渡して FlowOrder[] を受け取り、TxIntent に変換する。
// flow ウォレットの選択と tx 提出は coordinator が所有（bot は注文を決めるだけ）。
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
    // 実時間 mining では「submit 時の状態」で見積もった gas と「実行時の状態」がズレる。
    // eth_estimateGas は成功する最小 gas を返すため、Aave の利息 index 更新等で実 gas が
    // 最小見積りを少し上回ると out-of-gas revert する（flow tx 失敗の主因）。2x のバッファを
    // 明示指定して防ぐ（gas コストは使用量課金で上限は着弾保証。block gas 上限内に十分収まる）。
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

// ADR 0013: 追加 base（WBTC 等）の初期 fair price。uniswap の当該 market pool 価格を採用し、
// 無ければ既定（WBTC=60000）。WETH は従来の initialFairPrice にフォールバック。
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
