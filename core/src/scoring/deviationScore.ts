// The competition score (rules §4.4, in force from 2026-09-22; ADR 0022).
//
//   P(a, s)   = V_K − V_0                       USDC profit and loss over epoch s (§4.4.1)
//   μ_s, σ_s  = mean and population std of P over every agent placed in epoch s, benchmark excluded
//   T(a, s)   = 50 + 10 (P(a, s) − μ_s) / σ_s   the deviation score
//   w_s       = 1 + 0.5 (s − 1) / (k − 1)       first epoch 1, last 1.5; k = 1 gives 1
//   Score(a)  = Σ_{s∈S} w_s T(a, s) / Σ_{s∈S} w_s      S = the valid epochs with σ_s > 0
//
// One number per epoch: the value path inside an epoch is not used (§4.4.1). The population is every
// agent placed in the epoch -- bankrupt ones included, at their negative value, no floor (§4.4.2) --
// and the benchmark is not in it (§4.3). An epoch the organizer's facilities invalidated, or one in
// which everybody earned the same amount, is left out of S for everyone, and the weights of the
// other epochs do not move (§4.4.1): w_s is a function of the scheduled ordinal s and k alone.
//
// Rounding and ties are §4.6. T and Score are read to two decimals, the third rounded half away
// from zero, and the ranking is decided at that precision. Equal scores break on the population std
// of the agent's own T series (smaller first), then its worst T (larger first), then the time of its
// final submission (earlier first); what is still equal after that is a tie.
//
// Why "deviation score" and not the previous mean − λ·std of log returns (ADR 0019): the market's
// roughness differs by an order of magnitude between regimes, so summing USDC let the volatile
// epochs decide everything and the log-return Sharpe needed a λ nobody could calibrate. Standardising
// each epoch against its own field makes eight regimes count about equally with no free parameter,
// and bounds any single epoch at 50 ± 10√(n − 1).
//
// Pure: no filesystem, no chain. The producers (backtest matrix, dashboard) hand in P and read back
// the standings, so a stored competition can always be rescored from its P values alone.

export type EpochInput = {
  // The scheduled ordinal, 1-based. A re-execution of an invalidated epoch carries the original's.
  s: number;
  // P(a, s) for every agent placed in the epoch, the benchmark included if it ran.
  pnlByAgent: Readonly<Record<string, number>>;
  // Agents that are in `pnlByAgent` but not in the population (§4.3). Their P is reported back
  // untouched, for the leaderboard's reference column.
  benchmarkIds?: readonly string[];
  // §4.4.2: the epoch did not complete because of the organizer's facilities and could not be
  // re-executed. Out of S for everyone; the reason is carried into the report.
  invalid?: string;
};

export type EpochExclusion = "invalid" | "sigma-zero" | "empty";

export type EpochResult = {
  s: number;
  w: number;
  // Population size, benchmark excluded.
  n: number;
  mu: number | null;
  sigma: number | null;
  // Present when the epoch is not in S.
  excluded?: EpochExclusion;
  invalidReason?: string;
  // T(a, s) for every population member of an epoch in S; empty otherwise. Unrounded.
  tByAgent: Record<string, number>;
  benchmarkPnl: Record<string, number>;
};

export type AgentEpoch = { s: number; pnl: number; t: number; w: number };

export type AgentResult = {
  id: string;
  // Σ w T / Σ w over the epochs in S the agent was placed in. Null for an agent with none.
  scoreRaw: number | null;
  // scoreRaw at §4.6 precision -- the number the ranking is decided on.
  score: number | null;
  epochs: AgentEpoch[];
  // Tie-break inputs (§4.6), in order.
  tStd: number | null;
  worstT: number | null;
  submittedAt: number | null;
  // 1-based; tied agents share a rank and the next rank skips accordingly (1, 2, 2, 4).
  rank: number;
  tied: boolean;
};

export type CompetitionInput = {
  epochs: readonly EpochInput[];
  // The number of epochs scheduled (§4.4.1). Fixed before the competition; a shorter run of the
  // matrix still weights its epochs on the schedule, not on how many actually ran.
  k: number;
  // Time of each agent's final submission, for the third tie-break. Any monotone number (ms).
  submittedAt?: Readonly<Record<string, number>>;
};

export type CompetitionResult = {
  k: number;
  epochs: EpochResult[];
  // Ordinals in S, ascending. Published with the final ranking (§4.4.1).
  S: number[];
  // Sorted by rank.
  agents: AgentResult[];
};

// Two decimals, the third rounded half away from zero (四捨五入). The epsilon absorbs binary
// representation error (0.125 * 100 is 12.499999999999998), which is what would otherwise make the
// rule depend on how a value happened to be computed rather than on what it is.
export function round2(x: number): number {
  const sign = x < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(x) * 100 + 1e-9)) / 100;
}

