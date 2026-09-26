// Rules §4.1 (付録A: 5 blocks): at a scoring point, every market-derived price is the median of its
// values over the preceding blocks, the scoring block included. Reference prices -- the
// environment's fair for the bases, and the oracles fed from it -- are not market-derived and are
// used as they are.
//
// The scorer hands an adapter the window's *earlier* blocks (ctx.medianWindow) and a way to read
// at them (ctx.readAt). The adapter decides what its market-derived price is and re-reads only that,
// with the position itself held at the scoring block: the median is over the *price*, not over
// holdings that may have changed inside the window. Outside a scoring boundary the window is empty
// and every helper here is a no-op, so the equity curve keeps the live mark.
import type { ValuationContext, ValuationRead } from "./types.js";

// The same reads at every earlier block of the window, oldest first: one result array per block.
// Empty when there is no window (not a boundary, or the median is switched off).
export async function readAcrossWindow(
  ctx: ValuationContext,
  reads: ValuationRead[],
): Promise<unknown[][]> {
  const window = ctx.medianWindow ?? [];
  const readAt = ctx.readAt;
  if (window.length === 0 || reads.length === 0 || !readAt) return [];
  return Promise.all(window.map((block) => readAt(reads, block)));
}

// Median of the samples; the mean of the middle two for an even count (the same convention as the
// stables' probe median). Undefined for no samples.
export function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function medianBigint(values: readonly bigint[]): bigint | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2n;
}

// For quote reads (get_dy / get_dx at the holder's own size): the median, per read, of the scoring
// block's own answer and the window's. A block whose quote reverted is dropped rather than counted
// as zero -- a pool that would not quote once has no price at that block, not a price of nothing
// (the stables' probe drops unquoted blocks for the same reason). Undefined only when no block in
// the window answered.
export function medianQuotes(
  atBoundary: readonly unknown[],
  window: readonly (readonly unknown[])[],
): Array<bigint | undefined> {
  return atBoundary.map((own, i) =>
    medianBigint(
      [own, ...window.map((sample) => sample[i])].filter(
        (q): q is bigint => typeof q === "bigint",
      ),
    ),
  );
}
