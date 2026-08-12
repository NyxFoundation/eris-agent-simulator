// The CDP stablecoin venue's pricing and action surface (issue #39).
//
// Most of what could go wrong here is arithmetic that looks right. The three that would be silent:
// marking a depegged eUSD at par (which hands every holder value they cannot realize), charging a
// borrower for the 200 eUSD of gas compensation they never repay, and reporting zero for a position
// whose read failed. Each has a test below.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import type { LiquityDeployment } from "@eris/sdk/constants.js";
import {
  discountBpsFrom,
  icrOf,
  liquidationPriceUsd,
  liquityAdapter,
  liquityPositionValue,
  liquityValuationRun,
  rateBpsFrom,
  ratioFrom,
} from "@eris/sdk/protocols/liquity.js";
import type { ValuationContext } from "@eris/sdk/protocols/types.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  LiquityObservation,
} from "@eris/sdk/types.js";
import {
  PAR_STABLE_PRICES,
  type StableMarket,
  type StablePrices,
} from "@eris/sdk/stables.js";

const WAD = 10n ** 18n;
const USDC = 10n ** 6n;
const FAIR = 3000;

const DEPLOYMENT: LiquityDeployment = {
  troveManager: "0x00000000000000000000000000000000000c0001" as Address,
  borrowerOperations: "0x00000000000000000000000000000000000c0002" as Address,
  stabilityPool: "0x00000000000000000000000000000000000c0003" as Address,
  sortedTroves: "0x00000000000000000000000000000000000c0004" as Address,
  activePool: "0x00000000000000000000000000000000000c0005" as Address,
  defaultPool: "0x00000000000000000000000000000000000c0006" as Address,
  collSurplusPool: "0x00000000000000000000000000000000000c0007" as Address,
  gasPool: "0x00000000000000000000000000000000000c0008" as Address,
  hintHelpers: "0x00000000000000000000000000000000000c0009" as Address,
  priceFeed: "0x00000000000000000000000000000000000c000a" as Address,
  eusd: "0x00000000000000000000000000000000000eu5d" as Address,
  lqtyToken: "0x00000000000000000000000000000000000c000c" as Address,
  lqtyStaking: "0x00000000000000000000000000000000000c000d" as Address,
  communityIssuance: "0x00000000000000000000000000000000000c000e" as Address,
  eusdUsdcPool: "0x00000000000000000000000000000000000p0001" as Address,
  eusdIndex: 0,
  usdcIndex: 1,
  stable: "0x00000000000000000000000000000000000u5dc" as Address,
};

const AGENT = {
  id: "a1",
  address: "0x00000000000000000000000000000000000a0001" as Address,
};

const GAS_COMPENSATION = 200n * WAD;

// ---------------------------------------------------------------------------
// Liquity's fixed-point conventions
// ---------------------------------------------------------------------------

test("ratios and fee rates come back in the units the observation promises", () => {
  assert.equal(ratioFrom(1_100_000_000_000_000_000n), 1.1); // MCR
  assert.equal(ratioFrom(1_500_000_000_000_000_000n), 1.5); // CCR
  // A Trove with no debt reports uint256 max. Zero would read as "totally undercollateralized",
  // which is the opposite of the truth, and JSON has no infinity.
  assert.ok(ratioFrom(2n ** 255n) > 1000);
  // 0.5% borrowing fee floor.
  assert.equal(rateBpsFrom(5_000_000_000_000_000n), 50);
});

test("ICR and the liquidation price are two views of the same number", () => {
  const coll = 2n * WAD;
  const debt = 4000n * WAD;
  assert.equal(icrOf(coll, debt, FAIR), 1.5);
  // At MCR 1.1 the position is liquidatable once ETH is worth 4000 * 1.1 / 2.
  assert.equal(liquidationPriceUsd(coll, debt, 1.1), 2200);
});

