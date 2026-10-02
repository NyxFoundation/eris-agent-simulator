// Issue #207: V_0 at the epoch's first boundary is floored at the endowment, valued at that
// boundary's own marks. The chain state at the first boundary was partly the agent's doing -- the
// process is started before the block exists -- so a V_0 read off it could be lowered by parking the
// basket somewhere the scorer cannot see. What is pinned here is the rule itself; where it is
// applied (the live scorer, the sweep, summary.json) is pinned in liveScoring.test.ts and v0Flags.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  firstBoundaryV0,
  v0GapBeyondTolerance,
  V0_GAP_TOLERANCE_FRAC,
  V0_GAP_TOLERANCE_USDC,
} from "../core/src/scoring/endowmentV0.js";
import { TOKENS } from "@eris/sdk/constants.js";
import { PAR_STABLE_PRICES } from "@eris/sdk/stables.js";
import type { BalanceSnapshot } from "@eris/sdk/types.js";

const WAD = 10n ** 18n;
const USDC = TOKENS.USDC.address.toLowerCase();

// The competition basket, less WBTC: 8 WETH + 25,000 USDC, and 1 ETH for gas.
const ENDOWMENT: BalanceSnapshot = {
  ethWei: WAD,
  wethWei: 8n * WAD,
  usdcUnits: 25_000_000_000n,
  bases: { WETH: 8n * WAD },
  stables: { [USDC]: 25_000_000_000n },
};
const MARKS = { fairByBase: { WETH: 3_000 }, stablePrices: PAR_STABLE_PRICES };
// (1 + 8) × 3,000 + 25,000
const ENDOWMENT_AT_MARKS = 52_000;

test("a basket that left before the bell does not lower V_0: the endowment stands", () => {
  // The attack: 50k of the 52k parked in a second address, 2k left on the chain at boundary 0.
  const v0 = firstBoundaryV0(2_000, ENDOWMENT, MARKS);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_MARKS);
  assert.equal(v0.source, "endowment");
  assert.equal(v0.measuredUsdc, 2_000, "what the chain showed is kept beside it");
  assert.equal(v0.endowmentUsdc, ENDOWMENT_AT_MARKS);
});

test("the endowment is valued at the boundary's marks, not at funding's", () => {
  // Same basket, fair moved to 2,500 by the first boundary: V_0 follows the marks, as the measured
  // value would have. The price side of V_0 is unchanged by the rule; only the holdings side is.
  const v0 = firstBoundaryV0(0, ENDOWMENT, {
    fairByBase: { WETH: 2_500 },
    stablePrices: PAR_STABLE_PRICES,
  });
  assert.equal(v0.valueUsdc, 9 * 2_500 + 25_000);
});

test("an agent that did nothing before the bell is at the floor exactly", () => {
  const v0 = firstBoundaryV0(ENDOWMENT_AT_MARKS, ENDOWMENT, MARKS);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_MARKS);
  assert.equal(v0.source, "endowment");
  assert.equal(
    v0GapBeyondTolerance(v0.measuredUsdc!, v0.endowmentUsdc!),
    null,
    "no gap to report",
  );
});

test("value the environment can see above the endowment counts: a floor, not a replacement", () => {
  // A continuous period's restart re-funds by assignment while venue positions survive; a V_0 that
  // ignored them would hand the agent a day-one gain of their whole value.
  const v0 = firstBoundaryV0(ENDOWMENT_AT_MARKS + 30_000, ENDOWMENT, MARKS);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_MARKS + 30_000);
  assert.equal(v0.source, "measured");
  assert.equal(v0.endowmentUsdc, ENDOWMENT_AT_MARKS, "still recorded for the reader");
});

test("no endowment is the measured value, and says so", () => {
  // An agent the environment did not fund before the series began (registered mid-period): the
  // boundary it first appears at is its V_0, as before.
  assert.deepEqual(firstBoundaryV0(40_000, undefined, MARKS), {
    valueUsdc: 40_000,
    source: "measured",
    measuredUsdc: 40_000,
  });
  assert.deepEqual(firstBoundaryV0(null, undefined, MARKS), {
    valueUsdc: null,
    source: "measured",
    measuredUsdc: null,
  });
});

test("a cross-section that did not report the agent still has the endowment to stand on", () => {
  const v0 = firstBoundaryV0(null, ENDOWMENT, MARKS);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_MARKS);
  assert.equal(v0.source, "endowment");
  assert.equal(v0.measuredUsdc, null);
});

test("the gap tolerance covers gas and an early trade's spread, not a parked basket", () => {
  assert.equal(V0_GAP_TOLERANCE_FRAC, 0.001);
  assert.equal(V0_GAP_TOLERANCE_USDC, 10);
  // 0.1% of 52,000 = 52 USDC: a few approvals' gas and a 1 WETH swap's 30 bps sit inside it.
  assert.equal(v0GapBeyondTolerance(52_000 - 40, 52_000), null);
  assert.equal(v0GapBeyondTolerance(52_000 - 60, 52_000), -60);
  assert.equal(v0GapBeyondTolerance(2_000, 52_000), -50_000);
  // The sign says which way: above the endowment is value the environment did not fund.
  assert.equal(v0GapBeyondTolerance(82_000, 52_000), 30_000);
  // A small endowment has the absolute floor, so a dollar of gas is never a finding.
  assert.equal(v0GapBeyondTolerance(100 - 9, 100), null);
  assert.equal(v0GapBeyondTolerance(100 - 11, 100), -11);
});
