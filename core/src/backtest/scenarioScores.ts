// From a run's summary.json to one scenario's per-agent scores (ADR 0016 / ADR 0017 §3).
//
// Pure apart from the one file read, and out of the CLI so it can be tested: what reaches
// matrix.json is decided here -- which number is P, which facts travel beside it as flags, and how
// N repeats of one scenario fold into one record.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentScore } from "./standings.js";

export type AgentSummary = {
  id: string;
  baseline?: boolean;
  // Rules §2.2: the participant unit (coordinator; absent on a roster that did not state one).
  participant?: string;
  // Rules §4.4.1's P, off the epoch boundaries (coordinator; absent on a run recorded before it).
  pnlUsdc?: number;
  alphaUsdc?: number;
  netPnlUsdc?: number;
  initialValueUsdc?: number;
  finalValueUsdc?: number;
  processExitedEarly?: string;
  unloggedTxCount?: number;
};

export type RunSummary = {
  runDir: string;
  blocksProcessed?: number;
  agents: AgentSummary[];
  violations: Array<{ ownerId?: string }>;
};

export function readRunSummary(runDir: string): RunSummary | undefined {
  const path = join(runDir, "summary.json");
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    blocksProcessed?: number;
    agents?: AgentSummary[];
    violations?: Array<{ ownerId?: string }>;
  };
  return {
    runDir,
    blocksProcessed: parsed.blocksProcessed,
    agents: parsed.agents ?? [],
    violations: parsed.violations ?? [],
  };
}

// summary.json -> one epoch's P per agent (rules §4.4.1), plus the facts a reader should see next
// to it. Nothing here disqualifies: after the 2026-09-06 amendment a stopped agent is scored on what
// it left behind (§2.3, §4.4.2), and a §8 matter is the operator's to judge. An agent the summary
// does not know at all was not placed in the epoch, so it carries no P and is not in the population.
export function scoresFromSummary(
  summary: RunSummary,
  expectedAgentIds: readonly string[],
): AgentScore[] {
  const offenders = new Set(
    summary.violations
      .map((v) => v.ownerId)
      .filter((id): id is string => typeof id === "string"),
  );
  const reported = new Map(summary.agents.map((a) => [a.id, a]));
  const ids =
    expectedAgentIds.length > 0 ? expectedAgentIds : [...reported.keys()];
  return ids.map((id) => {
    const agent = reported.get(id);
    if (!agent)
      return { id, flags: ["absent from summary.json (was not placed)"] };
    const flags: string[] = [];
    if (offenders.has(id))
      flags.push(
        "priority fee cap violation (rules §8; for the operator to judge)",
      );
    if (agent.processExitedEarly !== undefined)
      flags.push(`process exited early: ${agent.processExitedEarly}`);
    if ((agent.unloggedTxCount ?? 0) > 0)
      flags.push(
        `${agent.unloggedTxCount} on-chain tx(s) absent from the agent's submitted log`,
      );
    // P off the epoch boundaries when the run recorded it; a run from before that field marks both
    // ends at the final prices, which differs by a per-run constant and is said so.
    const pnl: Pick<AgentScore, "pnlUsdc" | "pnlSource"> =
      agent.pnlUsdc !== undefined
        ? { pnlUsdc: agent.pnlUsdc, pnlSource: "epoch-boundaries" }
        : agent.netPnlUsdc !== undefined
          ? { pnlUsdc: agent.netPnlUsdc, pnlSource: "endpoints" }
          : {};
    if (pnl.pnlUsdc === undefined) flags.push("no P in summary.json");
    return {
      id,
      ...pnl,
      netPnlUsdc: agent.netPnlUsdc,
      alphaUsdc: agent.alphaUsdc,
      baseline: agent.baseline ?? false,
      // Rules §2.2: kept beside the score so a unit's two submissions can be collapsed to the higher
      // one by whoever reads the matrix (the standings rank agents; the unit is the reader's step).
      ...(agent.participant !== undefined
        ? { participant: agent.participant }
        : {}),
      // The endpoints behind P, so a stored matrix can be rescored after the run directory is gone.
      ...(agent.initialValueUsdc !== undefined
        ? { initialValueUsdc: agent.initialValueUsdc }
        : {}),
      ...(agent.finalValueUsdc !== undefined
        ? { finalValueUsdc: agent.finalValueUsdc }
        : {}),
      ...(flags.length > 0 ? { flags } : {}),
    };
  });
}

// Fold N repeats of one scenario into a single per-agent record by picking, for each agent, the
// repeat whose ranking metric is the median and reporting *that repeat's whole record*.
//
// Not a per-metric median: taking the median of netPnlUsdc and of alphaUsdc independently can report
// a pair that no single run produced, and then the run directory recorded alongside explains
// neither. Since --repeat exists so a calibration number can be traced back to a run, the reported
// numbers have to come from one.
export function foldRepeats(runs: AgentScore[][]): AgentScore[] {
  if (runs.length === 1) return runs[0];
  const ids: string[] = [];
  for (const run of runs)
    for (const a of run) if (!ids.includes(a.id)) ids.push(a.id);
  return ids.map((id) => {
    const entries = runs
      .map((run) => run.find((a) => a.id === id))
      .filter((a): a is AgentScore => a !== undefined);
    // A flag raised in any repeat is kept: the failure is a property of the agent, and letting a
    // lucky repeat wash it out would defeat the point of recording it.
    const flags = [...new Set(entries.flatMap((a) => a.flags ?? []))];
    const scored = entries.filter(
      (a) => typeof a.pnlUsdc === "number" && Number.isFinite(a.pnlUsdc),
    );
    const chosen =
      scored.length > 0
        ? scored.sort((a, b) => (a.pnlUsdc as number) - (b.pnlUsdc as number))[
            Math.floor((scored.length - 1) / 2)
          ]
        : entries[0];
    return {
      ...chosen,
      id,
      ...(flags.length > 0 ? { flags } : {}),
    };
  });
}
