// The borrower and underwriter sides of the CDP venue (issue #39).
//
// These two agents exist to exercise the half of the venue that only appears when the price falls,
// so the tests concentrate on the decisions that are wrong in a way a passing run would hide: a
// defence taken too late, a defence that is not available, and a liquidation called at a ratio that
// will have recovered by the time the call lands.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideTrove,
  topUpForIcr,
} from "../example/agents/trove-manager/agent.js";
import { decideUnderwriting } from "../example/agents/sp-underwriter/agent.js";
import type {
  LiquityObservation,
  LiquityTroveObservation,
} from "@eris/sdk/types.js";

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;
const PRICE = 3000;

function trove(
  overrides: Partial<LiquityTroveObservation> = {},
  priceUsd = PRICE,
): LiquityTroveObservation {
  // 4 ETH against 6,200 eUSD of booked debt: ICR 1.94 at $3,000.
  const collWei = overrides.collWei ?? (4n * WAD).toString();
  const debtEusdWei = overrides.debtEusdWei ?? (6200n * WAD).toString();
  const icr =
    overrides.icr ??
    ((Number(collWei) / 1e18) * priceUsd) / (Number(debtEusdWei) / 1e18);
  return {
    status: 1,
    collWei,
    debtEusdWei,
    netDebtEusdWei: (BigInt(debtEusdWei) - 200n * WAD).toString(),
    icr,
    liquidationPriceUsd:
      ((Number(debtEusdWei) / 1e18) * 1.1) / (Number(collWei) / 1e18),
    positionFromRiskiest: 2,
    redeemedAheadEusdWei: (100_000n * WAD).toString(),
    positionKnown: true,
    ...overrides,
  };
}

function liquity(
  overrides: Partial<LiquityObservation> = {},
): LiquityObservation {
  return {
    priceUsd: PRICE,
    tcr: 2.7,
    recoveryMode: false,
    mcr: 1.1,
    ccr: 1.5,
    troveCount: 3,
    totalCollWei: (280n * WAD).toString(),
    totalDebtEusdWei: (300_000n * WAD).toString(),
    borrowingRateBps: 50,
    redemptionRateBps: 50,
    baseRateBps: 0,
    minNetDebtEusdWei: (1800n * WAD).toString(),
    gasCompensationEusdWei: (200n * WAD).toString(),
    eusdBalanceWei: "0",
    marketPriceUsdc: 1,
    marketQuoted: true,
    discountBps: 0,
    redemptionEdgeBps: -50,
    poolReserves: {
      eusd: (100_000n * WAD).toString(),
      usdc: (100_000n * USDC).toString(),
    },
    spDepositEusdWei: "0",
    spEthGainWei: "0",
    spLqtyGainWei: "0",
    spTotalDepositsEusdWei: (75_000n * WAD).toString(),
    spShareBps: 0,
    ethBalanceWei: WAD.toString(),
    suggestedGasReserveWei: (WAD / 20n).toString(),
    ...overrides,
  };
}

