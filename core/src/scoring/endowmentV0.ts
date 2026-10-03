// V_0 at the epoch's first boundary: the endowment, as a floor (issue #207).
//
// P = V_K − V_0 used to read V_0 off the chain at the epoch's first boundary. The agent process is
// started before that block exists -- it has to be, so that every agent is watching when the epoch
// opens (agentsReady.ts) -- and nothing stops it from sending transactions meanwhile: setup mines
// them at once while automine is on, and the ones sent during the agents-ready wait land in the
// backlog flush. So the chain state at boundary 0 was partly the agent's doing. Move the basket to
// a second address or into a contract the scorer cannot see, bring it back during the epoch, and
// P grows by the whole endowment (~73k USDC against an honest ±200). Reordering spawn and automine
// does not close this -- an agent can send while automine is on -- so the fix is in the definition.
//
// V_0 is what the environment gave the agent -- `agent.initial`, the balances read right after
// funding -- valued at the first boundary's own marks: the fair the PriceFeed carries at that block
// and the stables' median, the same prices the measured cross-section is valued at. So the price
// side of V_0 is unchanged, and the holdings side is a number the agent cannot lower.
//
// A floor rather than a replacement: on a continuous chain (the practice devnet, ADR 0021) a
// coordinator restart re-funds every agent by assignment while the positions it holds in the venues
// survive. Those are value the environment can see at the first boundary and were never the agent's
// doing; a V_0 that ignored them would hand everyone with an open position a day-one gain.
// max(endowment, measured) keeps them, keeps the endowment as the line that cannot be moved, and is
// the identity on a fresh world. The one asymmetry is a gain made before the bell, which is not
// counted: the epoch's clock had not started. Every later boundary is measured as before.
//
// Shared by the live scorer and the post-run sweep so that `interval_series_agreement` still
// compares the same rule applied to the same block. The endowment reaches this already valued at
// the boundary's marks (reconstruct.ts endowmentValueAt, the one place both readers price it).
//
// Pure, and it has to stay so: core/src/backtest/scenarioScores.ts imports this for the V_0 flags,
// and the backtest CLI imports scenarioScores.ts *before* it sets ERIS_LOCAL_DEPLOY and loads the
// coordinator (backtest.ts: "dependency-light"). sdk/src/constants.ts fixes the address overlay at
// import time, so a value import of the sdk from here -- the first version imported valueUsdc --
// froze the fork registry for the whole process, and every scenario died at setup with
// `markets: unknown token symbol "WBTC"` (CI run 36989637551). test/cliImportsBeforeEnv.test.ts
// walks the CLI's static imports so that this cannot come back.

/** Which side of the floor V_0 came from. Recorded beside P so a reader can tell. */
export type V0Source = "endowment" | "measured";

export type FirstBoundaryV0 = {
  /** V_0 as the series carries it: max(endowment, measured). Null when neither was available. */
  valueUsdc: number | null;
  source: V0Source;
  /** The chain state at the boundary -- the V_0 of before. Null when the cross-section did not report. */
  measuredUsdc: number | null;
  /** The endowment at the boundary's marks. Absent when the environment did not fund the agent. */
  endowmentUsdc?: number;
};

/**
 * V_0 for one agent at the epoch's first boundary.
 *
 * `measuredUsdc` is the agent's value read off the chain at that block; `endowmentUsdc` is what
 * the environment handed it at funding, valued at that same block's marks (undefined for an agent
 * it did not fund, such as one registered mid-period and first seen at a later boundary).
 */
export function firstBoundaryV0(
  measuredUsdc: number | null,
  endowmentUsdc: number | undefined,
): FirstBoundaryV0 {
  if (endowmentUsdc === undefined || !Number.isFinite(endowmentUsdc))
    return { valueUsdc: measuredUsdc, source: "measured", measuredUsdc };
  const measured =
    typeof measuredUsdc === "number" && Number.isFinite(measuredUsdc)
      ? measuredUsdc
      : null;
  // The chain showing more than the endowment is value the environment can see and did not give
  // (positions carried into a continuous period): it counts. Showing less is the case this exists
  // for, and the endowment stands.
  if (measured !== null && measured > endowmentUsdc)
    return {
      valueUsdc: measured,
      source: "measured",
      measuredUsdc: measured,
      endowmentUsdc,
    };
  return {
    valueUsdc: endowmentUsdc,
    source: "endowment",
    measuredUsdc: measured,
    endowmentUsdc,
  };
}

// How far the chain may sit from the endowment at the first boundary before it is worth a reader's
// attention. The two are valued at the same marks, so an agent that did nothing before the bell
// sits at exactly zero; what an honest agent can spend there is gas (well under a dollar on anvil)
// and the spread of a trade it chose to make early. 0.1% of a 73k basket is ~73 USDC: above both,
// and far below anything that would have moved P.
export const V0_GAP_TOLERANCE_FRAC = 0.001;
export const V0_GAP_TOLERANCE_USDC = 10;

/**
 * measured − endowment when the gap is beyond tolerance, else null. Negative: value left the
 * account before the first boundary. Positive: value the environment did not fund was there.
 */
export function v0GapBeyondTolerance(
  measuredUsdc: number,
  endowmentUsdc: number,
): number | null {
  const gap = measuredUsdc - endowmentUsdc;
  const tolerance = Math.max(
    V0_GAP_TOLERANCE_USDC,
    Math.abs(endowmentUsdc) * V0_GAP_TOLERANCE_FRAC,
  );
  return Math.abs(gap) > tolerance ? gap : null;
}
