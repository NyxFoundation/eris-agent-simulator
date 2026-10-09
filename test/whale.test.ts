// Whale point stress event (ADR 0017 regime 3).
//
// The schedule half (placement, side resolution, determinism from the seed) and the order half
// (what actually gets submitted) are both pure, so both are pinned here. The thing most worth
// pinning is that a whale is a *point* event: if it were treated as a trapezoid it would silently
// become a multi-block price overlay, which is the crash regime, not this one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EventSchedule,
  parseStressEvents,
} from "../core/src/realtime/events.js";
import {
  buildWhaleOrder,
  whaleFunding,
  WhaleResubmits,
  WHALE_MAX_ATTEMPTS,
  WHALE_RECEIPT_WAIT_BLOCKS,
  type WhaleReceiptStatus,
} from "../core/src/realtime/whale.js";
import { baseTokens } from "@eris/sdk/markets.js";

const WHALE = {
  type: "whale" as const,
  magnitudeRange: [30, 60] as [number, number],
  windowFrac: [0.3, 0.7] as [number, number],
  rampBlocks: 0,
  holdBlocks: 0,
  decayBlocks: 0,
};

test("a whale occupies a single block and never touches the price overlay", () => {
  const schedule = new EventSchedule([WHALE], 42, 100);
  const [ev] = schedule.events;
  assert.equal(ev.endBlock, ev.startBlock + 1);
  // Unlike crash, fair price is untouched: the dislocation is the pool moving away from an
  // unchanged fair, which is the whole point of the regime.
  for (let i = 0; i < 100; i++) assert.equal(schedule.at(i).wethMult, 1);
  // It is delivered as a point event instead.
  assert.deepEqual(schedule.pointEventsAt(ev.startBlock), [ev]);
  assert.deepEqual(schedule.pointEventsAt(ev.startBlock + 1), []);
});

test("the same seed resolves the same whale, a different seed can move it", () => {
  const a = new EventSchedule([WHALE], 42, 100).events[0];
  const b = new EventSchedule([WHALE], 42, 100).events[0];
  assert.deepEqual(a, b);

  const differs = [1, 2, 3, 4, 5, 6, 7, 8].some((seed) => {
    const e = new EventSchedule([WHALE], seed, 100).events[0];
    return e.startBlock !== a.startBlock || e.magnitude !== a.magnitude;
  });
  assert.ok(
    differs,
    "no seed changed the whale (the range is not being sampled)",
  );
});

test("side defaults to seed-chosen and both sides occur across seeds", () => {
  const sides = new Set(
    Array.from(
      { length: 24 },
      (_, seed) => new EventSchedule([WHALE], seed, 100).events[0].side,
    ),
  );
  assert.deepEqual([...sides].sort(), ["buy", "sell"]);
});

test("an explicit side pins the direction without moving the schedule", () => {
  // The side draw is taken unconditionally so that pinning it cannot shift the placement of this
  // event or of any event after it in the list.
  const free = new EventSchedule([WHALE], 7, 100).events[0];
  const pinned = new EventSchedule([{ ...WHALE, side: "buy" }], 7, 100)
    .events[0];
  assert.equal(pinned.side, "buy");
  assert.equal(pinned.startBlock, free.startBlock);
  assert.equal(pinned.magnitude, free.magnitude);
});

test("a sell spends the base and a buy spends USDC, at the venue asked for", () => {
  const base = {
    ...new EventSchedule([WHALE], 42, 100).events[0],
    magnitude: 40,
  };

  const sell = buildWhaleOrder({ ...base, side: "sell" }, 2000, 1n);
  assert.equal(sell.protocol, "uniswap");
  assert.equal(sell.walletKey, "whale:uninformed");
  const sellAction = sell.action as unknown as Record<string, string>;
  assert.equal(sellAction.type, "swap");
  assert.equal(sellAction.tokenIn, "WETH");
  assert.equal(sellAction.amountIn, (40n * 10n ** 18n).toString());

  const buy = buildWhaleOrder(
    { ...base, side: "buy", venue: "curve" },
    2000,
    1n,
  );
  const buyAction = buy.action as unknown as Record<string, string>;
  assert.equal(buy.protocol, "curve");
  assert.equal(buyAction.type, "curveSwap");
  assert.equal(buyAction.tokenIn, "USDC");
  // 40 WETH at 2000 = 80,000 USDC (6 decimals)
  assert.equal(buyAction.amountIn, (80_000n * 10n ** 6n).toString());
});

