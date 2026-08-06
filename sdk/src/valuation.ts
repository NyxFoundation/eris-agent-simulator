// Shared USD valuation primitives for scoring (issue #41).
//
// The scorer used to enumerate a fixed set of position types and value everything else at exactly
// zero, so moving real value into an unlisted venue read as a total loss. These helpers price a
// holding from the token registry instead, and make "cannot price this" a reportable outcome rather
// than a silent zero.
import { formatUnits, type Address } from "viem";
import { tokenInfoByAddress } from "./markets.js";

// A holding that could not be priced. amountRaw is the raw token amount excluded from the value
// ("" when even the amount is unknown).
export type UnpricedAmount = { token: Address; amountRaw: string };

// USD value of a raw token amount. Stables are $1; bases use the run's fair price. Undefined means
// the token is outside the registry, i.e. unpriceable — not worthless.
export function tokenAmountUsd(
  token: Address,
  amount: bigint,
  fairByBase: Record<string, number>,
): number | undefined {
  const info = tokenInfoByAddress(token);
  if (!info) return undefined;
  const price = info.kind === "stable" ? 1 : fairByBase[info.symbol];
  if (price === undefined) return undefined;
  return Number(formatUnits(amount, info.decimals)) * price;
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
