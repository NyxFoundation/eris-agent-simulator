// Cross-scenario aggregation candidates (ADR 0020 §5).
//
// In `continuous` mode there is nothing to aggregate: one world, one series, one number per agent.
// `scenario` mode always needs a second layer -- a rule for turning N per-scenario numbers into a
// standing -- and that layer is a separate choice from the per-scenario metric. ADR 0019 declared the
// incumbent (field-relative z-score) retired without naming a replacement, and issue #55 is the
// reason: one agent at -1,113 USDC inflated the field's sd from 20.9 to 181.5 and compressed everyone
// else by 8.7x. A z-score is a ratio to a spread the other participants control.
//
// So the candidates are compared rather than assumed:
//
//   zscore  the incumbent. Scale-free within a scenario, and vulnerable exactly as #55 describes.
//   borda   rank within the scenario, then average. A single extreme result can cost an agent one
//           place, never eight-tenths of the field's spread -- but it also throws away *how much*
//           better the winner was, so a scenario decided by 1 USDC counts the same as a blowout.
//   mean    the metric itself, averaged. Keeps absolute scale (ADR 0019 §1 wanted that), at the cost
//           of letting one high-variance regime dominate the total.
//
// All three share the same outer weighting -- mean within a regime, then mean over regimes -- so a
// regime with more seeds does not carry more of the total (ADR 0017 §3). All three are oriented
// "higher is better" so the same sort reads correctly for each.
//
// Pure: no filesystem, no chain. The CLI feeds it rows read from a stored matrix, which is what lets
// the aggregation rule be re-chosen without re-running anything (ADR 0017 §4).

export type Aggregator = "zscore" | "borda" | "mean";

export const AGGREGATORS: Aggregator[] = ["zscore", "borda", "mean"];

export type ScenarioRow = {
  regime: string;
  seed: number;
  // agent id -> that scenario's metric value. An agent absent from the record did not produce a
  // readable number for this scenario and is skipped rather than scored zero: a zero is a real
  // result (it is exactly what noop earns), so spending it on a missing measurement would place a
  // failed agent mid-pack in any scenario where the field lost money.
  byAgent: Record<string, number>;
};

export type AggregateRow = {
  id: string;
  total: number;
  byRegime: Record<string, number>;
  scenariosScored: number;
};

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Population standard deviation: the agents in a scenario are the whole field being compared, not a
// sample of a larger one (same reasoning as core/src/backtest/standings.ts).
function stdev(values: number[], mu: number): number {
  return Math.sqrt(mean(values.map((v) => (v - mu) ** 2)));
}

// One scenario's values -> comparable-within-scenario numbers, higher being better.
export function transformScenario(
  byAgent: Record<string, number>,
  aggregator: Aggregator,
): Record<string, number> {
  const ids = Object.keys(byAgent);
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;

  if (aggregator === "mean") {
    for (const id of ids) out[id] = byAgent[id];
    return out;
  }

  if (aggregator === "zscore") {
    const values = ids.map((id) => byAgent[id]);
    const mu = mean(values);
    const sd = stdev(values, mu);
    // sd === 0 means the whole field tied, so nobody gains ground on anybody.
    for (const id of ids) out[id] = sd > 0 ? (byAgent[id] - mu) / sd : 0;
    return out;
  }

  // borda: points, not places, so that "higher is better" holds for every aggregator. The best of n
  // agents scores n-1 and the worst scores 0. Ties share the average of the places they span, which
  // keeps the column total fixed at n(n-1)/2 -- without it, a field where everyone ties would hand
  // out more points than one where they do not.
  const sorted = [...ids].sort((a, b) => byAgent[b] - byAgent[a]);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (
      j + 1 < sorted.length &&
      byAgent[sorted[j + 1]] === byAgent[sorted[i]]
    )
      j++;
    const points = mean(
      Array.from({ length: j - i + 1 }, (_, k) => sorted.length - 1 - (i + k)),
    );
    for (let k = i; k <= j; k++) out[sorted[k]] = points;
    i = j + 1;
  }
  return out;
}

// Rows -> standings, sorted best first. Regimes are weighted equally regardless of how many seeds
// each contributed.
export function aggregateScenarios(
  rows: ScenarioRow[],
  aggregator: Aggregator,
): AggregateRow[] {
  const perScenario = rows.map((row) => ({
    regime: row.regime,
    values: transformScenario(row.byAgent, aggregator),
  }));

  const regimes: string[] = [];
  for (const s of perScenario)
    if (!regimes.includes(s.regime)) regimes.push(s.regime);

  const ids: string[] = [];
  for (const s of perScenario)
    for (const id of Object.keys(s.values)) if (!ids.includes(id)) ids.push(id);

  const out = ids.map((id) => {
    const byRegime: Record<string, number> = {};
    let scenariosScored = 0;
    for (const regime of regimes) {
      const inRegime = perScenario.filter(
        (s) => s.regime === regime && id in s.values,
      );
      if (inRegime.length === 0) continue;
      byRegime[regime] = mean(inRegime.map((s) => s.values[id]));
      scenariosScored += inRegime.length;
    }
    const present = regimes.filter((r) => r in byRegime);
    return {
      id,
      total: present.length > 0 ? mean(present.map((r) => byRegime[r])) : 0,
      byRegime,
      scenariosScored,
    };
  });

  out.sort((a, b) => b.total - a.total);
  return out;
}

// The ordering an aggregator produces, best first. The comparison is about where two rules disagree,
// and an order is the only part of a standing that a ranking rule has to get right.
export function orderOf(rows: AggregateRow[]): string[] {
  return rows.map((r) => r.id);
}

// How much of a scenario's spread comes from its single most extreme agent: sd with it, over sd
// without it. This is issue #55 as a number. There, one entry at -1,113 USDC took the field's sd
// from 20.9 to 181.5 -- an inflation of 8.7 -- and since a z-score divides by that sd, everyone
// else's score was compressed by the same factor. 1.0 means no single agent is setting the scale.
//
// It is a property of the *scenario*, not of the aggregator, which is the point: it says how much
// damage the zscore aggregator would take here before any aggregator is chosen.
export function sdInflationFromExtreme(byAgent: Record<string, number>): {
  ratio: number;
  agentId?: string;
} {
  const ids = Object.keys(byAgent);
  if (ids.length < 3) return { ratio: 1 };
  const values = ids.map((id) => byAgent[id]);
  const mu = mean(values);
  const sd = stdev(values, mu);
  if (sd === 0) return { ratio: 1 };

  let worstRatio = 1;
  let worstId: string | undefined;
  for (const id of ids) {
    const rest = ids.filter((other) => other !== id).map((o) => byAgent[o]);
    const restSd = stdev(rest, mean(rest));
    // A field that ties once the outlier is removed is the extreme case of the same failure: the
    // spread is entirely one agent's doing. Reported as Infinity rather than skipped.
    const ratio = restSd > 0 ? sd / restSd : Number.POSITIVE_INFINITY;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstId = id;
    }
  }
  return { ratio: worstRatio, agentId: worstId };
}