export function weightOf(s: number, k: number): number {
  if (!Number.isInteger(s) || s < 1)
    throw new Error(`epoch ordinal must be a positive integer (got ${s})`);
  if (!Number.isInteger(k) || k < 1)
    throw new Error(`k must be a positive integer (got ${k})`);
  if (s > k)
    throw new Error(
      `epoch ordinal ${s} exceeds k = ${k}: every epoch, re-executions and additions included, ` +
        "carries a scheduled ordinal within k (rules §4.4.1, §4.7.1)",
    );
  return k === 1 ? 1 : 1 + (0.5 * (s - 1)) / (k - 1);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Population standard deviation (§4.4.1: the denominator is the number of agents in the population).
function populationStd(values: readonly number[], mu: number): number {
  return Math.sqrt(
    values.reduce((sum, v) => sum + (v - mu) * (v - mu), 0) / values.length,
  );
}

export function scoreEpoch(epoch: EpochInput, k: number): EpochResult {
  const w = weightOf(epoch.s, k);
  const benchmarks = new Set(epoch.benchmarkIds ?? []);
  const benchmarkPnl: Record<string, number> = {};
  const population: string[] = [];
  for (const [id, pnl] of Object.entries(epoch.pnlByAgent)) {
    if (!Number.isFinite(pnl))
      throw new Error(`epoch ${epoch.s}: P(${id}) is not a finite number (${pnl})`);
    if (benchmarks.has(id)) benchmarkPnl[id] = pnl;
    else population.push(id);
  }
  const base = { s: epoch.s, w, n: population.length, benchmarkPnl };
  if (epoch.invalid !== undefined)
    return {
      ...base,
      mu: null,
      sigma: null,
      excluded: "invalid",
      invalidReason: epoch.invalid,
      tByAgent: {},
    };
  if (population.length === 0)
    return { ...base, mu: null, sigma: null, excluded: "empty", tByAgent: {} };
  const values = population.map((id) => epoch.pnlByAgent[id]);
  const mu = mean(values);
  const sigma = populationStd(values, mu);
  if (sigma === 0)
    return { ...base, mu, sigma, excluded: "sigma-zero", tByAgent: {} };
  const tByAgent: Record<string, number> = {};
  for (const id of population)
    tByAgent[id] = 50 + (10 * (epoch.pnlByAgent[id] - mu)) / sigma;
  return { ...base, mu, sigma, tByAgent };
}

// The §4.6 order. Negative = a ranks ahead of b. Zero = tied.
function compareAgents(a: AgentResult, b: AgentResult): number {
  const sa = a.score ?? -Infinity;
  const sb = b.score ?? -Infinity;
  if (sa !== sb) return sb - sa;
  if (a.score === null) return 0;
  // 1. smaller std of the agent's own deviation scores
  if ((a.tStd as number) !== (b.tStd as number))
    return (a.tStd as number) - (b.tStd as number);
  // 2. larger worst-epoch deviation score
  if ((a.worstT as number) !== (b.worstT as number))
    return (b.worstT as number) - (a.worstT as number);
  // 3. earlier final submission, when known for both
  if (a.submittedAt !== null && b.submittedAt !== null && a.submittedAt !== b.submittedAt)
    return a.submittedAt - b.submittedAt;
  return 0;
}

export function scoreCompetition(input: CompetitionInput): CompetitionResult {
  const { k } = input;
  const seen = new Set<number>();
  const epochs = [...input.epochs]
    .sort((a, b) => a.s - b.s)
    .map((e) => {
      if (seen.has(e.s))
        throw new Error(
          `epoch ordinal ${e.s} appears twice: a re-execution replaces the original (§4.4.2), ` +
            "so hand in one record per ordinal",
        );
      seen.add(e.s);
      return scoreEpoch(e, k);
    });
  const S = epochs.filter((e) => e.excluded === undefined).map((e) => e.s);

  const byAgent = new Map<string, AgentEpoch[]>();
  for (const e of epochs) {
    if (e.excluded !== undefined) continue;
    for (const [id, t] of Object.entries(e.tByAgent)) {
      const list = byAgent.get(id) ?? [];
      list.push({ s: e.s, pnl: input.epochs.find((x) => x.s === e.s)!.pnlByAgent[id], t, w: e.w });
      byAgent.set(id, list);
    }
  }
  // An agent that ran only in excluded epochs still gets a row: it competed, and a row with a null
  // score says so, where dropping it would read as "never entered".
  for (const e of epochs)
    for (const id of Object.keys(input.epochs.find((x) => x.s === e.s)!.pnlByAgent))
      if (!(id in e.benchmarkPnl) && !byAgent.has(id)) byAgent.set(id, []);

  const agents: AgentResult[] = [...byAgent.entries()].map(([id, list]) => {
    if (list.length === 0)
      return {
        id, scoreRaw: null, score: null, epochs: [], tStd: null, worstT: null,
        submittedAt: input.submittedAt?.[id] ?? null, rank: 0, tied: false,
      };
    const sumW = list.reduce((a, e) => a + e.w, 0);
    const scoreRaw = list.reduce((a, e) => a + e.w * e.t, 0) / sumW;
    const ts = list.map((e) => e.t);
    return {
      id,
      scoreRaw,
      score: round2(scoreRaw),
      epochs: list,
      tStd: populationStd(ts, mean(ts)),
      worstT: Math.min(...ts),
      submittedAt: input.submittedAt?.[id] ?? null,
      rank: 0,
      tied: false,
    };
  });

  agents.sort((a, b) => compareAgents(a, b) || a.id.localeCompare(b.id));
  // Competition ranking: equal under §4.6 shares the rank, the next rank skips (1, 2, 2, 4).
  for (let i = 0; i < agents.length; i++) {
    const prev = i > 0 ? agents[i - 1] : undefined;
    if (prev && compareAgents(prev, agents[i]) === 0) {
      agents[i].rank = prev.rank;
      agents[i].tied = true;
      prev.tied = true;
    } else {
      agents[i].rank = i + 1;
    }
  }
  return { k, epochs, S, agents };
}
