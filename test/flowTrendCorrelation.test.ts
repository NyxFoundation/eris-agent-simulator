// Correlated directional flow (ADR 0017 regime 2, informed-flow).
//
// The persisted uninformed trend normally draws its direction per venue, which manufactures a
// cross-venue spread -- that is what the hybrid-α calibration wants. A directional-flow regime needs
// the opposite: the whole market leaning one way, so the gap opens against fair rather than between
// venues and an agent has to take a side instead of arbitraging the middle.
//
// The two properties worth pinning: correlation=0 must be byte-identical to the old behavior (it is
// the default, and every existing calibration depends on it), and correlation=1 must actually align
// the venues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "@eris/sdk/rng.js";
import { buildAmmFlow } from "../core/src/flow/logic.js";

const VENUES = ["uniswap", "balancer", "curve"] as const;
const MAX = 1_000_000_000_000_000_000n;
const FEE_WEI = 1_000_000_000n;
const PERSIST = 5;

// The direction of a venue's uninformed order in a round: "buy" pushes price up (USDC in),
// "sell" pushes it down (WETH in). The informed leg is filtered out -- it chases fair, so it says
// nothing about the trend being injected.
function uninformedDirection(
  venue: (typeof VENUES)[number],
  round: number,
  correlation: number,
): "buy" | "sell" | null {
  const orders = buildAmmFlow(
    // A fresh Rng per call: the trend must come from the deterministic window hash, not from the
    // shared RNG stream, so the direction has to be stable regardless of RNG position.
    new Rng(12345),
    venue,
    2000,
    2000, // pool == fair, so informed flow has no gap to close
    MAX,
    MAX,
    FEE_WEI,
    undefined,
    false,
    "WETH",
    1,
    round,
    PERSIST,
    0,
    0,
    1,
    correlation,
  );
  const uninformed = orders.filter((o) => o.kind === "uninformed");
  if (uninformed.length === 0) return null;
  const action = uninformed[0].action as { tokenIn?: string };
  return action.tokenIn === "USDC" ? "buy" : "sell";
}

test("correlation=0 keeps the per-venue independent trend (the existing calibration)", () => {
  // Across enough windows the venues must disagree at least once; if they never did, the
  // cross-venue spread the default calibration relies on would not exist.
  let sawDisagreement = false;
  for (let round = 0; round < 20 * PERSIST; round += PERSIST) {
    const dirs = VENUES.map((v) => uninformedDirection(v, round, 0));
    if (new Set(dirs).size > 1) sawDisagreement = true;
  }
  assert.ok(sawDisagreement, "venues never diverged at correlation=0");
});

test("correlation=1 aligns every venue in each window", () => {
  for (let round = 0; round < 20 * PERSIST; round += PERSIST) {
    const dirs = VENUES.map((v) => uninformedDirection(v, round, 1));
    assert.equal(
      new Set(dirs).size,
      1,
      `venues disagreed at round ${round}: ${dirs.join(",")}`,
    );
  }
});

test("the direction still flips between windows (a trend, not a permanent bias)", () => {
  // A regime whose direction never changes is a one-way ramp, not order-flow imbalance.
  const dirs = new Set<string | null>();
  for (let round = 0; round < 20 * PERSIST; round += PERSIST)
    dirs.add(uninformedDirection("uniswap", round, 1));
  assert.equal(dirs.size, 2, "the market direction never reversed");
});

test("the direction is held for the whole window", () => {
  for (let start = 0; start < 5 * PERSIST; start += PERSIST) {
    const first = uninformedDirection("uniswap", start, 1);
    for (let r = start; r < start + PERSIST; r++)
      assert.equal(
        uninformedDirection("uniswap", r, 1),
        first,
        `direction changed inside window starting at ${start}`,
      );
  }
});

test("correlation does not touch the RNG consumption sequence", () => {
  // The trend is drawn from a hash rather than the shared rng on purpose: if it consumed draws, then
  // turning correlation on would shift every downstream order in the run, and no calibration made at
  // correlation=0 would carry over.
  const drain = (correlation: number): number => {
    const rng = new Rng(999);
    buildAmmFlow(
      rng,
      "uniswap",
      1990,
      2000,
      MAX,
      MAX,
      FEE_WEI,
      undefined,
      false,
      "WETH",
      1,
      3,
      PERSIST,
      0,
      0,
      1,
      correlation,
    );
    // Whatever the RNG produces next reveals how many draws the call consumed.
    return rng.next();
  };
  assert.equal(drain(0), drain(1));
});
