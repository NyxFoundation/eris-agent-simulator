/**
 * read.ts: オンチェーン読取による observation 再構成（ADR 0015 runtime。旧 directShim の読取側）。
 *
 * 毎ブロック、PriceFeed の fair price・各 venue の状態・自分の残高を読み、環境と同じ形の
 * AgentObservation を組み立てる（組み立ては sdk の observationFor = 環境の採点再構成と同一契約）。
 * fair price はオンチェーン配布（ADR 0006 §3）なので情報は 1 ブロック遅れる（全員等しく作用。仕様）。
 */
import type { Address } from "viem";
import { getBalances } from "@eris/sdk/chain.js";
import { tokenInfo } from "@eris/sdk/markets.js";
import { observationFor } from "@eris/sdk/observation.js";
import { readFairPrice, readFairPriceFor } from "@eris/sdk/priceFeed.js";
import type { ProtocolAdapter, SimContext } from "@eris/sdk/protocols/types.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
} from "@eris/sdk/types.js";

export type ChainSnapshot = {
  observation: AgentObservation;
  balances: BalanceSnapshot;
  stateById: Map<ProtocolId, unknown>;
  fairPrice: number;
};

export class Reader {
  private readonly ctx: SimContext;
  private readonly adapters: ProtocolAdapter[];
  private readonly enabledIds: ProtocolId[];
  private readonly priceFeed: Address;
  private readonly address: Address;
  private readonly runId: string;
  private readonly extraBaseSymbols: string[];
  private readonly history: AgentObservation["history"] = [];

  constructor(opts: {
    ctx: SimContext;
    adapters: ProtocolAdapter[];
    priceFeed: Address;
    address: Address;
    runId: string;
    extraBaseSymbols: string[];
  }) {
    this.ctx = opts.ctx;
    this.adapters = opts.adapters;
    this.enabledIds = opts.adapters.map((a) => a.id);
    this.priceFeed = opts.priceFeed;
    this.address = opts.address;
    this.runId = opts.runId;
    this.extraBaseSymbols = opts.extraBaseSymbols;
  }

  // 当該ブロックのチェーン断面から observation を再構成する。
  async snapshot(bn: number): Promise<ChainSnapshot> {
    const { publicClient } = this.ctx;
    // 独立な読取は並列化する（2 秒ブロックの hot path。fairPrice → readState の依存だけ保つ）
    const [fairPrice, balances] = await Promise.all([
      readFairPrice(publicClient, this.priceFeed),
      getBalances(publicClient, this.address),
    ]);
    // ADR 0013: 追加 base の fair price を PriceFeed から読み ctx.fairPrices へ。これで
    // observationFor が observation.fairPricesUsd を全 base 分埋める（agent が WBTC を観測できる）。
    // adapter.observe は ctx.fairPrices?.[base] を見るため observationFor 前に必ず設定する。
    // extraBaseSymbols=[]（fork 既定）なら fairPrices={WETH} で従来と byte 一致。
    const fairPrices: Record<string, number> = { WETH: fairPrice };
    if (this.extraBaseSymbols.length > 0) {
      const extra = await Promise.all(
        this.extraBaseSymbols.map((b) =>
          readFairPriceFor(publicClient, this.priceFeed, tokenInfo(b).address),
        ),
      );
      this.extraBaseSymbols.forEach((b, i) => {
        fairPrices[b] = extra[i];
      });
    }
    this.ctx.fairPrices = fairPrices;
    const states = await Promise.all(
      this.adapters.map((adapter) => adapter.readState(this.ctx, fairPrice)),
    );
    const stateById = new Map<ProtocolId, unknown>(
      this.adapters.map((adapter, i) => [adapter.id, states[i]]),
    );
    const uni = stateById.get("uniswap") as
      { priceUsdcPerWeth?: number } | undefined;
    this.history.push({
      round: bn,
      poolPriceUsdcPerWeth: uni?.priceUsdcPerWeth ?? fairPrice,
      fairPriceUsdcPerWeth: fairPrice,
    });
    if (this.history.length > 20)
      this.history.splice(0, this.history.length - 20);
    const observation = await observationFor(
      this.ctx,
      this.adapters,
      stateById,
      this.runId,
      bn,
      BigInt(bn),
      this.address,
      fairPrice,
      balances,
      this.history,
      this.ctx.config,
      this.enabledIds,
    );
    return { observation, balances, stateById, fairPrice };
  }
}
