// Scenario-matrix standings under the competition rules (§4.4, §4.6; ADR 0023).
//
// A matrix run is a rehearsal of the live competition: every scenario is one epoch, run in the
// order given, and the standings are what the live leaderboard would show -- P per agent per epoch,
// standardised within the epoch, weighted by the scheduled ordinal, averaged. The arithmetic lives
// in scoring/deviationScore.ts; this file maps run summaries onto its input and back.
//
// Pure. No filesystem, no chain. The CLI collects summaries and hands them here, so the standings
// can be recomputed from a stored matrix.json without re-running anything (ADR 0017 §4).

import {
  scoreCompetition,
  type AgentResult,
  type EpochInput,
  type EpochResult,
} from "../scoring/deviationScore.js";

export type PnlSource = "epoch-boundaries" | "endpoints";

export type AgentScore = {
  id: string;
  // P(a, s): the rules' V_K − V_0 read off the epoch boundaries (summary.json `pnlUsdc`) or, for a
  // run recorded before that field existed, netPnlUsdc (both ends at the final marks, which differs
  // by a per-run constant when everyone starts with the same basket). `pnlSource` says which.
  // Absent when the agent was not placed in the epoch: it is then not in the population.
  pnlUsdc?: number;
  pnlSource?: PnlSource;
  netPnlUsdc?: number;
  alphaUsdc?: number;
  initialValueUsdc?: number;
  finalValueUsdc?: number;
  // §4.3: placed and valued, kept out of the population.
  baseline?: boolean;
  // Rules §2.2: the participant unit this agent is one submission of. Two agents sharing it are the
  // same unit, scored on the higher of the two. Carried, not used: the arithmetic below ranks
  // agents, and collapsing a unit's two entries is the reader's step (the dashboard's), so it stays
  // visible in matrix.json for anyone re-deriving the ranking (ADR 0017 §4).
  participant?: string;
  // Facts a reader should see next to the number: a fee-cap violation, a process that exited early,
  // transactions the runtime never reported. None of them changes P (rules §2.3 and §4.4.2 after the
  // 2026-09-06 amendment: a stopped agent is scored on what it left behind); §8 matters are the
  // operator's to judge, not the scorer's.
  flags?: string[];
};

export type ScenarioResult = {
  // Scheduled ordinal, 1-based (§4.4.1).
  s: number;
  regime: string;
  seed: number;
  // Absent when the run produced no summary at all. Such an epoch is invalid for everyone (§4.4.2);
  // it is never charged to some participants and not others.
  agents?: AgentScore[];
  runDir?: string;
  error?: string;
  // The plan's intended start for this epoch (ISO 8601), when the plan had a timetable.
  startsAt?: string;
};

export type EpochStanding = EpochResult & {
  regime: string;
  seed: number;
  runDir?: string;
};

export type Standings = {
  k: number;
  // The ordinals the final score was computed from (§4.4.1: published with the ranking).
  S: number[];
  epochs: EpochStanding[];
  // Sorted by rank (§4.6). `participant` is the rules §2.2 unit when the roster stated one; the
  // ranking is still per agent, and collapsing a unit to its higher submission is the reader's step.
  agents: Array<AgentResult & { flags: string[]; participant?: string }>;
  // Placed in every epoch, shown for reference, never in the population (§4.3).
  benchmarks: Array<{ id: string; pnlByEpoch: Record<number, number> }>;
};

export function scenarioId(regime: string, seed: number): string {
  return `${regime}#${seed}`;
}

export function computeStandings(
  results: ScenarioResult[],
  k: number,
): Standings {
  const epochs: EpochInput[] = results.map((r) => {
    if (!r.agents || r.agents.length === 0)
      return {
        s: r.s,
        pnlByAgent: {},
        invalid: r.error ?? "no summary.json",
      };
    const pnlByAgent: Record<string, number> = {};
    const benchmarkIds: string[] = [];
    for (const a of r.agents) {
      if (a.pnlUsdc === undefined) continue;
      pnlByAgent[a.id] = a.pnlUsdc;
      if (a.baseline) benchmarkIds.push(a.id);
    }
    return { s: r.s, pnlByAgent, benchmarkIds };
  });
  const scored = scoreCompetition({ epochs, k });

  const flagsByAgent = new Map<string, string[]>();
  const benchmarkPnl = new Map<string, Record<number, number>>();
  const participantByAgent = new Map<string, string>();
  for (const r of results) {
    for (const a of r.agents ?? []) {
      if (a.participant !== undefined)
        participantByAgent.set(a.id, a.participant);
      for (const f of a.flags ?? []) {
        const list = flagsByAgent.get(a.id) ?? [];
        list.push(`${scenarioId(r.regime, r.seed)}: ${f}`);
        flagsByAgent.set(a.id, list);
      }
      if (a.baseline && a.pnlUsdc !== undefined) {
        const by = benchmarkPnl.get(a.id) ?? {};
        by[r.s] = a.pnlUsdc;
        benchmarkPnl.set(a.id, by);
      }
    }
  }
  const byOrdinal = new Map(results.map((r) => [r.s, r]));
  return {
    k,
    S: scored.S,
    epochs: scored.epochs.map((e) => {
      const r = byOrdinal.get(e.s)!;
      return {
        ...e,
        regime: r.regime,
        seed: r.seed,
        ...(r.runDir !== undefined ? { runDir: r.runDir } : {}),
      };
    }),
    agents: scored.agents.map((a) => ({
      ...a,
      flags: flagsByAgent.get(a.id) ?? [],
      ...(participantByAgent.has(a.id)
        ? { participant: participantByAgent.get(a.id) }
        : {}),
    })),
    benchmarks: [...benchmarkPnl.entries()].map(([id, pnlByEpoch]) => ({
      id,
      pnlByEpoch,
    })),
  };
}