function troveInput(
  overrides: Partial<Parameters<typeof decideTrove>[0]> = {},
) {
  return {
    liquity: liquity(),
    wethWei: 20n * WAD,
    usdcUnits: 25_000n * USDC,
    blocksRemaining: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// trove-manager
// ---------------------------------------------------------------------------

test("topUpForIcr: the collateral that lifts a ratio to a target", () => {
  // 4 ETH against 6,000 eUSD is 200% at $3,000. Reaching 250% needs 5 ETH, so 1 more.
  const need = topUpForIcr({
    collWei: 4n * WAD,
    debtEusdWei: 6000n * WAD,
    priceUsd: PRICE,
    targetIcr: 2.5,
  });
  assert.ok(need >= WAD && need <= WAD + WAD / 100n, `${need}`);
  // Already above it: nothing to add.
  assert.equal(
    topUpForIcr({
      collWei: 6n * WAD,
      debtEusdWei: 6000n * WAD,
      priceUsd: PRICE,
      targetIcr: 2.5,
    }),
    0n,
  );
});

test("opening draws the debt the target ratio allows, not what the collateral could carry", () => {
  const d = decideTrove(troveInput());
  assert.equal(d.kind, "open");
  if (d.kind !== "open") return;
  // 60% of 20 WETH = 12 ETH = $36,000 at 200% -> 18,000 eUSD.
  assert.equal(d.collateralWei, 12n * WAD);
  const debt = Number(d.debtEusdWei) / 1e18;
  assert.ok(Math.abs(debt - 18_000) < 1, `${debt}`);
});

test("a Trove is not opened into Recovery Mode, or below the protocol's minimum", () => {
  assert.equal(
    decideTrove(troveInput({ liquity: liquity({ recoveryMode: true }) })).kind,
    "hold",
  );
  // 0.6 ETH of collateral at 200% supports 900 eUSD, under the 1,800 floor.
  const tiny = decideTrove(troveInput({ wethWei: WAD }));
  assert.equal(tiny.kind, "hold");
  assert.match(tiny.kind === "hold" ? tiny.reason : "", /minimum/);
});

test("a Trove is not opened in the last blocks of a run", () => {
  const d = decideTrove(troveInput({ blocksRemaining: 5 }));
  assert.equal(d.kind, "hold");
  assert.match(d.kind === "hold" ? d.reason : "", /borrowing fee/);
});

test("collateral goes in when the ratio drops under the floor", () => {
  // 4 ETH against 8,000 eUSD at $3,000 is 150%; a fall to $2,400 makes it 120%.
  const failing = liquity({
    priceUsd: 2400,
    trove: trove(
      {
        collWei: (4n * WAD).toString(),
        debtEusdWei: (8000n * WAD).toString(),
      },
      2400,
    ),
  });
  const d = decideTrove(troveInput({ liquity: failing }));
  assert.equal(d.kind, "topUp");
  if (d.kind === "topUp") assert.ok(d.collateralWei > 0n);
});

test("Recovery Mode raises the bar to CCR even for a Trove that was comfortable", () => {
  // 160% ICR: fine normally, inside the band that Recovery Mode makes liquidatable.
  const rm = liquity({
    recoveryMode: true,
    trove: trove({
      collWei: (4n * WAD).toString(),
      debtEusdWei: (7500n * WAD).toString(),
    }),
  });
  const d = decideTrove(troveInput({ liquity: rm }));
  assert.equal(d.kind, "topUp");
  assert.match(d.kind === "topUp" ? d.reason : "", /Recovery Mode/);
});

test("with no collateral left, debt is the other side of the same ratio", () => {
  const failing = liquity({
    priceUsd: 2400,
    eusdBalanceWei: (5000n * WAD).toString(),
    trove: trove(
      {
        collWei: (4n * WAD).toString(),
        debtEusdWei: (8000n * WAD).toString(),
      },
      2400,
    ),
  });
  const d = decideTrove(troveInput({ liquity: failing, wethWei: 0n }));
  assert.equal(d.kind, "repay");
});

test("sitting at the front of the redemption queue is defended, not accepted", () => {
  // Nothing meaningful ahead: the next redemption reaches this Trove.
  const exposed = liquity({
    trove: trove({
      positionFromRiskiest: 0,
      redeemedAheadEusdWei: "0",
    }),
  });
  const d = decideTrove(troveInput({ liquity: exposed }));
  assert.equal(d.kind, "topUp");
  assert.match(d.kind === "topUp" ? d.reason : "", /redemption queue/);
  // With a wall of debt ahead there is nothing to defend against.
  const shielded = decideTrove(
    troveInput({ liquity: liquity({ trove: trove() }) }),
  );
  assert.equal(shielded.kind, "hold");
});

test("closing buys back the borrowing fee first, because that is what closing costs", () => {
  // Drew 6,000 and kept all of it; the Trove books 6,200 including the fee and the gas
  // compensation, so 6,000 owed against 6,000 held is still short.
  const t = trove({
    collWei: (4n * WAD).toString(),
    debtEusdWei: (6200n * WAD).toString(),
  });
  const short = liquity({ trove: t, eusdBalanceWei: (5970n * WAD).toString() });
  const d = decideTrove(troveInput({ liquity: short, blocksRemaining: 5 }));
  assert.equal(d.kind, "buyToClose");
  if (d.kind === "buyToClose") {
    assert.ok(d.usdcIn > 0n && d.usdcIn < 100n * USDC, `${d.usdcIn}`);
  }
  // Once the shortfall is covered, it closes.
  const funded = liquity({
    trove: t,
    eusdBalanceWei: (6100n * WAD).toString(),
  });
  assert.equal(
    decideTrove(troveInput({ liquity: funded, blocksRemaining: 5 })).kind,
    "close",
  );
});

// ---------------------------------------------------------------------------
// sp-underwriter
// ---------------------------------------------------------------------------

function spInput(
  overrides: Partial<Parameters<typeof decideUnderwriting>[0]> = {},
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

test("a Trove under MCR is liquidated, and one at the line is not", () => {
  const under = liquity({
    riskiestTrove: {
      owner: "0x00000000000000000000000000000000000a0002",
      icr: 1.04,
      netDebtEusdWei: (8000n * WAD).toString(),
    },
  });
  const d = decideUnderwriting(spInput({ liquity: under }));
  assert.equal(d.kind, "liquidate");

  // 1.099 is under MCR on paper, but the oracle every agent reads is a block old: a call sent on
  // that ratio can easily execute after the price has recovered, and reverts.
  const edge = liquity({
    riskiestTrove: {
      owner: "0x00000000000000000000000000000000000a0002",
      icr: 1.099,
      netDebtEusdWei: (8000n * WAD).toString(),
    },
  });
  assert.notEqual(
    decideUnderwriting(spInput({ liquity: edge })).kind,
    "liquidate",
  );
});

test("underwriting is built from eUSD bought at or below par, never at a premium", () => {
  const d = decideUnderwriting(spInput());
  assert.equal(d.kind, "buy");
  // 50% of the 25,000 balance: UNDERWRITE_BPS, with no per-round cap left to bind ahead of it.
  if (d.kind === "buy") assert.equal(d.usdcIn, 12_500n * USDC);

  const premium = decideUnderwriting(
    spInput({ liquity: liquity({ discountBps: -30 }) }),
  );
  assert.equal(premium.kind, "hold");
  assert.match(premium.kind === "hold" ? premium.reason : "", /premium/);
});

test("eUSD in hand goes into the pool rather than sitting in the wallet", () => {
  const d = decideUnderwriting(
    spInput({ liquity: liquity({ eusdBalanceWei: (5000n * WAD).toString() }) }),
  );
  assert.equal(d.kind, "deposit");
});

test("the collateral a liquidation paid is claimed and sold, in that order", () => {
  // A gain worth claiming, and nothing else to do.
  const gained = liquity({ spEthGainWei: (WAD / 2n).toString() }); // 0.5 ETH = $1,500
  assert.equal(decideUnderwriting(spInput({ liquity: gained })).kind, "claim");
  // Once claimed it is native ETH above the endowment: wrap, then sell.
  const claimed = decideUnderwriting(
    spInput({ liquity: gained, ethWei: WAD + WAD / 2n }),
  );
  assert.equal(claimed.kind, "wrap");
  const wrapped = decideUnderwriting(
    spInput({ liquity: gained, wethWei: WAD / 2n }),
  );
  assert.equal(wrapped.kind, "unwind");
  // A dust gain is not worth the gas and the AMM fee.
  const dust = liquity({ spEthGainWei: (WAD / 1000n).toString() }); // $3
  assert.notEqual(decideUnderwriting(spInput({ liquity: dust })).kind, "claim");
});

test("a liquidation outranks everything else, because it is the only branch with a deadline", () => {
  const both = liquity({
    spEthGainWei: (WAD / 2n).toString(),
    eusdBalanceWei: (5000n * WAD).toString(),
    riskiestTrove: {
      owner: "0x00000000000000000000000000000000000a0002",
      icr: 1.02,
      netDebtEusdWei: (8000n * WAD).toString(),
    },
  });
  assert.equal(
    decideUnderwriting(spInput({ liquity: both, wethWei: WAD })).kind,
    "liquidate",
  );
});
