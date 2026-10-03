// Issue #207: V_0 at the epoch's first boundary is floored at the endowment, valued at that
// boundary's own marks. The chain state at the first boundary was partly the agent's doing -- the
// process is started before the block exists -- so a V_0 read off it could be lowered by parking the
// basket somewhere the scorer cannot see. What is pinned here is the rule itself and the valuation
// it is fed; where it is applied (the live scorer, the sweep, summary.json) is pinned in
// liveScoring.test.ts and v0Flags.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  firstBoundaryV0,
  v0GapBeyondTolerance,
  v0RuleFor,
  V0_GAP_TOLERANCE_FRAC,
  V0_GAP_TOLERANCE_USDC,
} from "../core/src/scoring/endowmentV0.js";
import { endowmentValueAt } from "../core/src/realtime/reconstruct.js";
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
// (1 + 8) × 3,000 + 25,000
const ENDOWMENT_AT_3000 = 52_000;

test("the endowment is valued at the boundary's marks, not at funding's", () => {
  // The same reader prices the chain's holdings at these marks; the endowment gets the same
  // prices, so the price side of V_0 is unchanged by the rule and only the holdings side is.
  assert.equal(
    endowmentValueAt(ENDOWMENT, {
      fairByBase: { WETH: 3_000 },
      stablePrices: PAR_STABLE_PRICES,
    }),
    ENDOWMENT_AT_3000,
  );
  assert.equal(
    endowmentValueAt(ENDOWMENT, {
      fairByBase: { WETH: 2_500 },
      stablePrices: PAR_STABLE_PRICES,
    }),
    9 * 2_500 + 25_000,
  );
});

test("a basket that left before the bell does not lower V_0: the endowment stands", () => {
  // The attack: 50k of the 52k parked in a second address, 2k left on the chain at boundary 0.
  const v0 = firstBoundaryV0(2_000, ENDOWMENT_AT_3000);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_3000);
  assert.equal(v0.source, "endowment");
  assert.equal(v0.measuredUsdc, 2_000, "what the chain showed is kept beside it");
  assert.equal(v0.endowmentUsdc, ENDOWMENT_AT_3000);
});

test("an agent that did nothing before the bell is at the floor exactly", () => {
  const v0 = firstBoundaryV0(ENDOWMENT_AT_3000, ENDOWMENT_AT_3000);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_3000);
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
  const v0 = firstBoundaryV0(ENDOWMENT_AT_3000 + 30_000, ENDOWMENT_AT_3000);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_3000 + 30_000);
  assert.equal(v0.source, "measured");
  assert.equal(v0.endowmentUsdc, ENDOWMENT_AT_3000, "still recorded for the reader");
});

test("no endowment is the measured value, and says so", () => {
  // An agent the environment did not fund before the series began (registered mid-period): the
  // boundary it first appears at is its V_0, as before.
  assert.deepEqual(firstBoundaryV0(40_000, undefined), {
    valueUsdc: 40_000,
    source: "measured",
    measuredUsdc: 40_000,
  });
  assert.deepEqual(firstBoundaryV0(null, undefined), {
    valueUsdc: null,
    source: "measured",
    measuredUsdc: null,
  });
});

test("a cross-section that did not report the agent still has the endowment to stand on", () => {
  const v0 = firstBoundaryV0(null, ENDOWMENT_AT_3000);
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_3000);
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

// The gift attack on the floor's upper side: before the bell, an attacker hands the victim an LP
// NFT on a pool of its own token worth W, raising the victim's measured V_0 by W; during the epoch
// it sells its token into that pool and takes W back. A world built fresh for the epoch has no
// carried positions, so there the endowment is V_0 exactly.
test("pinned: value above the endowment at the first boundary does not raise V_0", () => {
  const W = 30_000;
  const v0 = firstBoundaryV0(ENDOWMENT_AT_3000 + W, ENDOWMENT_AT_3000, "pinned");
  assert.equal(v0.valueUsdc, ENDOWMENT_AT_3000);
  assert.equal(v0.source, "endowment");
  assert.equal(v0.measuredUsdc, ENDOWMENT_AT_3000 + W, "the gift is still on the record");
  // Drained back to the endowment by the bell, the victim's P is 0, not −W.
  assert.equal(ENDOWMENT_AT_3000 - v0.valueUsdc!, 0);
  assert.equal(
    v0GapBeyondTolerance(v0.measuredUsdc!, v0.endowmentUsdc!),
    W,
    "and the gap is reported",
  );
});

test("pinned: the lower side behaves as the floor did", () => {
  assert.deepEqual(
    firstBoundaryV0(2_000, ENDOWMENT_AT_3000, "pinned"),
    firstBoundaryV0(2_000, ENDOWMENT_AT_3000, "floor"),
  );
  assert.deepEqual(firstBoundaryV0(40_000, undefined, "pinned"), {
    valueUsdc: 40_000,
    source: "measured",
    measuredUsdc: 40_000,
  });
});

test("a scenario pins V_0; a continuous chain keeps the floor for carried positions", () => {
  assert.equal(v0RuleFor("scenario"), "pinned");
  assert.equal(v0RuleFor("continuous"), "floor");
  // The default stays the floor, so a caller that names no rule behaves as before.
  assert.equal(
    firstBoundaryV0(ENDOWMENT_AT_3000 + 1_000, ENDOWMENT_AT_3000).valueUsdc,
    ENDOWMENT_AT_3000 + 1_000,
  );
});
