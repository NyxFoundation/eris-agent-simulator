// market-taker (issue #40 T7): the user.
//
// It does not create anything. It reads the registry, picks the markets somebody else built, and
// uses them — and the only reason it is interesting is *which* ones it picks and *when* it leaves.
//
// The rule it plays by is the round-trip rule stated as a strategy: **borrow only what you can
// repay before the bell, and supply only where you can withdraw before it.** Under that rule the
// honeypot, the owner drain and the proxy swap-out are all the same mistake, so there is one exit
// deadline rather than four defences.
//
// What it gates on, in order:
//   1. `verified` — the venue's implementation is the environment's, so the shape is known.
//   2. the oracle cannot be moved (`oracleOwner == 0x0`). In a market whose creator owns the oracle,
//      the creator decides when you are liquidated.
//   3. the code has not changed since the registry recorded it.
//   4. it is not this agent's own market (trading with yourself is a transfer, not a trade, and
//      §8 calls it a violation when it is done to move value between related entries).
import type { AgentContext, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  assessEntry,
  blocksLeft,
  bps,
  collateralInLoanUnits,
  lendingMarketsWithProvenance,
} from "../lib/agentMarkets.js";

// Share of the USDC balance committed to one market. Sized here because nothing sizes it for you.
const SUPPLY_BPS = Number(process.env.ERIS_TAKER_SUPPLY_BPS ?? "2500");
// How much of the borrowing power to actually use. Well under the LLTV, because the collateral is
// marked by an oracle that follows the market and the market moves inside a block.
const BORROW_UTILISATION_BPS = Number(
  process.env.ERIS_TAKER_BORROW_BPS ?? "5000",
);
// Blocks before the end at which everything starts unwinding. A repay needs a block to land, and a
// withdraw after it needs another.
const EXIT_BLOCKS = Number(process.env.ERIS_TAKER_EXIT_BLOCKS ?? "16");

export async function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): Promise<Record<string, unknown> | null> {
  const lending = obs.protocols.lending;
  if (!lending?.singleton) return null;
  const fee = obs.limits?.defaultPriorityFeePerGasWei;
  const joined = lendingMarketsWithProvenance(obs);
  const exiting = blocksLeft(obs) <= EXIT_BLOCKS;

  // ---- unwind first, always. The deadline outranks every opportunity. ----
  if (exiting) {
    for (const { market } of joined) {
      if (BigInt(market.borrowAssets) > 0n) {
        return {
          type: "lendingRepay",
          marketId: market.marketId,
          amount: "max",
          maxPriorityFeePerGasWei: fee,
          reason: "unwinding before the epoch's final block",
        };
      }
    }
    for (const { market } of joined) {
      if (BigInt(market.collateral) > 0n) {
        return {
          type: "lendingWithdrawCollateral",
          marketId: market.marketId,
          amount: market.collateral,
          maxPriorityFeePerGasWei: fee,
          reason: "recovering collateral before the epoch's final block",
        };
      }
      if (BigInt(market.supplyAssets) > 0n) {
        return {
          type: "lendingWithdraw",
          marketId: market.marketId,
          amount: "max",
          maxPriorityFeePerGasWei: fee,
          reason: "round-tripping out of the supply position",
        };
      }
    }
    return null;
  }

  // ---- otherwise, find one market worth using ----
  for (const { market, entry } of joined) {
    if (!entry) continue; // not published yet; the registry is one block behind for everyone
    if (entry.mine) continue;
    const verdict = assessEntry(entry);
    if (!verdict.ok) {
      ctx.log({
        round: obs.round,
        reason: `skipping ${market.marketId}: ${verdict.reasons.join("; ")}`,
        state: { kind: "market_taker_skip", marketId: market.marketId },
      });
      continue;
    }
    // Already in it. Borrowing against posted collateral is the second step, and only up to a
    // fraction of what the market would allow.
    if (BigInt(market.collateral) > 0n && BigInt(market.borrowAssets) === 0n) {
      const capacity = collateralInLoanUnits(
        BigInt(market.collateral),
        BigInt(market.price),
      );
      const maxBorrow = (capacity * BigInt(market.lltv)) / 10n ** 18n;
      const amount = bps(maxBorrow, BORROW_UTILISATION_BPS);
      if (amount > 0n && BigInt(market.totalSupplyAssets) - BigInt(market.totalBorrowAssets) >= amount) {
        return {
          type: "lendingBorrow",
          marketId: market.marketId,
          amount: amount.toString(),
          maxPriorityFeePerGasWei: fee,
          reason: "borrowing against posted collateral, well inside the LLTV",
        };
      }
      continue;
    }
    if (BigInt(market.collateral) > 0n || BigInt(market.supplyAssets) > 0n) continue;

    // Fresh market. Borrow if its collateral leg is a token this agent actually holds; otherwise be
    // the lender. Both legs are raw addresses, because these markets trade tokens the environment
    // never deployed and cannot name.
    const wethWei = BigInt(obs.balances.wethWei);
    const collateralIsWeth =
      market.collateralToken.toLowerCase() ===
      TOKENS.WETH.address.toLowerCase();
    if (collateralIsWeth && wethWei > 0n) {
      const amount = bps(wethWei, SUPPLY_BPS);
      if (amount > 0n) {
        return {
          type: "lendingSupplyCollateral",
          marketId: market.marketId,
          amount: amount.toString(),
          maxPriorityFeePerGasWei: fee,
          reason: "posting collateral in a market whose oracle cannot be moved",
        };
      }
    }
    const loanIsUsdc =
      market.loanToken.toLowerCase() === TOKENS.USDC.address.toLowerCase();
    const usdc = bps(BigInt(obs.balances.usdcUnits), SUPPLY_BPS);
    if (loanIsUsdc && usdc > 0n) {
      return {
        type: "lendingSupply",
        marketId: market.marketId,
        amount: usdc.toString(),
        maxPriorityFeePerGasWei: fee,
        reason: "lending into a market whose oracle cannot be moved",
      };
    }
  }
  return null;
}
