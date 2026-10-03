// From a run's summary.json to one scenario's per-agent scores (ADR 0016 / ADR 0017 §3).
//
// Pure apart from the one file read, and out of the CLI so it can be tested: what reaches
// matrix.json is decided here -- which number is P, which facts travel beside it as flags, and how
// N repeats of one scenario fold into one record.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentScore } from "./standings.js";
import {
  v0GapBeyondTolerance,
  type V0Source,
} from "../scoring/endowmentV0.js";

export type AgentSummary = {
  id: string;
  baseline?: boolean;
  // Rules §2.2: the participant unit (coordinator; absent on a roster that did not state one).
  participant?: string;
  // Rules §4.4.1's P, off the interval series' first and last boundary (coordinator; absent on a
  // run recorded before it).
  pnlUsdc?: number;
  // How V_0 behind pnlUsdc was derived, and the three numbers behind that (issue #207): V_0 as P
  // used it, the chain state at the first boundary, the endowment at that boundary's marks.
  v0Source?: V0Source;
  v0Usdc?: number;
  v0MeasuredUsdc?: number;
  v0EndowmentUsdc?: number;
  alphaUsdc?: number;
  netPnlUsdc?: number;
  initialValueUsdc?: number;
  finalValueUsdc?: number;
  processExitedEarly?: string;
  unloggedTxCount?: number;
};

// pnlUsdc − netPnlUsdc is near-constant across a field that started with the same basket: P marks
// V_0 at the first boundary and netPnlUsdc marks the same endowment at the final prices, so the two
// differ by endowment × (final − opening fair) for everyone. An agent whose difference sits far off
// the field's had a V_0 that was not its endowment, by whatever path (issue #207): the direct check
// below covers the one path that is known, this covers the ones that are not.
//
// "Near" is doing work, and the tolerance has to come from the field rather than from a guess. The
// two numbers do not read the same valuation: netPnlUsdc sums `adapter.valueUsdc` (the face mark)
// at the last block, while P sums `liquidatableValueUsdc` off the boundary series (what the holding
// could be realized for, ADR 0022 Amendment 1). Anything whose two marks differ -- an LST share
// against its par, a Trove, a lending position, an LP, and since #205 a market-priced stable at the
// holder's own size against the probe's mid -- separates the two by its own haircut. That is a real
// number about the position, not a sign of anything, and it is the normal state of most strategies
// that are not pure spot.
//
// So the band is the field's own dispersion: the median gap, plus the larger of a fixed floor, a
// fraction of the basket, and a multiple of the median absolute deviation of the gaps. A field in
// which several agents carry haircut positions widens its own band and none of them is flagged; an
// agent that moved its endowment before the bell sits outside a band built from everyone else.
// This check is the second net either way -- the V_0-against-endowment check below is the one that
// names the attack, and it does not depend on the field at all.
export const PNL_GAP_TOLERANCE_FRAC = 0.02;
export const PNL_GAP_TOLERANCE_USDC = 100;
// Multiple of the gaps' MAD. 4 sits above the dispersion a mixed field produces on its own and
// below the endowment-sized step the attack makes.
export const PNL_GAP_MAD_MULT = 4;
// Fewer agents than this and the median is not a field constant, it is one agent's number.
const PNL_GAP_MIN_FIELD = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The field's constant and its tolerance, or undefined when the field is too small to have one.
function pnlGapReference(
  agents: readonly AgentSummary[],
): { medianGap: number; tolerance: number } | undefined {
  const gaps: number[] = [];
  const scales: number[] = [];
  for (const a of agents) {
    if (
      typeof a.pnlUsdc !== "number" ||
      typeof a.netPnlUsdc !== "number" ||
      !Number.isFinite(a.pnlUsdc) ||
      !Number.isFinite(a.netPnlUsdc)
    )
      continue;
    gaps.push(a.pnlUsdc - a.netPnlUsdc);
    const scale = a.v0EndowmentUsdc ?? a.initialValueUsdc ?? a.v0Usdc;
    if (typeof scale === "number" && Number.isFinite(scale))
      scales.push(Math.abs(scale));
  }
  if (gaps.length < PNL_GAP_MIN_FIELD) return undefined;
  const scale = scales.length > 0 ? median(scales) : 0;
  const medianGap = median(gaps);
  // Median absolute deviation: the field's own spread, which a mixed field of haircut positions
  // produces without anybody doing anything wrong.
  const mad = median(gaps.map((g) => Math.abs(g - medianGap)));
  return {
    medianGap,
    tolerance: Math.max(
      PNL_GAP_TOLERANCE_USDC,
      scale * PNL_GAP_TOLERANCE_FRAC,
      mad * PNL_GAP_MAD_MULT,
    ),
  };
}

