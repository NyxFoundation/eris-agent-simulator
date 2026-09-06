// redemption-arb's decision surface (issue #39).
//
// The venue is only exercised if the reference agent actually uses it, and the way this particular
// agent rots is by looking profitable while losing money: the discount it trades has to clear the
// redemption fee *and* the cost of turning the redeemed ETH back into USDC. These pin that, plus the
// two orderings that matter -- recycling proceeds before opening a new position, and choosing
// between the protocol and the pool when the peg has recovered.
import test from "node:test";
import assert from "node:assert/strict";
import { decideRedemption } from "../example/agents/redemption-arb/agent.js";
import type { LiquityObservation } from "@eris/sdk/types.js";

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;

function liquity(
  overrides: Partial<LiquityObservation> = {},
): LiquityObservation {
  const discountBps = overrides.discountBps ?? 0;
  const redemptionRateBps = overrides.redemptionRateBps ?? 50;
  return {
    priceUsd: 3000,
    tcr: 3,
    recoveryMode: false,
    mcr: 1.1,
    ccr: 1.5,
    troveCount: 1,
    totalCollWei: (250n * WAD).toString(),
    totalDebtEusdWei: (250_000n * WAD).toString(),
    borrowingRateBps: 50,
    redemptionRateBps,
    baseRateBps: 0,
    minNetDebtEusdWei: (1800n * WAD).toString(),
    gasCompensationEusdWei: (200n * WAD).toString(),
    eusdBalanceWei: "0",
    marketPriceUsdc: 1 - discountBps / 10_000,
    marketQuoted: true,
    discountBps,
    redemptionEdgeBps: discountBps - redemptionRateBps,
    poolReserves: {
      eusd: (100_000n * WAD).toString(),
      usdc: (100_000n * USDC).toString(),
    },
    spDepositEusdWei: "0",
    spEthGainWei: "0",
    spLqtyGainWei: "0",
    spTotalDepositsEusdWei: (50_000n * WAD).toString(),
    spShareBps: 0,
    ethBalanceWei: WAD.toString(),
    suggestedGasReserveWei: (WAD / 20n).toString(),
    ...overrides,
  };
}

function input(
  overrides: Partial<Parameters<typeof decideRedemption>[0]> = {},
) {
  return {
    liquity: liquity(),
    usdcUnits: 25_000n * USDC,
    wethWei: 0n,
    ethWei: WAD,
    ethBaselineWei: WAD,
    wethBaselineWei: 0n,
    canSellEth: true,
    ...overrides,
  };
}

test("at par there is nothing to trade and the agent says so", () => {
  const d = decideRedemption(input());
  assert.equal(d.kind, "hold");
  assert.match(d.kind === "hold" ? d.reason : "", /off par/);
});

test("a discount that does not clear the fee plus the exit is left alone", () => {
  // 60bps off par: the 50bps redemption fee and the 35bps exit already exceed it.
  const d = decideRedemption(input({ liquity: liquity({ discountBps: 60 }) }));
  assert.equal(d.kind, "hold");
});

test("a discount wide enough to clear every cost is bought", () => {
  const d = decideRedemption(input({ liquity: liquity({ discountBps: 150 }) }));
  assert.equal(d.kind, "buy");
  if (d.kind !== "buy") return;
  // 30% of the 25,000 balance. This used to be trimmed to a 5,000 per-round limit; with the limit
  // gone, BUY_FRACTION_BPS is the whole of the sizing decision.
  assert.equal(d.usdcIn, 7500n * USDC);
  assert.ok(d.edgeBps > 0);
});

test("the purchase leaves enough discount behind to still be worth redeeming", () => {
  // The shape of a real broken peg: the pool is eUSD-heavy by 40k and shows 120bps. Redeeming needs
  // 85bps, so only the 15bps of headroom above that (plus safety) may be spent on impact -- which
  // caps the buy far below what the balance alone would allow.
  //
  // This is the bug the first live run of this agent had: it bought the whole size it could afford,
  // its own fill took the discount to 78bps, and the redemption it exists to perform never fired.
  const depegged = liquity({
    discountBps: 120,
    poolReserves: {
      eusd: (140_000n * WAD).toString(),
      usdc: (60_000n * USDC).toString(),
    },
  });
  const d = decideRedemption(input({ liquity: depegged }));
  assert.equal(d.kind, "buy");
  if (d.kind !== "buy") return;
  assert.ok(
    d.usdcIn < 3000n * USDC,
    `expected the impact cap to bind, got ${d.usdcIn}`,
  );
  // And the trade it does take is big enough to be worth the gas.
  assert.ok(d.usdcIn >= 200n * USDC);
});

test("a discount only just above the redemption threshold is not worth taking at all", () => {
  // 90bps against an 85bps threshold: any fill closes the gap, so there is nothing to buy.
  const d = decideRedemption(
    input({
      liquity: liquity({
        discountBps: 106,
        poolReserves: {
          eusd: (138_000n * WAD).toString(),
          usdc: (62_000n * USDC).toString(),
        },
      }),
    }),
  );
  assert.equal(d.kind, "hold");
});