test("a whale's slippage limit rides on the order; without one the adapter's default applies", () => {
  // The order used to carry `minAmountOut: "0"`, a field no adapter reads: the print ran at each
  // adapter's default 50 bps. Under economicGas the limit is drawn per print (ADR 0011 §1b).
  const ev = new EventSchedule([WHALE], 42, 100).events[0];
  const withLimit = buildWhaleOrder(ev, 2000, 1n, 75).action as unknown as Record<string, unknown>;
  assert.equal(withLimit.slippageBps, 75);
  assert.equal("minAmountOut" in withLimit, false);
  const without = buildWhaleOrder(ev, 2000, 1n).action as unknown as Record<string, unknown>;
  assert.equal("slippageBps" in without, false);
});

const whaleEvent = (over: Record<string, unknown>) => ({
  ...new EventSchedule([WHALE], 42, 100).events[0],
  ...over,
});

test("funding covers the cumulative same-side notional, not just the largest order", () => {
  // Sizing on the max only looks sufficient because buys and sells replenish each other. A seed that
  // draws every whale on the same side spends the sum, and the last order would revert on balance.
  const allSells = [
    whaleEvent({ side: "sell", magnitude: 50 }),
    whaleEvent({ side: "sell", magnitude: 50 }),
    whaleEvent({ side: "sell", magnitude: 50 }),
  ];
  const funding = whaleFunding(allSells, { WETH: 2000 });
  assert.ok(
    funding.baseWei.WETH >= 150n * 10n ** 18n,
    `baseWei=${funding.baseWei.WETH} does not cover 150 WETH of sells`,
  );
  // Nothing was bought, so no USDC is needed.
  assert.equal(funding.usdcUnits, 0n);
});

test("the two sides are funded separately rather than netted", () => {
  // Order matters: a sell that comes before the buy needs its base up front regardless of what the
  // buy would have replenished afterwards.
  const funding = whaleFunding(
    [
      whaleEvent({ side: "sell", magnitude: 40 }),
      whaleEvent({ side: "buy", magnitude: 40 }),
    ],
    { WETH: 2000 },
  );
  assert.ok(funding.baseWei.WETH >= 40n * 10n ** 18n);
  assert.ok(funding.usdcUnits >= 80_000n * 10n ** 6n);
});

test("a non-WETH whale is funded in its own base at its own price", (t) => {
  // Previously hard-coded to WETH: a WBTC whale got WETH it could not sell and USDC priced off the
  // WETH feed, so it reverted either way -- silently.
  const extra = baseTokens().find((b) => b.symbol !== "WETH");
  if (!extra) {
    t.skip(
      "registry has no non-WETH base (fork default); needs local constants",
    );
    return;
  }
  const funding = whaleFunding(
    [whaleEvent({ side: "sell", base: extra.symbol, magnitude: 5 })],
    { WETH: 2000, [extra.symbol]: 60_000 },
  );
  assert.equal(funding.baseWei.WETH, undefined);
  assert.ok(
    funding.baseWei[extra.symbol] >= 5n * 10n ** BigInt(extra.decimals),
  );
});

test("a whale whose base has no fair price fails fast rather than going unfunded", () => {
  assert.throws(
    () => whaleFunding([whaleEvent({ side: "buy", base: "WETH" })], {}),
    /no fair price is available/,
  );
});

test("no whale in the schedule means no endowment", () => {
  assert.deepEqual(whaleFunding([], { WETH: 2000 }), {
    baseWei: {},
    usdcUnits: 0n,
  });
});

test("side/venue are rejected on event types they do not apply to", () => {
  const crash = {
    type: "crash",
    magnitudeRange: [0.1, 0.2],
    windowFrac: [0.3, 0.7],
    rampBlocks: 3,
    holdBlocks: 6,
    decayBlocks: 8,
  };
  assert.throws(
    () => parseStressEvents(JSON.stringify([{ ...crash, side: "buy" }])),
    /side only applies to types "whale" and "cexDrift"/,
  );
  // venue names where a whale prints and which book a liquidityPull thins; a price overlay has no
  // venue at all -- it moves the fair price, which every venue prices against.
  assert.throws(
    () => parseStressEvents(JSON.stringify([{ ...crash, venue: "curve" }])),
    /venue only applies to types "whale" and "liquidityPull"/,
  );
  assert.throws(
    () => parseStressEvents(JSON.stringify([{ ...WHALE, side: "sideways" }])),
    /side must be/,
  );
});

test("a whale needs no trapezoid fields", () => {
  const [parsed] = parseStressEvents(
    JSON.stringify([
      { type: "whale", magnitudeRange: [30, 60], windowFrac: [0.3, 0.7] },
    ]),
  );
  assert.equal(parsed.type, "whale");
  assert.equal(parsed.rampBlocks, 0);
});

