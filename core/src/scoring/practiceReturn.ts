// P for the practice period (rules §2.7; one continuous world, ADR 0021).
//
//   P(a, d) = V_K / V_0 − 1      the agent's return over day d (one segment = one epoch)
//
// T and Score are then the competition's own (deviationScore.ts), with every day weighted 1.
//
// Why a return and not the competition's V_K − V_0. In the competition every epoch starts every agent
// from the same basket, so dividing all P by that one V_0 scales μ and σ by the same factor and
// leaves every T exactly where it was: the two are the same ranking. The practice period never
// resets, so by day 10 the agents hold whatever the first nine days left them. On V_K − V_0 an agent
// that doubled its capital early earns twice the USDC for the same decisions, and one that lost half
// looks steadier for having less to lose -- the ranking would measure capital, not the day. Dividing
// by each agent's own V_0 asks the competition's question ("what did you do with what you started the
// epoch with") of a world where the starting amounts have drifted apart.
//
// Why the floor. A return on almost nothing is decided by rounding: gas and fees are near-fixed per
// transaction, and an agent down to a few dollars can move ±50% on one lucky or unlucky fill. That
// agent is not placed on the day (the same "not placed" as a mid-period registration: out of the
// population, never P = 0). The bar is relative to the day's field rather than a USDC figure so it
// does not have to be re-derived when the endowment changes. A V_0 at or below zero has no return.
//
// Why equal weights. The competition's linear w_s runs over a k fixed before it starts. A period's
// day count grows while it runs, so a linear schedule over "days so far" would re-weight every past
// day each midnight, and the day that is 1.5 today is 1.3 next week.

/** An agent is not placed on a day that it starts with less than this share of the field's median V_0. */
export const PRACTICE_MIN_CAPITAL_FRACTION = 0.1;

export type PracticeEnds = {
  initialValueUsdc: number;
  finalValueUsdc: number;
};

export type PracticeReturns = {
  /** agent -> V_K / V_0 − 1, for every agent placed on the day. The benchmark included, unfloored. */
  returnByAgent: Record<string, number>;
  /** Agents with ends on the day that were not placed, and why. */
  notPlaced: Record<string, "non-positive-start" | "below-capital-floor">;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function practiceReturns(
  ends: Readonly<Record<string, PracticeEnds>>,
  benchmarkIds: readonly string[] = [],
): PracticeReturns {
  const benchmarks = new Set(benchmarkIds);
  const returnByAgent: Record<string, number> = {};
  const notPlaced: PracticeReturns["notPlaced"] = {};
  const usable = Object.entries(ends).filter(
    ([, e]) =>
      Number.isFinite(e.initialValueUsdc) && Number.isFinite(e.finalValueUsdc),
  );
  // The benchmark is not in the population (§4.3), so it does not set the bar either.
  const startsInField = usable
    .filter(([id, e]) => !benchmarks.has(id) && e.initialValueUsdc > 0)
    .map(([, e]) => e.initialValueUsdc);
  const floor =
    startsInField.length > 0
      ? PRACTICE_MIN_CAPITAL_FRACTION * median(startsInField)
      : 0;
  for (const [id, e] of usable) {
    if (e.initialValueUsdc <= 0) {
      notPlaced[id] = "non-positive-start";
      continue;
    }
    if (!benchmarks.has(id) && e.initialValueUsdc < floor) {
      notPlaced[id] = "below-capital-floor";
      continue;
    }
    returnByAgent[id] = e.finalValueUsdc / e.initialValueUsdc - 1;
  }
  return { returnByAgent, notPlaced };
}
