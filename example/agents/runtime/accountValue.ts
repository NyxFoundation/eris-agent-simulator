/**
 * accountValue.ts: what the agent is worth, wallet and venues together (issue #274).
 *
 * The observation's `inventory.valueUsdc` is the wallet. The revision context used it as the PnL,
 * so collateral posted to GMX or supplied to Aave was shown to the model as money lost -- thousands
 * of USDC -- and every submitted agent revises (rules §2.5), so every model read it. The summary's
 * value is the wallet plus each venue's `adapter.valueUsdc` (coordinator.ts, the end-of-run PnL);
 * this computes the same sum from the agent's side, with the same adapters.
 *
 * Off the trading path on purpose. The venue reads are a second pass over the chain, and a
 * self-improving agent's trading loop is meant to be exactly as fast as a rule agent's (ADR 0018).
 * So the block loop hands the snapshot over without waiting; one valuation is in flight at a time,
 * and a block that arrives while one is running is not valued at all.
 *
 * A partial total is worse than none: when any venue's read fails, the block has no value, rather
 * than a value that is missing that venue -- which is the hole this file exists to close.
 */
import type { Address } from "viem";
import type { ProtocolAdapter, SimContext } from "@eris/sdk/protocols/types.js";
import type { ChainSnapshot } from "./read.js";

export type AccountMark = {
  block: number;
  // Wallet plus every venue.
  valueUsdc: number;
  // The venue part alone: how much of the value sat outside the wallet at this block.
  venuesUsdc: number;
};

export class AccountValue {
  private inFlight = false;
  private firstMark: AccountMark | null = null;
  private latestMark: AccountMark | null = null;

  constructor(
    private readonly opts: {
      ctx: SimContext;
      adapters: ProtocolAdapter[];
      address: Address;
      onError?: (block: number, venue: string, error: unknown) => void;
    },
  ) {}

  /// The first block that was valued: the baseline of "PnL since the run started".
  first(): AccountMark | null {
    return this.firstMark;
  }

  latest(): AccountMark | null {
    return this.latestMark;
  }

  /// Value one block's snapshot. Null when the block was skipped because a valuation was still
  /// running, when the observation carried no wallet value, or when a venue read failed.
  async mark(block: number, snap: ChainSnapshot): Promise<AccountMark | null> {
    const wallet = snap.observation.inventory?.valueUsdc;
    if (this.inFlight || typeof wallet !== "number" || !Number.isFinite(wallet))
      return null;
    this.inFlight = true;
    try {
      // This block's fair prices, copied: the next block's snapshot rewrites ctx.fairPrices while
      // these reads may still be out.
      const ctx: SimContext = {
        ...this.opts.ctx,
        fairPrices: { ...snap.observation.fairPricesUsd },
      };
      const values = await Promise.all(
        this.opts.adapters.map(async (adapter) => {
          try {
            return await adapter.valueUsdc(
              ctx,
              this.opts.address,
              snap.stateById.get(adapter.id),
              snap.fairPrice,
            );
          } catch (error) {
            this.opts.onError?.(block, adapter.id, error);
            return null;
          }
        }),
      );
      let venuesUsdc = 0;
      for (const v of values) {
        if (v === null || !Number.isFinite(v)) return null;
        venuesUsdc += v;
      }
      const mark: AccountMark = {
        block,
        valueUsdc: wallet + venuesUsdc,
        venuesUsdc,
      };
      this.firstMark ??= mark;
      if (!this.latestMark || block > this.latestMark.block)
        this.latestMark = mark;
      return mark;
    } finally {
      this.inFlight = false;
    }
  }
}