test("a discount is measured against par, which is what the protocol redeems at", () => {
  assert.equal(Math.round(discountBpsFrom(0.99)), 100);
  assert.equal(Math.round(discountBpsFrom(1.0)), 0);
  // A premium is a negative discount rather than a separate concept.
  assert.equal(Math.round(discountBpsFrom(1.005)), -50);
});

// ---------------------------------------------------------------------------
// Position value
// ---------------------------------------------------------------------------

test("the gas compensation is not the borrower's liability", () => {
  // 2 ETH against 4,200 eUSD of booked debt, 200 of which is the GasPool's.
  const value = liquityPositionValue({
    holdings: {
      collWei: 2n * WAD,
      debtEusdWei: 4200n * WAD,
      netDebtEusdWei: 4000n * WAD,
      spDepositEusdWei: 0n,
      spEthGainWei: 0n,
    },
    fairPriceUsd: FAIR,
    eusdPriceUsdc: 1,
  });
  // 6000 of collateral against 4000 repayable, not 4200.
  assert.equal(value.valueUsdc, 2000);
});

test("a Stability Pool deposit is marked at the market, not at the dollar it is named after", () => {
  // The wallet's loose eUSD is the registry's to price since issue #27 (b); what this venue still
  // owns is the deposit, and it moves with the peg the same way.
  const holdings = {
    collWei: 0n,
    debtEusdWei: 0n,
    netDebtEusdWei: 0n,
    spDepositEusdWei: 10_000n * WAD,
    spEthGainWei: 0n,
  };
  const atPar = liquityPositionValue({
    holdings,
    fairPriceUsd: FAIR,
    eusdPriceUsdc: 1,
  });
  const depegged = liquityPositionValue({
    holdings,
    fairPriceUsd: FAIR,
    eusdPriceUsdc: 0.97,
  });
  assert.equal(atPar.valueUsdc, 10_000);
  assert.equal(Math.round(depegged.valueUsdc), 9700);
});

test("a depegged debt is cheaper to close, and the realizable mark says so", () => {
  const value = liquityPositionValue({
    holdings: {
      collWei: 2n * WAD,
      debtEusdWei: 4200n * WAD,
      netDebtEusdWei: 4000n * WAD,
      spDepositEusdWei: 0n,
      spEthGainWei: 0n,
    },
    fairPriceUsd: FAIR,
    eusdPriceUsdc: 0.98,
    // Buying 4,000 eUSD back actually costs 3,950 once impact is included -- more than the mid
    // implies (3,920), which is the whole reason the liability is quoted on the output side.
    debtBuybackUsdc: 3950,
  });
  assert.equal(value.valueUsdc, 6000 - 4000 * 0.98);
  assert.equal(value.liquidatableValueUsdc, 6000 - 3950);
  // The realizable mark is the *lower* one here: the mid flattered the position.
  assert.ok(value.liquidatableValueUsdc < value.valueUsdc);
});

test("withdrawing a large Stability Pool deposit realizes less than the mid says", () => {
  const value = liquityPositionValue({
    holdings: {
      collWei: 0n,
      debtEusdWei: 0n,
      netDebtEusdWei: 0n,
      spDepositEusdWei: 20_000n * WAD,
      spEthGainWei: 0n,
    },
    fairPriceUsd: FAIR,
    eusdPriceUsdc: 0.99,
    longExitUsdc: 19_500,
  });
  assert.equal(value.valueUsdc, 19_800);
  assert.equal(value.liquidatableValueUsdc, 19_500);
});

test("a Trove past 100% is worth zero, not a negative number", () => {
  // The borrower can stop repaying and lose only the collateral. Charging them the shortfall would
  // be charging for a liability they can walk away from.
  const value = liquityPositionValue({
    holdings: {
      collWei: WAD,
      debtEusdWei: 4200n * WAD,
      netDebtEusdWei: 4000n * WAD,
      spDepositEusdWei: 0n,
      spEthGainWei: 0n,
    },
    fairPriceUsd: 2000,
    eusdPriceUsdc: 1,
  });
  assert.equal(value.valueUsdc, 0);
  assert.equal(value.liquidatableValueUsdc, 0);
});

