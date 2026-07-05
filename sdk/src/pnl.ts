import { formatUnits } from "viem";
import { tokenInfo } from "./markets.js";
import type { BalanceSnapshot } from "./types.js";

// Price argument. For backward compatibility it also accepts a single number (WETH/USD), normalizing it to {WETH:n} (ADR 0013).
export type PriceArg = number | Record<string, number>;

function normalizePrices(arg: PriceArg): Record<string, number> {
  return typeof arg === "number" ? { WETH: arg } : arg;
}

// Base wallet value: loose ETH + all base tokens + stable (USDC-equivalent).
// Protocol-specific position value (LP, perp, aave net) is added by each adapter.valueUsdc.
// ADR 0013: if snapshot.bases exists, value all bases at their respective USD prices; otherwise value
// wethWei as WETH (= exactly the old behavior).
export function valueUsdc(snapshot: BalanceSnapshot, prices: PriceArg): number {
  const p = normalizePrices(prices);
  const wethPrice = p.WETH ?? 0;
  const eth = Number(formatUnits(snapshot.ethWei, 18)) * wethPrice;
  let total = Number(formatUnits(snapshot.usdcUnits, 6)) + eth;
  const bases = snapshot.bases ?? { WETH: snapshot.wethWei };
  for (const [sym, wei] of Object.entries(bases)) {
    total += Number(formatUnits(wei, tokenInfo(sym).decimals)) * (p[sym] ?? 0);
  }
  return total;
}

export function balanceToInventory(
  snapshot: BalanceSnapshot,
  prices: PriceArg,
) {
  const eth = Number(formatUnits(snapshot.ethWei, 18));
  const weth = Number(formatUnits(snapshot.wethWei, 18));
  const usdc = Number(formatUnits(snapshot.usdcUnits, 6));
  return {
    valueUsdc: valueUsdc(snapshot, prices),
    weth,
    usdc,
    eth,
  };
}
