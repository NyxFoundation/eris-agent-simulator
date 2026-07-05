/**
 * read.ts: observation reconstruction via on-chain reads (ADR 0015 runtime; the read side of the old directShim).
 *
 * Each block, read the PriceFeed's fair price, each venue's state, and your own balances, and
 * assemble an AgentObservation of the same shape as the environment's (the assembly uses sdk's
 * observationFor = the same contract as the environment's scoring reconstruction). Fair price is
 * distributed on-chain (ADR 0006 §3), so the information is one block behind (applies to everyone equally; by design).
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

  // Reconstruct the observation from this block's chain snapshot.
  async snapshot(bn: number): Promise<ChainSnapshot> {
    const { publicClient } = this.ctx;
    // Parallelize independent reads (2-second block hot path; only keep the fairPrice -> readState dependency)
    const [fairPrice, balances] = await Promise.all([
      readFairPrice(publicClient, this.priceFeed),
      getBalances(publicClient, this.address),
    ]);
    // ADR 0013: read the extra bases' fair prices from the PriceFeed into ctx.fairPrices. This lets
    // observationFor fill observation.fairPricesUsd for all bases (so the agent can observe WBTC).
    // adapter.observe looks at ctx.fairPrices?.[base], so it must be set before observationFor.
    // With extraBaseSymbols=[] (the fork default), fairPrices={WETH} is byte-identical to the legacy path.
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
