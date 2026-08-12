import { formatUnits } from "viem";
import { tokenInfo, tokenInfoByAddress } from "./markets.js";
import { stablePriceUsdc, type StablePrices } from "./stables.js";
import type { BalanceSnapshot } from "./types.js";

// Price argument. For backward compatibility it also accepts a single number (WETH/USD), normalizing it to {WETH:n} (ADR 0013).
export type PriceArg = number | Record<string, number>;

function normalizePrices(arg: PriceArg): Record<string, number> {
  return typeof arg === "number" ? { WETH: arg } : arg;
}

// Decimals of a stable held in BalanceSnapshot.stables, which is keyed by raw address. The fork's
// USDC.e / USD₮0 are outside the registry and are 6-decimal by the same convention that makes them
// dollars (valuation.ts STABLE_VARIANT_DECIMALS).
function stableDecimals(token: string): number {
  return tokenInfoByAddress(token as `0x${string}`)?.decimals ?? 6;
}

// Base wallet value: loose ETH + all base tokens + every stable at its own price.
// Protocol-specific position value (LP, perp, aave net) is added by each adapter.valueUsdc.
// ADR 0013: if snapshot.bases exists, value all bases at their respective USD prices; otherwise value
// wethWei as WETH (= exactly the old behavior).
//
// Issue #27: the stable leg is no longer a constant. When the snapshot carries the per-stable
// breakdown, each balance is valued at what its market pays (par for the numéraire and for the
// USDC-equivalents, which is byte-identical to the old summed figure). A snapshot without the
// breakdown falls back to usdcUnits at par -- the only thing available, and correct for every
// caller that assembles one by hand.
export function valueUsdc(
  snapshot: BalanceSnapshot,
  prices: PriceArg,
  stablePrices?: StablePrices,
): number {
  const p = normalizePrices(prices);
  const wethPrice = p.WETH ?? 0;
  const eth = Number(formatUnits(snapshot.ethWei, 18)) * wethPrice;
  let total = eth;
  // Object.keys rather than a truthiness check: validateLeafItems builds an empty `stables` map
  // when the snapshot it copies had none, and treating that as authoritative would drop usdcUnits
  // from the total entirely instead of falling back to it.
  if (snapshot.stables && Object.keys(snapshot.stables).length > 0) {
    for (const [token, units] of Object.entries(snapshot.stables)) {
      total +=
        Number(formatUnits(units, stableDecimals(token))) *
        stablePriceUsdc(stablePrices, token as `0x${string}`);
    }
  } else {
    total += Number(formatUnits(snapshot.usdcUnits, 6));
  }
  const bases = snapshot.bases ?? { WETH: snapshot.wethWei };
  for (const [sym, wei] of Object.entries(bases)) {
    total += Number(formatUnits(wei, tokenInfo(sym).decimals)) * (p[sym] ?? 0);
  }
  return total;
}

export function balanceToInventory(
  snapshot: BalanceSnapshot,
  prices: PriceArg,
  stablePrices?: StablePrices,
) {
  const eth = Number(formatUnits(snapshot.ethWei, 18));
  const weth = Number(formatUnits(snapshot.wethWei, 18));
  // The spendable dollar budget, which since issue #27 is native USDC alone. The value of the other
  // stables is in valueUsdc, not here: this field is what an agent sizes a USDC leg against.
  const usdc = Number(formatUnits(snapshot.usdcUnits, 6));
  return {
    valueUsdc: valueUsdc(snapshot, prices, stablePrices),
    weth,
    usdc,
    eth,
  };
}
