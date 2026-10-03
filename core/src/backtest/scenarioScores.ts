// From a run's summary.json to one scenario's per-agent scores (ADR 0016 / ADR 0017 §3).
//
// Pure apart from the one file read, and out of the CLI so it can be tested: what reaches
// matrix.json is decided here -- which number is P, which facts travel beside it as flags, and how
// N repeats of one scenario fold into one record.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentScore } from "./standings.js";
import {
  rosterTransferFlag,
  type RosterTransfer,
} from "../rosterTransfers.js";
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
  // Issue #208 / rules §8: flagged value movements between this agent and another registered
  // address (coordinator; absent when there were none, and on runs recorded before the check).
  rosterTransfers?: RosterTransfer[];
};

// There is no second detector off `pnlUsdc − netPnlUsdc`. The idea was that the difference is a
// field constant -- P marks V_0 at the first boundary, netPnlUsdc marks the same endowment at the
// final prices -- so an agent sitting off it had a V_0 that was not its endowment by some path the
// direct check below does not name. The premise is false. The two numbers read different
// valuations: netPnlUsdc sums `adapter.valueUsdc` (the face mark) at the last block, while P sums
// `liquidatableValueUsdc` off the boundary series (ADR 0022 Amendment 1). Every position whose two
// marks differ -- an LST share against its par, a Trove, a lending position, an LP, a
// market-priced stable at the holder's own size against the probe's mid -- separates them by its
// own haircut, which is the normal state of anything that is not pure spot.
//
// Two bands were tried. A fixed 2% of the basket flagged the depeg field's own arbitrageur (2,546
// USDC against a 1,520 band) every run. Taking the band from the field's median absolute deviation
// held only where haircut holders are a majority: measured on the real module, adding one spot
// agent to a 3-of-6 field put the flag back on three honest agents, and a 25-agent roster needs
// more than 13 haircut holders before the band moves at all. A flag that is on for honest play is
// worse than no flag -- it is read as an accusation, and the operator learns to ignore the field.
//
// What names the attack is the check below: the chain's V_0 at the first boundary against what the
// environment funded, both at that boundary's marks. It reads one agent's own numbers and does not
// depend on the field. `interval_v0_floor_skipped` covers the one epoch where that check cannot
// fire because the floor was never applied.

const usdc = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export type RunSummary = {
  runDir: string;
  blocksProcessed?: number;
  agents: AgentSummary[];
  violations: Array<{ ownerId?: string }>;
  // Set when the run's first block was not read, so V_0 carries no endowment floor (issue #207).
  // An epoch-wide fact, not an agent's, and it has to be said per agent anyway: the operator reads
  // flags beside a score, and without the floor the per-agent check that names the attack has no
  // endowment V_0 to compare against.
  v0FloorSkipped?: { boundaryBlock?: number; runStartBlock?: number };
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
        "priority fee rule violation: over the cap, or maxFeePerGas above the tip " +
          "(rules §2.6 / §8; for the operator to judge)",
      );
    if (summary.v0FloorSkipped) {
      const { boundaryBlock: at, runStartBlock: want } = summary.v0FloorSkipped;
      flags.push(
        `V_0 has no endowment floor in this epoch: the run's first block (${want ?? "?"}) was not ` +
          `read, so V_0 is the measured value at block ${at ?? "?"} (issue #207). A value moved out ` +
          "before that block counts as this agent's PnL, and the check that would name it has no " +
          "endowment V_0 to compare against",
      );
    }
    if (agent.processExitedEarly !== undefined)
      flags.push(`process exited early: ${agent.processExitedEarly}`);
    if ((agent.unloggedTxCount ?? 0) > 0)
      flags.push(
        `${agent.unloggedTxCount} on-chain tx(s) absent from the agent's submitted log`,
      );
    // One line per flagged movement (issue #208). Both ends where both chose it: two submissions of
    // one unit paying each other, or a transfer over the threshold, which takes a real position to
    // make. The sender alone where the far end could not have refused -- an ERC-20 transfer needs no
    // consent, and the scorer prices neither an LST share in a wallet nor a launch token, so one wei
    // of either would otherwise let anyone write a §8 line into anyone's record.
    for (const t of agent.rosterTransfers ?? []) {
      if (t.flagSide === "sender" && t.from !== id) continue;
      flags.push(rosterTransferFlag(t, id));
    }
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
