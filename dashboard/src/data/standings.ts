// The competition standings, under the rule the competition is scored by (rules §4.4, ADR 0023):
//
//   per epoch (one scenario run)   P = V_K − V_0;   T = 50 + 10 (P − μ) / σ over the field
//   across epochs                  Score = Σ w_s T / Σ w_s,  w_s linear 1 → 1.5 on the epoch's order
//
// The arithmetic is imported from core rather than reimplemented — two implementations of one
// ranking is two answers to "who won" with no way to tell which is the real one (see the vite
// alias note). What this file owns is the mapping from a competition's artifacts onto P.

import {
  scoreCompetition,
  type AgentEpoch,
  type AgentResult,
  type EpochInput,
  type EpochResult,
} from "@core/scoring/deviationScore";
import { epochPnlFromSeries } from "@core/scoring/epochPnl";
import type { Competition, CompetitionScenario } from "./competition";
import { scenarioLabel, scenarioRunId } from "./competition";
import { listRuns } from "./runArtifacts";
import type { RunSummary } from "./runArtifacts";

// ---------------------------------------------------------------------------
// per-scenario boundary series

/** One scenario's value at every epoch boundary, by agent. Absent when its summary could not load. */
export interface ScenarioRounds {
  regime: string;
  seed: number;
  runId: string;
  /** agent -> value at each boundary, index 0 the epoch's start. Empty for a run still in progress. */
  valuesByAgent: Record<string, Array<number | null>>;
  /** Agents the summary marks as the benchmark (§4.3): valued, shown, never in the population. */
  baselineIds: string[];
}

/**
 * Identity, not display. `runDir` is the one field guaranteed unique across a competition's
 * scenarios — a matrix can repeat (regime, seed) under `--repeat`, and a practice period's segments
 * (ADR 0021 §6) can share a label when several fall in the same hour.
 */
function scenarioKey(s: { runDir: string }): string {
  return s.runDir;
}

/**
 * Load the boundary series behind every scenario of a competition. A standing "through round k"
 * is P = V_k − V_0 on exactly these values, so scrubbing replays the score rather than
 * approximating it.
 */