// ---- resending a reverted print (whale.ts WhaleResubmits) ----

const resolvedWhale = () => {
  const schedule = new EventSchedule([{ ...WHALE, side: "buy" as const }], 7, 200);
  return schedule.events[0];
};

const statuses = (m: Record<string, WhaleReceiptStatus>) => async (hash: string) => m[hash] ?? null;

test("a filled print is not sent again", async () => {
  const ev = resolvedWhale();
  const tracker = new WhaleResubmits();
  tracker.sent(ev, ["0xa"], 1, 100);
  const polled = await tracker.poll(101, statuses({ "0xa": "success" }));
  assert.deepEqual(polled.resubmit, []);
  assert.equal(polled.filled.length, 1);
  assert.equal(tracker.unresolved, 0);
  assert.equal(tracker.counts.filledFirstAttempt, 1);
});

test("a reverted print is sent again, up to WHALE_MAX_ATTEMPTS in all, then abandoned", async () => {
  const ev = resolvedWhale();
  const tracker = new WhaleResubmits();
  tracker.sent(ev, ["0x1"], 1, 100);
  const reverted: Record<string, WhaleReceiptStatus> = {};
  let attempt = 1;
  for (let block = 101; attempt < WHALE_MAX_ATTEMPTS; block++) {
    reverted[`0x${attempt}`] = "reverted";
    const polled = await tracker.poll(block, statuses(reverted));
    assert.equal(polled.resubmit.length, 1);
    assert.equal(polled.resubmit[0].attempt, attempt + 1);
    assert.deepEqual(polled.resubmit[0].revertedHashes, [`0x${attempt}`]);
    attempt++;
    tracker.sent(ev, [`0x${attempt}`], attempt, block);
  }
  reverted[`0x${attempt}`] = "reverted";
  const last = await tracker.poll(200, statuses(reverted));
  assert.deepEqual(last.resubmit, []);
  assert.equal(last.abandoned.length, 1);
  assert.equal(last.abandoned[0].attempts, WHALE_MAX_ATTEMPTS);
  assert.equal(tracker.counts.prints, 1);
  assert.equal(tracker.counts.abandoned, 1);
});

test("a resent print that fills counts as filled after a resend", async () => {
  const ev = resolvedWhale();
  const tracker = new WhaleResubmits();
  tracker.sent(ev, ["0x1"], 1, 100);
  const first = await tracker.poll(101, statuses({ "0x1": "reverted" }));
  tracker.sent(first.resubmit[0].event, ["0x2"], first.resubmit[0].attempt, 101);
  const second = await tracker.poll(102, statuses({ "0x1": "reverted", "0x2": "success" }));
  assert.equal(second.filled[0].attempt, 2);
  assert.equal(tracker.counts.filledAfterResubmit, 1);
  assert.equal(tracker.counts.filledFirstAttempt, 0);
});

test("an attempt whose submission failed is sent again", async () => {
  const ev = resolvedWhale();
  const tracker = new WhaleResubmits();
  tracker.sent(ev, [], 1, 100);
  const polled = await tracker.poll(101, statuses({}));
  assert.equal(polled.resubmit.length, 1);
  assert.equal(polled.resubmit[0].attempt, 2);
});

test("the last hash decides: an approval that succeeded does not make a reverted swap a fill", async () => {
  const ev = resolvedWhale();
  const tracker = new WhaleResubmits();
  tracker.sent(ev, ["0xapprove", "0xswap"], 1, 100);
  const polled = await tracker.poll(101, statuses({ "0xapprove": "success", "0xswap": "reverted" }));
  assert.deepEqual(polled.filled, []);
  assert.equal(polled.resubmit.length, 1);
});

test("a print with no receipt waits, then is reported unconfirmed and not resent", async () => {
  const ev = resolvedWhale();
  const tracker = new WhaleResubmits();
  tracker.sent(ev, ["0xa"], 1, 100);
  const early = await tracker.poll(100 + WHALE_RECEIPT_WAIT_BLOCKS - 1, statuses({}));
  assert.deepEqual(early.unconfirmed, []);
  assert.equal(tracker.unresolved, 1);
  const late = await tracker.poll(100 + WHALE_RECEIPT_WAIT_BLOCKS, statuses({}));
  assert.equal(late.unconfirmed.length, 1);
  assert.deepEqual(late.resubmit, []);
  assert.equal(tracker.unresolved, 0);
});