test("Stability Pool ETH gains are collateral the depositor already owns", () => {
  const value = liquityPositionValue({
    holdings: {
      collWei: 0n,
      debtEusdWei: 0n,
      netDebtEusdWei: 0n,
      spDepositEusdWei: 5000n * WAD,
      spEthGainWei: WAD / 2n,
    },
    fairPriceUsd: FAIR,
    eusdPriceUsdc: 1,
  });
  assert.equal(value.valueUsdc, 5000 + 1500);
});

// ---------------------------------------------------------------------------
// Historical valuation (issue #41's staged reads)
// ---------------------------------------------------------------------------

function context(overrides: Partial<ValuationContext> = {}): ValuationContext {
  return {
    publicClient: undefined as never,
    blockNumber: 100,
    horizonBlock: 100,
    agents: [AGENT],
    activeStables: [],
    fairByBase: () => ({ WETH: FAIR }),
    stablePrices: () => PAR_STABLE_PRICES,
    ...overrides,
  };
}

// The registry's view of eUSD (issue #27 (b)): the adapter reads the price from here instead of
// probing the pool itself, so a valuation test says what the market said rather than what a probe
// read returned.
const EUSD_MARKET: StableMarket = {
  symbol: "eUSD",
  token: DEPLOYMENT.eusd,
  decimals: 18,
  venue: "liquity",
  pool: DEPLOYMENT.eusdUsdcPool as Address,
  stableIndex: 0,
  quoteIndex: 1,
  probeStableUnits: 1_000n * WAD,
  probeQuoteUnits: 1_000n * USDC,
};

function eusdAt(priceUsdc: number): StablePrices {
  return {
    byToken: { [DEPLOYMENT.eusd.toLowerCase()]: priceUsdc },
    unquoted: [],
    quotes: [],
  };
}

function eusdUnquoted(): StablePrices {
  return {
    byToken: { [DEPLOYMENT.eusd.toLowerCase()]: 1 },
    unquoted: [EUSD_MARKET],
    quotes: [],
  };
}

// Drive the generator with canned stage results, recording what each stage asked for.
async function drive(
  ctx: ValuationContext,
  stages: Array<(reads: unknown[]) => unknown[]>,
  deployment: LiquityDeployment = DEPLOYMENT,
) {
  const run = liquityValuationRun(deployment, ctx);
  const asked: unknown[][] = [];
  let step = await run.next();
  let i = 0;
  while (!step.done) {
    asked.push(step.value);
    const reply = stages[i]?.(step.value) ?? step.value.map(() => undefined);
    i += 1;
    step = await run.next(reply);
  }
  return { asked, values: step.value };
}

// getEntireDebtAndColl returns (debt, coll, pendingDebt, pendingColl).
function entire(debt: bigint, coll: bigint) {
  return [debt, coll, 0n, 0n] as const;
}

test("the historical mark prices eUSD off the registry and the Trove off the fair price", async () => {
  // eUSD 100bps below par, as the scorer's shared probe measured it.
  const { asked, values } = await drive(
    context({ stablePrices: () => eusdAt(0.99) }),
    [
      // stage 0: gas compensation, then the agent's three position reads
      () => [GAS_COMPENSATION, entire(4200n * WAD, 2n * WAD), 1000n * WAD, 0n],
      // stage 1: own-size quotes for the deposit and for buying the debt back
      () => [990n * USDC, 3960n * USDC],
    ],
  );
  // Stage 0 asks for one read per agent position plus the one global. The market probe is gone: the
  // wallet's eUSD is registry spot and its price comes off ctx (issue #27 (b)).
  assert.equal(asked[0].length, 4);
  const v = values[AGENT.id];
  // Trove 6000 - 4000 x 0.99, plus a 1,000 eUSD deposit at 0.99.
  assert.equal(Math.round(v.valueUsdc), Math.round(6000 - 3960 + 990));
  assert.equal(
    Math.round(v.liquidatableValueUsdc),
    Math.round(6000 - 3960 + 990),
  );
  assert.equal(v.unpriced.length, 0);
});