test("the purchase never exceeds a share of the pool it is trading against", () => {
  // A thin pool: 10% of 2,000 eUSD is 200, which is the dust floor, so nothing is worth doing.
  const thin = decideRedemption(
    input({
      liquity: liquity({
        discountBps: 150,
        poolReserves: {
          eusd: (1000n * WAD).toString(),
          usdc: (1000n * USDC).toString(),
        },
      }),
    }),
  );
  assert.equal(thin.kind, "hold");
  // A pool ten times deeper lets the same balance through, still capped by its depth.
  const deeper = decideRedemption(
    input({
      liquity: liquity({
        discountBps: 150,
        poolReserves: {
          eusd: (30_000n * WAD).toString(),
          usdc: (30_000n * USDC).toString(),
        },
      }),
    }),
  );
  assert.equal(deeper.kind, "buy");
  if (deeper.kind === "buy") assert.equal(deeper.usdcIn, 3000n * USDC);
});

test("eUSD in hand is redeemed while the edge survives the exit cost", () => {
  const d = decideRedemption(
    input({
      liquity: liquity({
        discountBps: 150,
        eusdBalanceWei: (5000n * WAD).toString(),
      }),
    }),
  );
  assert.equal(d.kind, "redeem");
});

test("a narrowed discount is held rather than sold back at a loss", () => {
  // 60bps: redeeming nets 60 - 50 - 35 < 0, but the pool is still below par, so selling would
  // realize the loss for no reason.
  const d = decideRedemption(
    input({
      liquity: liquity({
        discountBps: 60,
        eusdBalanceWei: (5000n * WAD).toString(),
      }),
    }),
  );
  assert.equal(d.kind, "hold");
  assert.match(d.kind === "hold" ? d.reason : "", /holding/);
});

test("above par the pool pays more than the protocol, so the inventory is sold", () => {
  const d = decideRedemption(
    input({
      liquity: liquity({
        discountBps: -20,
        eusdBalanceWei: (5000n * WAD).toString(),
      }),
    }),
  );
  assert.equal(d.kind, "sell");
});

test("the redemption's proceeds are recycled before anything else is opened", () => {
  // A wide discount *and* WETH in hand: the WETH goes first, otherwise the agent is running a
  // price bet it never chose while trading a second one.
  const d = decideRedemption(
    input({
      liquity: liquity({ discountBps: 200 }),
      wethWei: WAD,
    }),
  );
  assert.equal(d.kind, "unwind");
});

test("the WETH a run funded is left alone; only redemption proceeds are sold", () => {
  // The template config hands out 20 WETH for the LST venue. Selling it would pay the AMM's fee on
  // inventory the agent never chose, so the baseline is what separates "mine" from "proceeds".
  const funded = decideRedemption(
    input({ wethWei: 20n * WAD, wethBaselineWei: 20n * WAD }),
  );
  assert.notEqual(funded.kind, "unwind");
  // Proceeds on top of it are sold whole. This used to go out one per-round cap at a time, which
  // left the branch firing for several blocks and blocked every decision below it.
  const withProceeds = decideRedemption(
    input({ wethWei: 23n * WAD, wethBaselineWei: 20n * WAD }),
  );
  assert.equal(withProceeds.kind, "unwind");
  if (withProceeds.kind === "unwind")
    assert.equal(withProceeds.wethWei, 3n * WAD);
});

test("only the ETH above the starting endowment is tradable", () => {
  // Redemption paid out 0.5 ETH on top of the 1 ETH gas endowment.
  const gained = decideRedemption(
    input({ ethWei: WAD + WAD / 2n, ethBaselineWei: WAD }),
  );
  assert.equal(gained.kind, "wrap");
  if (gained.kind === "wrap") assert.equal(gained.ethWei, WAD / 2n);
  // Without a redemption there is nothing to wrap: selling into the endowment is how an agent
  // strands itself with a position it can no longer close.
  const untouched = decideRedemption(
    input({ ethWei: WAD, ethBaselineWei: WAD }),
  );
  assert.notEqual(untouched.kind, "wrap");
});

test("with no spot market the proceeds stay in ETH rather than reverting every block", () => {
  const d = decideRedemption(
    input({ wethWei: WAD, ethWei: 2n * WAD, canSellEth: false }),
  );
  assert.notEqual(d.kind, "unwind");
  assert.notEqual(d.kind, "wrap");
});

test("a pool that will not quote is not a 100% discount", () => {
  const d = decideRedemption(
    input({
      liquity: liquity({ marketQuoted: false, discountBps: 0 }),
    }),
  );
  assert.equal(d.kind, "hold");
  assert.match(d.kind === "hold" ? d.reason : "", /did not quote/);
});

test("a rising fee curve closes the trade that was open a moment ago", () => {
  // The same 150bps discount, after somebody else's redemption pushed the fee to 120bps.
  const d = decideRedemption(
    input({
      liquity: liquity({ discountBps: 150, redemptionRateBps: 120 }),
    }),
  );
  assert.equal(d.kind, "hold");
});
