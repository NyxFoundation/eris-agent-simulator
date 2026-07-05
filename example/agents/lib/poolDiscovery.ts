// Dynamic discovery layer for new pools (ADR 0014 §3; channel (2): on-chain factory + reserve index).
//
// The observation the coordinator curates (obs.protocols[id]) only reflects known venues. A real
// arb/MEV bot subscribes to the factory's PoolCreated to build a pool graph, derives the implied
// price from reserves, and picks up opportunities from the gap vs fair. This is a minimal implementation:
//   - refresh(): index factory.PoolCreated via getLogs (from ERIS_VULN_FROM_BLOCK onward).
//   - findOpportunities(): read each pool's reserves and return the base's implied price vs fair gap as an opportunity.
//
// The trap lives on the contract side, so discovery alone can't tell safety (verification is in
// verifyContract.ts). The discovery layer is shared by discovery-arb / discovery-arb-verify; only the
// presence of the verification gate differs (ADR 0014 §6).
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
  base: string; // base symbol
  baseAddr: Address;
  usdcAddr: Address; // = tokenIn (buy the base with USDC)
  reserveBase: bigint;
  reserveUsdc: bigint;
  impliedPrice: number; // USDC/base derived from reserves
  fair: number;
  gapBps: number; // (fair/implied - 1)*1e4. Positive = base is cheaper than fair (buy opportunity)
  amountInUnits: bigint; // USDC to put in
};

// Minimal symbol/address/decimals info (the agent passes it from constants).
export type BaseInfo = { symbol: string; address: Address; decimals: number };

export class PoolDiscovery {
  private readonly publicClient: PublicClient;
  private readonly factory: Address;
  private readonly fromBlock: bigint;
  private readonly usdcAddr: Address;
  private readonly usdcDecimals: number;
  // base address (lowercase) -> BaseInfo.
  private readonly baseByAddr: Map<string, BaseInfo>;
  // Discovered pools (address lowercase -> DiscoveredPool). Immutable, so never overwritten.
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

  // Track and index factory.PoolCreated (getLogs only for the new range).
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

  // Read each pool's reserves and return buy opportunities whose gap vs fair exceeds the threshold.
  // fairByBase: base symbol -> fair(USD). Only treat gaps above gapThresholdBps as opportunities.
  async findOpportunities(
    fairByBase: Record<string, number>,
    amountInUnits: bigint,
    gapThresholdBps: number,
  ): Promise<PoolOpportunity[]> {
    const out: PoolOpportunity[] = [];
    for (const pool of this.pools.values()) {
      // Determine the base side (whichever of token0/token1 is not USDC). Skip if both are USDC/unknown.
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
      if (reserveBase <= 0n || reserveUsdc <= 0n) continue; // unsupplied (0) is not an opportunity

      const impliedPrice = this.impliedPrice(
        reserveBase,
        reserveUsdc,
        baseInfo.decimals,
      );
      if (impliedPrice <= 0) continue;
      const gapBps = (fair / impliedPrice - 1) * 10_000;
      if (gapBps < gapThresholdBps) continue; // only buy when the base is cheaper than fair

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
    // Return opportunities largest-gap first.
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
    // USDC/base = (reserveUsdc/10^usdcDec) / (reserveBase/10^baseDec).
    const usdcHuman = Number(reserveUsdc) / 10 ** this.usdcDecimals;
    const baseHuman = Number(reserveBase) / 10 ** baseDecimals;
    if (baseHuman === 0) return 0;
    return usdcHuman / baseHuman;
  }
}
