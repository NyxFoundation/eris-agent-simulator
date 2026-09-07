// Number formatting for the figures a run is read by.
//
// Both helpers exist because `.toFixed(1)` was destroying the values it was given. A run's PnL was
// shown as a share of the agent's starting mark, and the default gas endowment (100 ETH, ~78% of
// that mark) sits in the denominator: a real result of -64.46 USDC came out as "-0.0%". The score
// had the same shape of bug from the other end -- it is scaled to bps of log growth per epoch, and
// a real one is often a few hundredths of a bp, so one decimal rounded it to "0.0" for the whole
// field including the agent that had just won.
//
// The rule both follow: never round a number to zero that is not zero.

/** Signed USDC, no currency symbol (call sites label the unit). Cents below $1,000, whole dollars
 * above -- a run's PnL is read against a five-figure mark, so cents past that are noise. */
export function formatPnlUsdc(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);
  // A result too small to show in cents is reported as a bound rather than as "+0.00", which would
  // be the same bug one decimal place further down. Reads as "less than +0.01" / "more than -0.01".
  if (value !== 0 && abs < 0.005) return value > 0 ? "<+0.01" : ">-0.01";
  return `${sign}${abs.toLocaleString("en-US", {
    minimumFractionDigits: abs >= 1000 ? 0 : 2,
    maximumFractionDigits: abs >= 1000 ? 0 : 2,
  })}`;
}

/** A deviation score — an epoch's T or the weighted Score — at the two decimals rules §4.6 rank
 * on. Null is "not scored": the benchmark, or a field with no spread. */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(2);
}

/** A score or per-round log return, ×10⁴ (bps scale) but displayed without a unit suffix — the
 * scale is stated once where the number is introduced, not on every value. Same rule as the score:
 * never round a non-zero to zero. */
export function formatBps(value: number): string {
  const abs = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  if (value !== 0 && abs < 0.0005) return value > 0 ? "<+0.001" : ">-0.001";
  const digits = abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return `${sign}${abs.toFixed(digits)}`;
}

/** A rank move, as the leaderboard's arrow column reads it. */
export function formatMove(move: number): string {
  if (move === 0) return "—";
  return move > 0 ? `▲${move}` : `▼${-move}`;
}

/** Compact USD for chart captions. Cents below $1,000, whole dollars above, millions abbreviated. */
export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000)
    return `$${(value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 0 : 2 })}`;
}

/** USD narrow enough to sit on a map node beside a name: "$372.5K", "$1.24M", "$948". Three
 * significant figures is the most a 60px column can carry, and an account value read off a board is
 * a magnitude — the exact figure is one click away on the agent's own page. */
export function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