const usdc = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

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
  const gapReference = pnlGapReference(summary.agents);
  return ids.map((id) => {
    const agent = reported.get(id);
    if (!agent)
      return { id, flags: ["absent from summary.json (was not placed)"] };
    const flags: string[] = [];
    if (offenders.has(id))
      flags.push(
        "priority fee rule violation: over the cap, or maxFeePerGas above the tip " +
          "(rules §2.6 / §8; for the operator to judge)",
      );
    if (agent.processExitedEarly !== undefined)
      flags.push(`process exited early: ${agent.processExitedEarly}`);
    if ((agent.unloggedTxCount ?? 0) > 0)
      flags.push(
        `${agent.unloggedTxCount} on-chain tx(s) absent from the agent's submitted log`,
      );
    // Issue #207, the known path: what the chain showed at the first boundary against what the
    // environment had funded, both at that boundary's marks. P is already taken off the floored
    // V_0 either way; the flag is the operator's cue that the agent acted before the bell.
    if (
      typeof agent.v0MeasuredUsdc === "number" &&
      typeof agent.v0EndowmentUsdc === "number"
    ) {
      const gap = v0GapBeyondTolerance(
        agent.v0MeasuredUsdc,
        agent.v0EndowmentUsdc,
      );
      if (gap !== null)
        flags.push(
          gap < 0
            ? `V_0 measured at the first boundary was ${usdc(-gap)} USDC below the endowment ` +
                `(${usdc(agent.v0MeasuredUsdc)} vs ${usdc(agent.v0EndowmentUsdc)}): the holdings at the ` +
                "first boundary were worth less than the endowment (moved out, or spent on trades that " +
                "landed before the bell); V_0 was taken at the endowment (issue #207)"
            : `V_0 measured at the first boundary was ${usdc(gap)} USDC above the endowment ` +
                `(${usdc(agent.v0MeasuredUsdc)} vs ${usdc(agent.v0EndowmentUsdc)}): value the ` +
                "environment did not fund was there before the epoch's first boundary; V_0 was taken " +
                "as measured (issue #207)",
        );
    }
    // Issue #207, any other path: the field's pnlUsdc − netPnlUsdc constant (see pnlGapReference).
    if (
      gapReference &&
      typeof agent.pnlUsdc === "number" &&
      typeof agent.netPnlUsdc === "number"
    ) {
      const gap = agent.pnlUsdc - agent.netPnlUsdc;
      const off = gap - gapReference.medianGap;
      if (Math.abs(off) > gapReference.tolerance)
        flags.push(
          `pnlUsdc − netPnlUsdc is ${usdc(Math.abs(off))} USDC off the field's constant ` +
            `(${usdc(gap)} vs median ${usdc(gapReference.medianGap)}): V_0 and the endowment ` +
            "diverged by some path (issue #207)",
        );
    }
    // P off the epoch's two boundaries when the run recorded it; a run from before that field marks
    // both ends at the final prices, which differs by a per-run constant and is said so.
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
      ...(agent.v0Source !== undefined ? { v0Source: agent.v0Source } : {}),
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

export const EXITED_EARLY_FLAG = /^process exited early:/;

// What a reader of matrix.json / standings.json has to see about the epoch as a whole. The
// per-agent flags say who died; they do not say that *everyone* did, and an epoch in which every
// agent exited at boot was written up as a scored epoch -- reconstruction ran, P ≈ 0 for all, the
// standings moved (issue #102, #91 F2; 32 × `agent_process_exited` at +41 s in the docker fixture,
// 13 of 31 at boot in the check matrix's s=6). The baseline is not counted: it is placed and valued
// but never in the population, so it cannot make an epoch contested.
export function scenarioFlags(agents: readonly AgentScore[]): string[] {
  const field = agents.filter((a) => !a.baseline);
  if (field.length === 0) return [];
  const exited = field.filter((a) =>
    (a.flags ?? []).some((f) => EXITED_EARLY_FLAG.test(f)),
  );
  if (exited.length === 0) return [];
  if (exited.length === field.length)
    return [
      `uncontested: every non-baseline agent (${field.length}) exited early; ` +
        "the P of this epoch are the endowment's drift, not a result (rules §4.4.2: re-execution " +
        "is the remedy, and it is the operator's call)",
    ];
  return [
    `${exited.length} of ${field.length} non-baseline agents exited early`,
  ];
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