test("the wallet's eUSD is left to the registry, so nothing counts it twice", async () => {
  // The agent holds nothing on the venue itself. Whatever eUSD is in its wallet is the scorer's
  // spot sweep to price; this adapter must contribute exactly zero.
  const { asked, values } = await drive(
    context({ stablePrices: () => eusdAt(0.9) }),
    [() => [GAS_COMPENSATION, entire(0n, 0n), 0n, 0n]],
  );
  assert.equal(asked.length, 1);
  assert.equal(values[AGENT.id].valueUsdc, 0);
});

test("a failed position read is reported, not scored as zero", async () => {
  const { values } = await drive(context(), [
    () => [GAS_COMPENSATION, undefined, undefined, undefined],
  ]);
  const v = values[AGENT.id];
  assert.equal(v.valueUsdc, 0);
  assert.equal(v.unpriced.length, 1);
  assert.equal(v.unpriced[0].reason, "read-failed");
  assert.match(v.unpriced[0].read ?? "", /getEntireDebtAndColl/);
});

test("a market that will not quote falls back to par and says so", async () => {
  const { values } = await drive(
    context({ stablePrices: () => eusdUnquoted() }),
    [() => [GAS_COMPENSATION, entire(0n, 0n), 5000n * WAD, 0n]],
  );
  const v = values[AGENT.id];
  // Par is the least wrong fallback -- it is the value the protocol enforces -- but silently
  // assuming it is exactly what this venue must never do, so the holding is reported.
  assert.equal(v.valueUsdc, 5000);
  assert.equal(v.unpriced.length, 1);
  assert.equal(v.unpriced[0].source, "liquity-eusd-market");
  assert.equal(v.unpriced[0].reason, "par-fallback");
  assert.equal(v.unpriced[0].token, DEPLOYMENT.eusd);
});

test("an agent with nothing on the venue costs no second-stage read", async () => {
  const { asked, values } = await drive(context(), [
    () => [GAS_COMPENSATION, entire(0n, 0n), 0n, 0n],
  ]);
  assert.equal(asked.length, 1);
  assert.equal(values[AGENT.id].valueUsdc, 0);
});

