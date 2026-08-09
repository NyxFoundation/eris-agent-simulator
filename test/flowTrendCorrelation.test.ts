// The persisted uninformed trend, and its correlated form (ADR 0017 regime 2, informed-flow).
//
// The trend direction has to satisfy three things at once, and the first version of this file only
// checked the third, which let two real bugs through (both found in review):
//
//   1. It must depend on the seed. The direction used to be a function of the block window alone, so
//      it was identical on every published seed and on every unpublished one -- an agent could
//      hard-code `floor(round/persistBlocks) % 2` and front-run every reversal. The private seed set
//      would have provided no protection at all.
//   2. It must actually be distributed. The mixing step used float `*` on values above 2^53, which
//      rounded the low bits away; "uniswap" and "balancer" came back even in *every* window, i.e. a
//      permanent one-way bias rather than a trend, and no divergence between the two deepest venues.
//   3. correlation=1 must align the venues, correlation=0 must not.
//
// The tests below check all three. The weak assertion that let (1) and (2) through was
// `new Set(directions).size === 2`, which a perfect alternation satisfies.
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
function direction(
  venue: (typeof VENUES)[number],
  round: number,
  correlation: number,
  trendSeed = 7,
): "buy" | "sell" | null {
  const orders = buildAmmFlow(
    // A fresh Rng per call: the trend must come from the deterministic trend stream, not from the
    // shared RNG, so the direction has to be stable regardless of RNG position.
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
    trendSeed,
  );
  const uninformed = orders.filter((o) => o.kind === "uninformed");
  if (uninformed.length === 0) return null;
  const action = uninformed[0].action as { tokenIn?: string };
  return action.tokenIn === "USDC" ? "buy" : "sell";
}

// The direction sequence over `count` consecutive windows.
function windowDirections(
  venue: (typeof VENUES)[number],
  correlation: number,
  trendSeed: number,
  count = 24,
): string[] {
  return Array.from(
    { length: count },
    (_, w) => direction(venue, w * PERSIST, correlation, trendSeed) ?? "?",
  );
}

test("the direction depends on the seed, not just the block window", () => {
  // Bug 1. A seed-independent direction makes the regime memorizable, and the private seed set
  // stops protecting anything.
  const patterns = new Set(
    [1, 2, 3, 4, 5, 101, 202, 303].map((seed) =>
      windowDirections("uniswap", 1, seed).join(""),
    ),
  );
  assert.ok(
    patterns.size >= 6,
    `only ${patterns.size} distinct direction sequences across 8 seeds`,
  );
});

test("no venue is pinned to one direction, and none is a plain alternation", () => {
  // Bug 2. Both failure modes read as "a trend exists" if you only count distinct values.
  for (const venue of VENUES) {
    for (const correlation of [0, 1]) {
      const dirs = windowDirections(venue, correlation, 7, 40);
      const buys = dirs.filter((d) => d === "buy").length;
      assert.ok(
        buys > 6 && buys < 34,
        `${venue}@corr=${correlation} is one-way: ${buys}/40 buys`,
      );
      const alternating = dirs.every((d, i) => i === 0 || d !== dirs[i - 1]);
      assert.ok(
        !alternating,
        `${venue}@corr=${correlation} alternates on a fixed clock`,
      );
    }
  }
});

test("correlation=0 keeps the venues independent", () => {
  // Every pair must disagree sometimes; checking only "some pair disagreed" hid that uniswap and
  // balancer were permanently identical.
  for (const [a, b] of [
    ["uniswap", "balancer"],
    ["uniswap", "curve"],
    ["balancer", "curve"],
  ] as const) {
    const da = windowDirections(a, 0, 7, 40);
    const db = windowDirections(b, 0, 7, 40);
    const disagreements = da.filter((d, i) => d !== db[i]).length;
    assert.ok(
      disagreements > 6,
      `${a} and ${b} only disagreed ${disagreements}/40 windows`,
    );
  }
});

test("correlation=1 aligns every venue in each window", () => {
  for (let round = 0; round < 20 * PERSIST; round += PERSIST) {
    const dirs = VENUES.map((v) => direction(v, round, 1));
    assert.equal(
      new Set(dirs).size,
      1,
      `venues disagreed at round ${round}: ${dirs.join(",")}`,
    );
  }
});

test("the direction is held for the whole window", () => {
  for (let start = 0; start < 5 * PERSIST; start += PERSIST) {
    const first = direction("uniswap", start, 1);
    for (let r = start; r < start + PERSIST; r++)
      assert.equal(
        direction("uniswap", r, 1),
        first,
        `direction changed inside window starting at ${start}`,
      );
  }
});

test("the trend does not touch the RNG consumption sequence", () => {
  // Drawn off a separate stream on purpose: if it consumed from the shared rng, enabling the trend
  // (or changing its correlation) would shift every downstream order in the run and no calibration
  // would carry over.
  const drain = (correlation: number, persist: number): number => {
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
      persist,
      0,
      0,
      1,
      correlation,
      7,
    );
    // Whatever the RNG produces next reveals how many draws the call consumed.
    return rng.next();
  };
  assert.equal(drain(0, PERSIST), drain(1, PERSIST));
});
