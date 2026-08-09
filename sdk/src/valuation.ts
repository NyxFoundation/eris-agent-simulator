// Shared USD valuation primitives for scoring (issue #41).
//
// The scorer used to enumerate a fixed set of position types and value everything else at exactly
// zero, so moving real value into an unlisted venue read as a total loss. These helpers price a
// holding from the token registry instead, and make "cannot price this" a reportable outcome rather
// than a silent zero.
import { formatUnits, type Address } from "viem";
import { USDC_VARIANTS } from "./constants.js";
import { tokenInfoByAddress } from "./markets.js";

// Stables the run settles in but the token registry does not name. On the Arbitrum fork the registry
// is WETH/USDC only, while the deep Balancer and Curve pools hold USDC.e and USDT -- so a BPT holder
// lost roughly a third of their value and a Curve LP lost its whole stable leg. Spot accounting
// already treats all three as 6-decimal USDC-equivalent worth $1 (constants' USDC_VARIANTS); pool
// shares have to use the same convention or the two disagree about the same token.
const STABLE_VARIANT_DECIMALS = 6;

function stableVariantDecimals(token: Address): number | undefined {
  const target = token.toLowerCase();
  for (const address of Object.values(USDC_VARIANTS)) {
    if (address.toLowerCase() === target) return STABLE_VARIANT_DECIMALS;
  }
  return undefined;
}

// Why a holding is missing from a value. "unpriced" means the amount is known but has no USD price;
// "read-failed" means the read that would have revealed the holding failed, so the holding is
// *unknown* rather than zero (issue #44); "unrealizable" means it is known and priceable but
// cannot be turned into anything before the run ends -- an LST redemption whose queue finalizes
// after the last block (issue #38). All three are excluded from the value and all three are
// reported — a zero in summary.json must never be mistaken for a trading loss.
export type ScoringExclusionReason =
  "unpriced" | "read-failed" | "unrealizable";

// A holding left out of a value, and why.
export type UnpricedAmount = {
  // The token, when the exclusion is token-shaped. Absent when a whole position could not be read
  // (an Aave account, say, is not one token).
  token?: Address;
  // The raw token amount excluded from the value ("" when even the amount is unknown).
  amountRaw: string;
  // Defaults to "unpriced" when unset, which is what every issue #41 site reports.
  reason?: ScoringExclusionReason;
  // For "read-failed": what could not be read, e.g. "AavePool.getUserAccountData". Prose rather than
  // a taxonomy — it is read by a human diagnosing a value series, not by code.
  read?: string;
};

// USD value of a raw token amount. Stables are $1; bases use the run's fair price. Undefined means
// the token is outside the registry, i.e. unpriceable — not worthless.
export function tokenAmountUsd(
  token: Address,
  amount: bigint,
  fairByBase: Record<string, number>,
): number | undefined {
  const info = tokenInfoByAddress(token);
  if (info) {
    const price = info.kind === "stable" ? 1 : fairByBase[info.symbol];
    if (price === undefined) return undefined;
    return Number(formatUnits(amount, info.decimals)) * price;
  }
  const stableDecimals = stableVariantDecimals(token);
  if (stableDecimals === undefined) return undefined;
  return Number(formatUnits(amount, stableDecimals));
}

export type PoolReserves = {
  tokens: Address[];
  balances: bigint[];
  totalSupply: bigint;
};

// Value an LP-token holding as its proportional share of the pool's reserves.
//
// Both Balancer weighted pools and Curve crypto pools let a holder exit at the pool's own ratio
// without a swap fee, so the proportional share *is* the realizable exit value. It also avoids
// depending on a venue-specific pricing formula (virtual price, BPT rate), which would have to be
// re-derived for every pool type the sim gains.
export function poolShareValueUsdc(
  reserves: PoolReserves,
  lpBalance: bigint,
  fairByBase: Record<string, number>,
): { valueUsdc: number; unpriced: UnpricedAmount[] } {
  if (lpBalance <= 0n || reserves.totalSupply <= 0n)
    return { valueUsdc: 0, unpriced: [] };
  let valueUsdc = 0;
  const unpriced: UnpricedAmount[] = [];
  for (let i = 0; i < reserves.tokens.length; i++) {
    const reserve = reserves.balances[i] ?? 0n;
    const amount = (reserve * lpBalance) / reserves.totalSupply;
    const usd = tokenAmountUsd(reserves.tokens[i], amount, fairByBase);
    if (usd === undefined) {
      if (amount > 0n)
        unpriced.push({
          token: reserves.tokens[i],
          amountRaw: amount.toString(),
        });
      continue;
    }
    valueUsdc += usd;
  }
  return { valueUsdc, unpriced };
}
