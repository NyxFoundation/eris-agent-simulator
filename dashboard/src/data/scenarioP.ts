// P(a, s) for one agent in one scenario, from what the competition's artifacts say about it.
//
// Two sources, and which one speaks is the point:
//
//   the boundary series   summary.json's epoch series (or epochs.jsonl while the run goes). When it
//                         has this agent, P is its two ends (core/src/scoring/epochPnl.ts) -- or
//                         nothing. An agent whose V_0 is null was not measured at the epoch's start
//                         (registered mid-segment, ADR 0021 §2) and has no P, however many later
//                         boundaries it appears at
//   the stored record     matrix.json's per-agent numbers, for a scenario whose run directory was
//                         not collected: `pnlUsdc` (the rules' figure), else `netPnlUsdc` (a matrix
//                         recorded before P existed, both ends at the final marks)
//
// The series wins whenever it holds the agent. Falling through from "a series that yields no P" to
// the stored `netPnlUsdc` is how a mid-period registrant came to be scored on P = 0 -- the old
// segment writer collapsed the missing value into `netPnlUsdc: 0`, and zero beats every agent that
// lost (issue #84 X2). "The series exists but P cannot be formed" is a different fact from "there is
// no series", and only the second is allowed to read the stored number.
//
// No aliases here (`@core`, `@/`): the rule is tested under node, which resolves only real paths.

import { epochPnlFromSeries } from "../../../core/src/scoring/epochPnl.js";

export interface StoredAgentP {
  pnlUsdc?: number;
  netPnlUsdc?: number;
  /** Written false by the segment writer for an agent it did not place. */
  scored?: boolean;
}

/**
 * P for the agent, or undefined when it was not placed in this epoch (rules §4.4.2: out of the
 * population, scored on the rest).
 */
export function scenarioAgentP(
  agent: StoredAgentP,
  seriesValues: ReadonlyArray<number | null | undefined> | undefined,
): number | undefined {
  if (agent.scored === false) return undefined;
  if (seriesValues !== undefined && seriesValues.length >= 2) {
    const p = agent.pnlUsdc ?? epochPnlFromSeries(seriesValues)?.pnlUsdc;
    return typeof p === "number" && Number.isFinite(p) ? p : undefined;
  }
  const p = agent.pnlUsdc ?? agent.netPnlUsdc;
  return typeof p === "number" && Number.isFinite(p) ? p : undefined;
}