test("a deployment without a market marks at par and says that too", async () => {
  const noMarket: LiquityDeployment = {
    ...DEPLOYMENT,
    eusdUsdcPool: undefined,
    eusdIndex: undefined,
    usdcIndex: undefined,
  };
  const { asked, values } = await drive(
    context(),
    [() => [GAS_COMPENSATION, entire(0n, 0n), 2000n * WAD, 0n]],
    noMarket,
  );
  // No market means no own-size quotes either, so there is no second stage to ask for.
  assert.equal(asked.length, 1);
  assert.equal(values[AGENT.id].valueUsdc, 2000);
  assert.equal(values[AGENT.id].unpriced[0].reason, "par-fallback");
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function observation(
  liquity: Partial<LiquityObservation> = {},
): AgentObservation {
  const base: LiquityObservation = {
    priceUsd: FAIR,
    tcr: 3,
    recoveryMode: false,
    mcr: 1.1,
    ccr: 1.5,
    troveCount: 1,
    totalCollWei: (250n * WAD).toString(),
    totalDebtEusdWei: (250_000n * WAD).toString(),
    borrowingRateBps: 50,
    redemptionRateBps: 50,
    baseRateBps: 0,
    minNetDebtEusdWei: (1800n * WAD).toString(),
    gasCompensationEusdWei: GAS_COMPENSATION.toString(),
    eusdBalanceWei: "0",
    marketPriceUsdc: 1,
    marketQuoted: true,
    discountBps: 0,
    redemptionEdgeBps: -50,
    spDepositEusdWei: "0",
    spEthGainWei: "0",
    spLqtyGainWei: "0",
    spTotalDepositsEusdWei: (50_000n * WAD).toString(),
    spShareBps: 0,
    ethBalanceWei: WAD.toString(),
    suggestedGasReserveWei: (WAD / 20n).toString(),
    ...liquity,
  };
  return {
    kind: "observation",
    runId: "r",
    round: 1,
    blockNumber: "1",
    agentAddress: AGENT.address,
    fairPriceUsdcPerWeth: FAIR,
    oraclePrices: { wethUsd: FAIR, usdcUsd: 1 },
    enabledProtocols: ["uniswap", "liquity"],
    balances: {
      ethWei: WAD.toString(),
      wethWei: (10n * WAD).toString(),
      usdcUnits: (25_000n * USDC).toString(),
    },
    inventory: { valueUsdc: 0, weth: 10, usdc: 25_000, eth: 1 },
    history: [],
    limits: {
      maxWethInWei: WAD.toString(),
      maxUsdcInUnits: (5000n * USDC).toString(),
      defaultPriorityFeePerGasWei: "1000000000",
      maxPriorityFeePerGasWei: "5000000000",
      defaultSlippageBps: 50,
      maxBundleActions: 5,
      maxLpWethWei: "0",
      maxLpUsdcUnits: "0",
      maxOpenPositions: 1,
      maxGmxSizeUsd: "0",
      maxAaveSupplyWethWei: "0",
      maxAaveBorrowUsdcUnits: "0",
    },
    protocols: { liquity: base },
  };
}

const BALANCES: BalanceSnapshot = {
  ethWei: WAD,
  wethWei: 10n * WAD,
  usdcUnits: 25_000n * USDC,
  bases: { WETH: 10n * WAD },
};

test("every action the venue exposes round-trips through parse", () => {
  const actions = [
    {
      type: "liquityOpenTrove",
      collateralWethWei: (2n * WAD).toString(),
      debtEusdWei: (4000n * WAD).toString(),
    },
    {
      type: "liquityAdjustTrove",
      debtChangeEusdWei: "1",
      isDebtIncrease: true,
    },
    { type: "liquityCloseTrove" },
    { type: "liquityRedeem", amountEusdWei: "1" },
    { type: "liquityProvideToSP", amountEusdWei: "1" },
    { type: "liquityWithdrawFromSP", amountEusdWei: "max" },
    { type: "liquityLiquidate", maxTroves: 2 },
    { type: "liquitySwapEusd", tokenIn: "USDC", amountIn: "1" },
  ];
  for (const a of actions) {
    const parsed = liquityAdapter.parse({ ...a });
    assert.equal(parsed?.type, a.type, `parse dropped ${a.type}`);
  }
  // Something from another venue is not this adapter's.
  assert.equal(liquityAdapter.parse({ type: "swap" }), null);
});

test("a Trove below MIN_NET_DEBT is refused before it costs gas", () => {
  const result = liquityAdapter.validate(
    {
      type: "liquityOpenTrove",
      collateralWethWei: (2n * WAD).toString(),
      debtEusdWei: (1000n * WAD).toString(),
    },
    observation(),
    BALANCES,
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /MIN_NET_DEBT/);
});

test("a Trove that would open under MCR is refused, and under CCR in Recovery Mode", () => {
  // 1 ETH (3,000) against 2,900 eUSD is 103% -- under MCR.
  const thin = {
    type: "liquityOpenTrove" as const,
    collateralWethWei: WAD.toString(),
    debtEusdWei: (2900n * WAD).toString(),
  };
  assert.equal(
    liquityAdapter.validate(thin, observation(), BALANCES).ok,
    false,
  );
  // 2 ETH (6,000) against 4,200 is 143%: comfortably above MCR, but under the CCR that Recovery
  // Mode raises the bar to -- which is the whole point of Recovery Mode being systemic.
  const ok = {
    type: "liquityOpenTrove" as const,
    collateralWethWei: (2n * WAD).toString(),
    debtEusdWei: (4200n * WAD).toString(),
  };
  assert.equal(liquityAdapter.validate(ok, observation(), BALANCES).ok, true);
  assert.equal(
    liquityAdapter.validate(ok, observation({ recoveryMode: true }), BALANCES)
      .ok,
    false,
  );
});

test("closing needs the eUSD to repay with, which the wallet may not have", () => {
  const trove = {
    status: 1,
    collWei: (2n * WAD).toString(),
    debtEusdWei: (4200n * WAD).toString(),
    netDebtEusdWei: (4000n * WAD).toString(),
    icr: 1.5,
    liquidationPriceUsd: 2200,
    positionFromRiskiest: 0,
    redeemedAheadEusdWei: "0",
    positionKnown: true,
  };
  const broke = liquityAdapter.validate(
    { type: "liquityCloseTrove" },
    observation({ trove }),
    BALANCES,
  );
  assert.equal(broke.ok, false);
  const funded = liquityAdapter.validate(
    { type: "liquityCloseTrove" },
    observation({ trove, eusdBalanceWei: (4000n * WAD).toString() }),
    BALANCES,
  );
  assert.equal(funded.ok, true);
});

test("redeeming and depositing are bounded by the eUSD actually held", () => {
  const obs = observation({ eusdBalanceWei: (1000n * WAD).toString() });
  assert.equal(
    liquityAdapter.validate(
      { type: "liquityRedeem", amountEusdWei: (2000n * WAD).toString() },
      obs,
      BALANCES,
    ).ok,
    false,
  );
  assert.equal(
    liquityAdapter.validate(
      { type: "liquityRedeem", amountEusdWei: (900n * WAD).toString() },
      obs,
      BALANCES,
    ).ok,
    true,
  );
  assert.equal(
    liquityAdapter.validate(
      { type: "liquityProvideToSP", amountEusdWei: (2000n * WAD).toString() },
      obs,
      BALANCES,
    ).ok,
    false,
  );
});

test("withdrawing zero from the Stability Pool claims the gain, and is only refused when there is none", () => {
  const empty = liquityAdapter.validate(
    { type: "liquityWithdrawFromSP", amountEusdWei: "0" },
    observation(),
    BALANCES,
  );
  assert.equal(empty.ok, false);
  const withGain = liquityAdapter.validate(
    { type: "liquityWithdrawFromSP", amountEusdWei: "0" },
    observation({ spEthGainWei: (WAD / 10n).toString() }),
    BALANCES,
  );
  assert.equal(withGain.ok, true);
});

test("buying eUSD is bounded by the USDC balance and the per-round limit", () => {
  const tooBig = liquityAdapter.validate(
    {
      type: "liquitySwapEusd",
      tokenIn: "USDC",
      amountIn: (10_000n * USDC).toString(),
    },
    observation(),
    BALANCES,
  );
  // 10,000 is affordable but over the 5,000 per-round cap.
  assert.equal(tooBig.ok, false);
  const fine = liquityAdapter.validate(
    {
      type: "liquitySwapEusd",
      tokenIn: "USDC",
      amountIn: (4000n * USDC).toString(),
    },
    observation(),
    BALANCES,
  );
  assert.equal(fine.ok, true);
});

test("the venue accounts for eUSD and deliberately leaves LQTY visible", async () => {
  // LIQUITY is null outside a local deploy, so this asserts the shape rather than the addresses:
  // whatever it returns, LQTY must not be in it (issue #41's convention is that a token a venue
  // issues but does not value stays reportable as unaccounted).
  const accounted = await liquityAdapter.accountedTokens?.(undefined as never);
  assert.ok(Array.isArray(accounted));
  assert.equal(
    accounted?.some((t) => t.toLowerCase() === DEPLOYMENT.lqtyToken),
    false,
  );
});
