// 新規プールの動的発見レイヤ（ADR 0014 §3。チャネル(2): オンチェーン factory + reserve インデックス）。
//
// coordinator が curate した観測（obs.protocols[id]）は既知 venue しか映さない。実際の arb/MEV bot は
// factory の PoolCreated を購読してプールグラフを作り、reserve から含意価格を出して fair との gap で
// 機会を拾う。ここはその最小実装:
//   - refresh(): factory.PoolCreated を getLogs（ERIS_VULN_FROM_BLOCK 以降）でインデックス。
//   - findOpportunities(): 各プールの reserve を読み、base の含意価格 vs fair の gap を機会として返す。
//
// 罠は契約側にあるので発見だけでは安全性は分からない（検証は verifyContract.ts）。発見レイヤは
// discovery-arb / discovery-arb-verify で共通、検証ゲートの有無だけが違う（ADR 0014 §6）。
import type { Address, PublicClient } from "viem";
import { erc20ApproveAbi, vulnFactoryAbi } from "./vulnAbi.js";

export type DiscoveredPool = {
  address: Address;
  token0: Address;
  token1: Address;
  feeBps: number;
};

export type PoolOpportunity = {
  pool: DiscoveredPool;
  base: string; // base シンボル
  baseAddr: Address;
  usdcAddr: Address; // = tokenIn（base を USDC で買う）
  reserveBase: bigint;
  reserveUsdc: bigint;
  impliedPrice: number; // reserve 由来の USDC/base
  fair: number;
  gapBps: number; // (fair/implied - 1)*1e4。正 = base が fair より割安（買い機会）
  amountInUnits: bigint; // 投じる USDC
};

// symbol/address/decimals の最小情報（agent が constants から渡す）。
export type BaseInfo = { symbol: string; address: Address; decimals: number };

export class PoolDiscovery {
  private readonly publicClient: PublicClient;
  private readonly factory: Address;
  private readonly fromBlock: bigint;
  private readonly usdcAddr: Address;
  private readonly usdcDecimals: number;
  // base アドレス（lowercase）→ BaseInfo。
  private readonly baseByAddr: Map<string, BaseInfo>;
  // 発見済みプール（address lowercase → DiscoveredPool）。immutable なので上書きしない。
  private readonly pools = new Map<string, DiscoveredPool>();
  private lastScanned: bigint;

  constructor(opts: {
    publicClient: PublicClient;
    factory: Address;
    fromBlock: bigint;
    usdcAddr: Address;
    usdcDecimals: number;
    bases: BaseInfo[];
  }) {
    this.publicClient = opts.publicClient;
    this.factory = opts.factory;
    this.fromBlock = opts.fromBlock;
    this.usdcAddr = opts.usdcAddr;
    this.usdcDecimals = opts.usdcDecimals;
    this.baseByAddr = new Map(
      opts.bases.map((b) => [b.address.toLowerCase(), b]),
    );
    this.lastScanned = opts.fromBlock - 1n;
  }

  poolCount(): number {
    return this.pools.size;
  }

  // factory.PoolCreated を追跡インデックスする（新規ぶんだけ getLogs）。
  async refresh(latestBlock: bigint): Promise<void> {
    const from = this.lastScanned + 1n;
    if (from > latestBlock) return;
    const logs = await this.publicClient.getLogs({
      address: this.factory,
      event: vulnFactoryAbi[0],
      fromBlock: from < this.fromBlock ? this.fromBlock : from,
      toBlock: latestBlock,
    });
    for (const log of logs) {
      const a = log.args as {
        pool?: Address;
        token0?: Address;
        token1?: Address;
        feeBps?: number;
      };
      if (!a.pool || !a.token0 || !a.token1) continue;
      const key = a.pool.toLowerCase();
      if (this.pools.has(key)) continue;
      this.pools.set(key, {
        address: a.pool,
        token0: a.token0,
        token1: a.token1,
        feeBps: Number(a.feeBps ?? 0),
      });
    }
    this.lastScanned = latestBlock;
  }

  // 各プールの reserve を読み、fair との gap が閾値を超える買い機会を返す。
  // fairByBase: base シンボル → fair(USD)。gapThresholdBps 超だけ機会とみなす。
  async findOpportunities(
    fairByBase: Record<string, number>,
    amountInUnits: bigint,
    gapThresholdBps: number,
  ): Promise<PoolOpportunity[]> {
    const out: PoolOpportunity[] = [];
    for (const pool of this.pools.values()) {
      // base 側を判定（token0/token1 のうち USDC でない方）。両方 USDC/未知はスキップ。
      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      const usdc = this.usdcAddr.toLowerCase();
      let baseInfo: BaseInfo | undefined;
      if (t1 === usdc) baseInfo = this.baseByAddr.get(t0);
      else if (t0 === usdc) baseInfo = this.baseByAddr.get(t1);
      if (!baseInfo) continue;
      const fair = fairByBase[baseInfo.symbol];
      if (!fair || fair <= 0) continue;

      const [reserveBase, reserveUsdc] = await this.readReserves(
        pool.address,
        baseInfo.address,
      );
      if (reserveBase <= 0n || reserveUsdc <= 0n) continue; // 未供給（0）は機会でない

      const impliedPrice = this.impliedPrice(
        reserveBase,
        reserveUsdc,
        baseInfo.decimals,
      );
      if (impliedPrice <= 0) continue;
      const gapBps = (fair / impliedPrice - 1) * 10_000;
      if (gapBps < gapThresholdBps) continue; // base が fair より割安なときだけ買う

      out.push({
        pool,
        base: baseInfo.symbol,
        baseAddr: baseInfo.address,
        usdcAddr: this.usdcAddr,
        reserveBase,
        reserveUsdc,
        impliedPrice,
        fair,
        gapBps,
        amountInUnits,
      });
    }
    // gap の大きい機会から返す。
    out.sort((a, b) => b.gapBps - a.gapBps);
    return out;
  }

  private async readReserves(
    pool: Address,
    baseAddr: Address,
  ): Promise<[bigint, bigint]> {
    const [base, usdc] = await Promise.all([
      this.balanceOf(baseAddr, pool),
      this.balanceOf(this.usdcAddr, pool),
    ]);
    return [base, usdc];
  }

  private async balanceOf(token: Address, holder: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token,
      abi: erc20ApproveAbi,
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;
  }

  private impliedPrice(
    reserveBase: bigint,
    reserveUsdc: bigint,
    baseDecimals: number,
  ): number {
    // USDC/base = (reserveUsdc/10^usdcDec) / (reserveBase/10^baseDec)。
    const usdcHuman = Number(reserveUsdc) / 10 ** this.usdcDecimals;
    const baseHuman = Number(reserveBase) / 10 ** baseDecimals;
    if (baseHuman === 0) return 0;
    return usdcHuman / baseHuman;
  }
}
