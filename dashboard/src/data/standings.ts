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
import type {
  Competition,
  CompetitionScenario,
  ScenarioAgentResult,
} from "./competition";
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

// The head of events.jsonl holds agents_registered; enough to learn who the benchmark is.
const HEAD_BYTES = 128 * 1024;

/**
 * The boundary series of a run still in progress, off the artifacts the coordinator writes *as*
 * boundaries are read (core/src/realtime/liveScoring.ts): epochs.jsonl, one line per boundary with
 * every agent's value. summary.json only exists at the end, and on the practice devnet the end of
 * a segment is midnight -- without this the whole day would be empty until then (ADR 0021 §3 is
 * what makes the values exist live in the first place).
 *
 * A segment's own epochs.jsonl starts at its first boundary, so the epoch that straddles the
 * rollover is not in it until the segment closes and summary.json carries the previous boundary in.
 */
async function loadLiveSeries(
  runId: string,
): Promise<Pick<ScenarioRounds, "valuesByAgent" | "baselineIds">> {
  const base = `/runs/${encodeURIComponent(runId)}`;
  const [epochsText, headText] = await Promise.all([
    fetch(`${base}/epochs.jsonl`)
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => ""),
    fetch(`${base}/tail/events.jsonl?offset=0&limit=${HEAD_BYTES}`)
      .then((r) => (r.ok ? r.json() : { text: "" }))
      .then((b) => (b as { text?: string }).text ?? "")
      .catch(() => ""),
  ]);
  const boundaries: Record<string, number | null>[] = [];
  for (const line of epochsText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        values?: Record<string, number | null>;
      };
      if (row.values && typeof row.values === "object")
        boundaries.push(row.values);
    } catch {
      // the last line may still be being written
    }
  }
  const ids = new Set<string>();
  for (const b of boundaries) for (const id of Object.keys(b)) ids.add(id);
  const valuesByAgent: Record<string, Array<number | null>> = {};
  for (const id of ids)
    valuesByAgent[id] = boundaries.map((b) =>
      typeof b[id] === "number" ? (b[id] as number) : null,
    );
  const baselineIds: string[] = [];
  for (const line of headText.split("\n")) {
    if (!line.includes('"agents_registered"')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        agents?: { id: string; baseline?: boolean }[];
      };
      if (event.type === "agents_registered")
        for (const a of event.agents ?? [])
          if (a.baseline) baselineIds.push(a.id);
    } catch {
      // torn line
    }
  }
  return { valuesByAgent, baselineIds };
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
        if (!res.ok) {
          if (!live.has(runId)) return null;
          // Still running: the boundaries read so far are its series, and today's rounds count.
          const series = await loadLiveSeries(runId);
          return [scenarioKey(s), { ...empty, ...series }] as const;
        }
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
): {
  pnlByAgent: Record<string, number>;
  benchmarkIds: string[];
  ended: boolean;
} {
  const series = rounds.get(scenarioKey(scenario));
  const pnlByAgent: Record<string, number> = {};
  const benchmarkIds = new Set<string>(series?.baselineIds ?? []);
  for (const a of scenario.agents) if (a.baseline) benchmarkIds.add(a.id);
  let ended = false;
  // A scenario still running has no agents in the index yet (a segment's entry is closed at
  // rollover), so the field is whoever has a value in the live series.
  const agents: Array<
    Pick<ScenarioAgentResult, "id"> & Partial<ScenarioAgentResult>
  > =
    scenario.agents.length > 0
      ? scenario.agents
      : Object.keys(series?.valuesByAgent ?? {}).map((id) => ({ id }));

  if (throughRound !== null) {
    if (!series) return { pnlByAgent, benchmarkIds: [...benchmarkIds], ended };
    for (const agent of agents) {
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

  for (const agent of agents) {
    const fromSeries = series
      ? epochPnlFromSeries(series.valuesByAgent[agent.id] ?? [])?.pnlUsdc
      : undefined;
    const p = agent.pnlUsdc ?? fromSeries ?? agent.netPnlUsdc;
    if (typeof p === "number" && Number.isFinite(p)) pnlByAgent[agent.id] = p;
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
  /**
   * Facts the runner recorded beside an agent's numbers, over every scenario (rules §4.4.2: a
   * process that exited early, a fee-cap violation, unlogged transactions). Shown, never scored.
   */
  flagsByAgent: Record<string, string[]>;
  /** Rules §2.2: which participant unit each agent is a submission of. Empty when the roster has none. */
  participantOf: Record<string, string>;
}

/** A participant unit's row (rules §2.2): its agents, and the one whose score counts. */
export interface ParticipantRow {
  participant: string;
  rank: number;
  /** The higher-scoring submission; its score is the unit's. */
  counted: AgentResult;
  agents: AgentResult[];
}

/**
 * The standings folded to participant units: a unit that entered two submissions is ranked on the
 * higher of the two (rules §2.2, "両者を平均することはありません"). Agents with no participant
 * recorded are units of their own. Ties keep the agents' order, which is already the §4.6 order.
 */
export function participantStandings(standings: Standings): ParticipantRow[] {
  const groups = new Map<string, AgentResult[]>();
  for (const row of standings.rows) {
    const unit = standings.participantOf[row.id] ?? row.id;
    groups.set(unit, [...(groups.get(unit) ?? []), row]);
  }
  const rows = [...groups].map(([participant, agents]) => {
    // rows are in rank order, so the first agent of a unit is its best.
    const counted = agents[0];
    return { participant, counted, agents };
  });
  rows.sort((a, b) => a.counted.rank - b.counted.rank);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
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
    const { pnlByAgent, benchmarkIds, ended } = scenarioPnl(
      s,
      rounds,
      throughRound,
    );
    if (ended) endedScenarios += 1;
    return { s: ordinalOf(s, i), pnlByAgent, benchmarkIds };
  });
  const scored = scoreCompetition({ epochs, k });

  const regimes: string[] = [];
  const agentIds: string[] = [];
  const netPnlByAgent: Record<string, number> = {};
  const flagsByAgent: Record<string, string[]> = {};
  const participantOf: Record<string, string> = {};
  for (const s of scenarios) {
    if (!regimes.includes(s.regime)) regimes.push(s.regime);
    for (const agent of s.agents) {
      if (agent.baseline) continue;
      if (!agentIds.includes(agent.id)) agentIds.push(agent.id);
      netPnlByAgent[agent.id] =
        (netPnlByAgent[agent.id] ?? 0) + agent.netPnlUsdc;
      for (const flag of agent.flags ?? []) {
        const list = flagsByAgent[agent.id] ?? [];
        if (!list.includes(flag)) list.push(flag);
        flagsByAgent[agent.id] = list;
      }
      if (agent.participant) participantOf[agent.id] = agent.participant;
    }
  }
  // A field that only exists in a live series (the practice devnet's current day) is still a field.
  for (const row of scored.agents)
    if (!agentIds.includes(row.id)) agentIds.push(row.id);

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
      [...lists].map(([r, ts]) => [
        r,
        ts.reduce((a, b) => a + b, 0) / ts.length,
      ]),
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
    flagsByAgent,
    participantOf,
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