export async function loadCompetitionRounds(
  competition: Competition,
): Promise<Map<string, ScenarioRounds>> {
  // A period's current segment has no summary.json until it rolls (ADR 0021 §6), so on a live
  // period one scenario always 404s. That is "still running", not "never collected".
  const live = new Set(
    await listRuns()
      .then((index) => index.filter((r) => r.live).map((r) => r.id))
      .catch(() => []),
  );
  const entries = await Promise.all(
    competition.file.scenarios.map(async (s) => {
      const runId = scenarioRunId(competition.id, s.runDir);
      const empty = {
        regime: s.regime,
        seed: s.seed,
        runId,
        valuesByAgent: {},
        baselineIds: [],
      };
      try {
        const res = await fetch(
          `/runs/${encodeURIComponent(runId)}/summary.json`,
        );
        if (!res.ok)
          return live.has(runId) ? ([scenarioKey(s), empty] as const) : null;
        const summary = (await res.json()) as RunSummary;
        const valuesByAgent =
          summary.valueSeries?.epochSeries?.valuesByAgent ?? {};
        const baselineIds = (summary.agents ?? [])
          .filter((a) => a.baseline)
          .map((a) => a.id);
        return [
          scenarioKey(s),
          { regime: s.regime, seed: s.seed, runId, valuesByAgent, baselineIds },
        ] as const;
      } catch {
        // A scenario whose run dir was not collected has no series. Its stored P still ranks it —
        // dropping the scenario instead would silently change the standings.
        return null;
      }
    }),
  );
  return new Map(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}

// ---------------------------------------------------------------------------
// P per scenario

/**
 * One scenario's P per agent, optionally as of a round rather than at the end.
 *
 * `throughRound` reads V_k off the boundary series, which is what makes the standings scrubbable:
 * at round k the epoch's P is V_k − V_0 and the field is standardised on exactly that. A scenario
 * shorter than k is *not* dropped — its world ended, so its final value is its result and removing
 * it would move the standings for a reason that is not a result. `ended` says so.
 *
 * At the end, P is the summary's own figure (`pnlUsdc`, each end at its own marks; falling back to
 * the series' ends, then to netPnlUsdc for a run recorded before either existed).
 */
function scenarioPnl(
  scenario: CompetitionScenario,
  rounds: Map<string, ScenarioRounds>,
  throughRound: number | null,
): { pnlByAgent: Record<string, number>; benchmarkIds: string[]; ended: boolean } {
  const series = rounds.get(scenarioKey(scenario));
  const pnlByAgent: Record<string, number> = {};
  const benchmarkIds = new Set<string>(series?.baselineIds ?? []);
  for (const a of scenario.agents) if (a.baseline) benchmarkIds.add(a.id);
  let ended = false;

  if (throughRound !== null) {
    if (!series) return { pnlByAgent, benchmarkIds: [...benchmarkIds], ended };
    for (const agent of scenario.agents) {
      const values = series.valuesByAgent[agent.id];
      if (!values || values.length < 2) continue;
      const last = values.length - 1;
      if (last <= throughRound) ended = true;
      const upTo = Math.min(throughRound, last);
      if (upTo <= 0) continue;
      const start = values[0];
      const now = values[upTo];
      if (start === null || now === null) continue;
      pnlByAgent[agent.id] = now - start;
    }
    return { pnlByAgent, benchmarkIds: [...benchmarkIds], ended };
  }

  for (const agent of scenario.agents) {
    const fromSeries = series
      ? epochPnlFromSeries(series.valuesByAgent[agent.id] ?? [])?.pnlUsdc
      : undefined;
    const p = agent.pnlUsdc ?? fromSeries ?? agent.netPnlUsdc;
    if (Number.isFinite(p)) pnlByAgent[agent.id] = p;
  }
  return { pnlByAgent, benchmarkIds: [...benchmarkIds], ended };
}

// ---------------------------------------------------------------------------
// standings

export interface Standings {
  k: number;
  /** Ordinals that entered the score (σ > 0 and valid). */
  S: number[];
  /** Sorted by rank (§4.6). */
  rows: AgentResult[];
  epochs: Array<EpochResult & { regime: string; seed: number; label: string }>;
  regimes: string[];
  agentIds: string[];
  /** The round these standings are as of, or null for the finished result. */
  throughRound: number | null;
  /** Scenarios whose world had already ended at that round — counted, never silently dropped. */
  endedScenarios: number;
  /** Net PnL (final marks) summed across every scenario. Defined only at a run's end. */
  netPnlByAgent: Record<string, number>;
  /** Mean T per regime, per agent — the regime columns. Not a second ranking: an explanation. */
  tByRegime: Record<string, Record<string, number>>;
  /** The benchmark's P per epoch ordinal (§4.3: shown, never scored). */
  benchmarkPnl: Record<string, Record<number, number>>;
}

function ordinalOf(scenario: CompetitionScenario, index: number): number {
  return scenario.s ?? index + 1;
}

export function buildStandings(
  competition: Competition,
  rounds: Map<string, ScenarioRounds>,
  throughRound: number | null = null,
): Standings {
  const scenarios = competition.file.scenarios;
  const k = Math.max(
    competition.file.k ?? 0,
    ...scenarios.map((s, i) => ordinalOf(s, i)),
    1,
  );
  let endedScenarios = 0;
  const epochs: EpochInput[] = scenarios.map((s, i) => {
    const { pnlByAgent, benchmarkIds, ended } = scenarioPnl(s, rounds, throughRound);
    if (ended) endedScenarios += 1;
    return { s: ordinalOf(s, i), pnlByAgent, benchmarkIds };
  });
  const scored = scoreCompetition({ epochs, k });

  const regimes: string[] = [];
  const agentIds: string[] = [];
  const netPnlByAgent: Record<string, number> = {};
  for (const s of scenarios) {
    if (!regimes.includes(s.regime)) regimes.push(s.regime);
    for (const agent of s.agents) {
      if (agent.baseline) continue;
      if (!agentIds.includes(agent.id)) agentIds.push(agent.id);
      netPnlByAgent[agent.id] =
        (netPnlByAgent[agent.id] ?? 0) + agent.netPnlUsdc;
    }
  }

  const byOrdinal = new Map(scenarios.map((s, i) => [ordinalOf(s, i), s]));
  const regimeOf = new Map([...byOrdinal].map(([o, s]) => [o, s.regime]));
  const tByRegime: Standings["tByRegime"] = {};
  for (const row of scored.agents) {
    const lists = new Map<string, number[]>();
    for (const e of row.epochs) {
      const regime = regimeOf.get(e.s) ?? "?";
      lists.set(regime, [...(lists.get(regime) ?? []), e.t]);
    }
    tByRegime[row.id] = Object.fromEntries(
      [...lists].map(([r, ts]) => [r, ts.reduce((a, b) => a + b, 0) / ts.length]),
    );
  }

  const benchmarkPnl: Standings["benchmarkPnl"] = {};
  for (const e of scored.epochs)
    for (const [id, p] of Object.entries(e.benchmarkPnl)) {
      benchmarkPnl[id] = { ...(benchmarkPnl[id] ?? {}), [e.s]: p };
    }

  return {
    k,
    S: scored.S,
    rows: scored.agents,
    // scoreCompetition returns the epochs sorted by ordinal, which need not be the scenarios' order.
    epochs: scored.epochs.map((e) => {
      const s = byOrdinal.get(e.s)!;
      return { ...e, regime: s.regime, seed: s.seed, label: scenarioLabel(s) };
    }),
    regimes,
    agentIds,
    throughRound,
    endedScenarios,
    netPnlByAgent,
    tByRegime,
    benchmarkPnl,
  };
}

/**
 * Where each agent stood one round earlier, so the standings can show the move.
 *
 * At round 1 there is no previous round and every move is undefined rather than zero — zero would
 * claim the field started in the order it happens to be in.
 */
export function rankMoves(
  competition: Competition,
  rounds: Map<string, ScenarioRounds>,
  standings: Standings,
): Map<string, number | null> {
  const at = standings.throughRound;
  const out = new Map<string, number | null>();
  if (at === null || at <= 1) {
    for (const row of standings.rows) out.set(row.id, null);
    return out;
  }
  const before = buildStandings(competition, rounds, at - 1);
  const wasAt = new Map(before.rows.map((r) => [r.id, r.rank]));
  for (const row of standings.rows) {
    const was = wasAt.get(row.id);
    // Positive = moved up the table (a smaller rank).
    out.set(row.id, was === undefined ? null : was - row.rank);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the standing explained — why an agent sits where it does

export interface AgentStandingDetail {
  id: string;
  /** Every epoch the agent was scored in, with the scenario's name. */
  epochs: Array<AgentEpoch & { label: string; regime: string }>;
  tMean: number;
  /** The first tie-break (§4.6): the spread of the agent's own T series. */
  tStd: number;
  /** The second tie-break: the agent's worst epoch. */
  worstT: number;
  byRegime: { regime: string; epochs: number; tMean: number; tStd: number }[];
  /** Scenarios the agent ended with an asset value of zero or below (§4.5: bankrupt, no floor). */
  bankruptIn: { label: string; finalValueUsdc: number }[];
}

function meanOf(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdOf(xs: number[]): number {
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

export function decomposeAgent(
  agentId: string,
  competition: Competition,
  rounds: Map<string, ScenarioRounds>,
  standings: Standings,
): AgentStandingDetail | null {
  const row = standings.rows.find((r) => r.id === agentId);
  if (!row || row.epochs.length === 0) return null;
  const scenarios = competition.file.scenarios;
  const byOrdinal = new Map(scenarios.map((s, i) => [ordinalOf(s, i), s]));
  const epochs = row.epochs.map((e) => {
    const s = byOrdinal.get(e.s);
    return {
      ...e,
      label: s ? scenarioLabel(s) : `s${e.s}`,
      regime: s?.regime ?? "?",
    };
  });
  const perRegime = new Map<string, number[]>();
  for (const e of epochs)
    perRegime.set(e.regime, [...(perRegime.get(e.regime) ?? []), e.t]);
  const bankruptIn: AgentStandingDetail["bankruptIn"] = [];
  for (const s of scenarios) {
    const values = rounds.get(scenarioKey(s))?.valuesByAgent[agentId];
    const final = values
      ? epochPnlFromSeries(values)?.finalValueUsdc
      : s.agents.find((a) => a.id === agentId)?.finalValueUsdc;
    if (typeof final === "number" && final <= 0)
      bankruptIn.push({ label: scenarioLabel(s), finalValueUsdc: final });
  }
  const ts = epochs.map((e) => e.t);
  return {
    id: agentId,
    epochs,
    tMean: meanOf(ts),
    tStd: stdOf(ts),
    worstT: Math.min(...ts),
    byRegime: [...perRegime.entries()].map(([regime, list]) => ({
      regime,
      epochs: list.length,
      tMean: meanOf(list),
      tStd: stdOf(list),
    })),
    bankruptIn,
  };
}
