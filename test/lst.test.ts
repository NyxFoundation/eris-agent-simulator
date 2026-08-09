// LST venue (issue #38): the economic clock, the two prices, and realizable-exit marking.
//
// The venue's whole point is that face value and exit value are different numbers. These cover the
// places where confusing the two would silently mis-score a run: the queue that outlives the run,
// the pool quote at real size, and the calibration that decides how fast yield accrues.
import test from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { agentActionSchemaFor } from "@eris/sdk/actionSchema.js";
import type { LstDeployment } from "@eris/sdk/constants.js";
import {
  apyBpsFrom,
  discountBpsFrom,
  lstAdapter,
  lstValuationRun,
  realizableWethWei,
  rewardRatePerBlockRay,
  yieldPerBlockBpsFrom,
} from "@eris/sdk/protocols/lst.js";
import type { ValuationContext } from "@eris/sdk/protocols/types.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  LstObservation,
} from "@eris/sdk/types.js";

const WAD = 10n ** 18n;
const FAIR = 3000;

const DEPLOYMENT: LstDeployment = {
  vault: "0x00000000000000000000000000000000000v0001" as Address,
  lstToken: "0x00000000000000000000000000000000000v0001" as Address,
  asset: "0x00000000000000000000000000000000000we7h" as Address,
  pool: "0x00000000000000000000000000000000000p0001" as Address,
  poolLstIndex: 1,
  poolWethIndex: 0,
  simulatedSecondsPerBlock: 3600,
  targetApyBps: 300,
  withdrawalDelayBlocks: 24,
};

const AGENT = {
  id: "a1",
  address: "0x00000000000000000000000000000000000a0001" as Address,
};

// ---------------------------------------------------------------------------
// Economic clock
// ---------------------------------------------------------------------------

test("the reward rate round-trips through the APY it was derived from", () => {
  // 3%/yr on a one-hour-per-block clock, which is what the deployer bakes in.
  const rate = rewardRatePerBlockRay(300, 3600);
  assert.ok(rate > 0n);
  assert.ok(Math.abs(apyBpsFrom(rate, 3600) - 300) < 0.5);
});

test("a faster clock accrues proportionally more per block", () => {
  const hourly = rewardRatePerBlockRay(300, 3600);
  const daily = rewardRatePerBlockRay(300, 86_400);
  assert.equal(daily / hourly, 24n);
  // ... and still reports the same APY, because the clock is part of the conversion.
  assert.ok(Math.abs(apyBpsFrom(daily, 86_400) - 300) < 0.5);
});

test("yield per block is small against a pool round trip at the shipped calibration", () => {
  // The venue is calibrated so that staking does not dwarf every other venue: an 80-block run at
  // 3%/yr on an hourly clock earns a few bps, well under the pool's ~12bps round trip. If this
  // starts failing, the clock was sped up and the LST became free money.
  const perBlock = yieldPerBlockBpsFrom(rewardRatePerBlockRay(300, 3600));
  assert.ok(
    perBlock * 80 < 12,
    `80 blocks earned ${(perBlock * 80).toFixed(2)}bps`,
  );
});

test("a zero clock or zero APY means no yield at all", () => {
  assert.equal(rewardRatePerBlockRay(0, 3600), 0n);
  assert.equal(rewardRatePerBlockRay(300, 0), 0n);
  assert.equal(apyBpsFrom(10n ** 21n, 0), 0);
});

// ---------------------------------------------------------------------------
// The two prices
// ---------------------------------------------------------------------------

test("discount is positive when the market trades below redemption", () => {
  assert.ok(Math.abs(discountBpsFrom(1.05, 1.0446) - 51.4) < 1);
  // A premium is the same measure with the sign flipped.
  assert.ok(discountBpsFrom(1.0, 1.01) < 0);
  // No rate means no meaningful discount rather than a divide-by-zero.
  assert.equal(discountBpsFrom(0, 1), 0);
});

// ---------------------------------------------------------------------------
// Realizable marking
// ---------------------------------------------------------------------------

const baseRealizable = {
  shares: WAD,
  shareAssets: WAD, // par: 1 WETH
  instantExitWei: (WAD * 9900n) / 10_000n, // the pool pays 99%
  claimableAssets: 0n,
  reachableAssets: 0n,
  unreachableAssets: 0n,
  blockNumber: 100,
  horizonBlock: 200,
  queueDelayBlocks: 20,
};

test("shares mark at par while the queue still fits inside the run", () => {
  const { wei, queueUsed } = realizableWethWei(baseRealizable);
  assert.equal(wei, WAD);
  assert.ok(queueUsed);
});

test("shares mark at the pool's price once the queue no longer fits", () => {
  // 100 + 20 > 110: a redemption queued here finalizes after the run ends, so par is out of reach
  // and the only exit left is the discounted one.
  const { wei, queueUsed } = realizableWethWei({
    ...baseRealizable,
    horizonBlock: 110,
  });
  assert.equal(wei, (WAD * 9900n) / 10_000n);
  assert.ok(!queueUsed);
});

test("a pool trading above par beats the queue even when the queue is open", () => {
  const { wei, queueUsed } = realizableWethWei({
    ...baseRealizable,
    instantExitWei: (WAD * 10_100n) / 10_000n,
  });
  assert.equal(wei, (WAD * 10_100n) / 10_000n);
  assert.ok(!queueUsed);
});

test("shares with no pool quote fall back to the queue, not to zero", () => {
  const { wei } = realizableWethWei({
    ...baseRealizable,
    instantExitWei: undefined,
  });
  assert.equal(wei, WAD);
});

test("shares with neither a quote nor a reachable queue are worth nothing realizable", () => {
  const { wei } = realizableWethWei({
    ...baseRealizable,
    instantExitWei: undefined,
    horizonBlock: 110,
  });
  assert.equal(wei, 0n);
});

test("queued WETH counts when it finalizes in time and not when it does not", () => {
  const queued = {
    ...baseRealizable,
    shares: 0n,
    shareAssets: 0n,
    instantExitWei: 0n,
    claimableAssets: WAD,
    reachableAssets: 2n * WAD,
    unreachableAssets: 5n * WAD,
  };
  // Claimable now plus finalizing before the horizon. The 5 WETH finalizing after it is excluded --
  // real value, but not realizable inside the run.
  assert.equal(realizableWethWei(queued).wei, 3n * WAD);
});

// ---------------------------------------------------------------------------
// Staged historical valuation (issue #41's batching contract)
// ---------------------------------------------------------------------------

function valuationCtx(
  overrides: Partial<ValuationContext> = {},
): ValuationContext {
  return {
    publicClient: {} as never,
    blockNumber: 100,
    horizonBlock: 200,
    agents: [AGENT],
    activeStables: [],
    fairByBase: () => ({ WETH: FAIR }),
    ...overrides,
  };
}

// Drive the generator with canned stage results, recording what each stage asked for.
async function drive(
  ctx: ValuationContext,
  stages: Array<(reads: unknown[]) => unknown[]>,
) {
  const run = lstValuationRun(DEPLOYMENT, ctx);
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

// accountSummaryAt returns (shares, shareAssets, claimable, reachable, unreachable, openRequests).
function summary(
  shares: bigint,
  shareAssets: bigint,
  claimable = 0n,
  reachable = 0n,
  unreachable = 0n,
): readonly bigint[] {
  return [shares, shareAssets, claimable, reachable, unreachable, 0n];
}

test("valuation reads the queue delay and every account in one stage", async () => {
  const { asked, values } = await drive(valuationCtx(), [
    () => [20n, 0n, summary(WAD, WAD)],
    () => [(WAD * 9900n) / 10_000n],
  ]);
  // Stage 0 is the queue floor, the throughput, and one summary per agent; stage 1 is one quote
  // for the holder.
  assert.equal(asked[0].length, 3);
  assert.equal(asked[1].length, 1);
  // Par, since the queue fits (block 100 + 20 <= horizon 200), valued at the WETH fair.
  assert.equal(values[AGENT.id].valueUsdc, FAIR);
  assert.equal(values[AGENT.id].liquidatableValueUsdc, FAIR);
  assert.deepEqual(values[AGENT.id].unpriced, []);
});

test("an agent holding nothing costs no second-stage read", async () => {
  const { asked, values } = await drive(valuationCtx(), [
    () => [20n, summary(0n, 0n)],
  ]);
  assert.equal(
    asked.length,
    1,
    "a pool quote was requested for an empty position",
  );
  assert.equal(values[AGENT.id].valueUsdc, 0);
});

test("a redemption that outlives the run is reported, not counted", async () => {
  const { values } = await drive(valuationCtx(), [
    () => [20n, 0n, summary(0n, 0n, 0n, 0n, 2n * WAD)],
  ]);
  const value = values[AGENT.id];
  assert.equal(value.valueUsdc, 0);
  assert.deepEqual(value.unpriced, [
    {
      token: DEPLOYMENT.asset,
      amountRaw: (2n * WAD).toString(),
      source: "lst-withdrawal-queue",
      reason: "unrealizable",
      read: "MockLSTVault.accountSummaryAt",
    },
  ]);
});

test("an unreadable account is reported instead of scored as exited", async () => {
  const { values } = await drive(valuationCtx(), [
    () => [20n, 0n, undefined],
  ]);
  const value = values[AGENT.id];
  assert.equal(value.valueUsdc, 0);
  assert.equal(value.unpriced[0].reason, "read-failed");
  assert.equal(value.unpriced[0].source, "lst-position");
});

test("a refused pool quote is reported while the queue still carries the value", async () => {
  const { values } = await drive(valuationCtx(), [
    () => [20n, 0n, summary(WAD, WAD)],
    () => [undefined], // get_dy reverted (no liquidity at this size)
  ]);
  const value = values[AGENT.id];
  assert.equal(value.valueUsdc, FAIR, "the queue should still reach par");
  assert.equal(value.unpriced[0].source, "lst-market-quote");
});

test("the horizon the scorer passes is the one the vault splits the queue at", async () => {
  const { asked } = await drive(valuationCtx({ horizonBlock: 175 }), [
    () => [20n, 0n, summary(0n, 0n)],
  ]);
  const summaryRead = asked[0][2] as { args: unknown[] };
  assert.deepEqual(summaryRead.args, [AGENT.address, 175n]);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

test("the action schema exposes the lst actions only when the venue is enabled", () => {
  const withLst = agentActionSchemaFor(["lst"]);
  assert.ok(
    withLst.safeParse({ type: "lstDeposit", amountWethWei: "1000" }).success,
  );
  const withoutLst = agentActionSchemaFor(["uniswap"]);
  assert.ok(
    !withoutLst.safeParse({ type: "lstDeposit", amountWethWei: "1000" })
      .success,
  );
});

test("lstSwap only accepts the two tokens the market trades", () => {
  const schema = agentActionSchemaFor(["lst"]);
  assert.ok(
    schema.safeParse({ type: "lstSwap", tokenIn: "LST", amountIn: "1" })
      .success,
  );
  assert.ok(
    !schema.safeParse({ type: "lstSwap", tokenIn: "USDC", amountIn: "1" })
      .success,
  );
});

test("parse rejects a float amount and keeps the wei string intact", () => {
  assert.throws(() =>
    lstAdapter.parse({ type: "lstDeposit", amountWethWei: 1.5 }),
  );
  assert.deepEqual(
    lstAdapter.parse({
      type: "lstDeposit",
      amountWethWei: "1500000000000000000",
    }),
    { type: "lstDeposit", amountWethWei: "1500000000000000000" },
  );
});

test('claiming "all" is spelled as an omitted requestId', () => {
  assert.deepEqual(
    lstAdapter.parse({ type: "lstClaimWithdraw", requestId: "all" }),
    {
      type: "lstClaimWithdraw",
    },
  );
  assert.deepEqual(
    lstAdapter.parse({ type: "lstClaimWithdraw", requestId: "7" }),
    {
      type: "lstClaimWithdraw",
      requestId: "7",
    },
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function lstObservation(
  overrides: Partial<LstObservation> = {},
): LstObservation {
  return {
    redemptionRateWeth: 1.02,
    marketPriceWeth: 1.01,
    discountBps: 98,
    apyBps: 300,
    yieldPerBlockBps: 0.034,
    withdrawalDelayBlocks: 20,
    estimatedQueueDelayBlocks: 20,
    queueLength: 0,
    rewardReserveWei: (50n * WAD).toString(),
    lstBalanceWei: "0",
    lstRedemptionValueWethWei: "0",
    instantExitWethWei: "0",
    pendingWithdrawals: [],
    pendingWithdrawalWethWei: "0",
    claimableWithdrawalWethWei: "0",
    ...overrides,
  };
}

function observation(lst: LstObservation): AgentObservation {
  return {
    limits: {
      maxWethInWei: WAD.toString(),
      maxUsdcInUnits: "5000000000",
      maxLstDepositWethWei: (5n * WAD).toString(),
      defaultPriorityFeePerGasWei: "100000000",
      maxPriorityFeePerGasWei: "5000000000",
    },
    protocols: { lst },
  } as unknown as AgentObservation;
}

const balances = (wethWei: bigint): BalanceSnapshot => ({
  ethWei: WAD,
  wethWei,
  usdcUnits: 0n,
  bases: { WETH: wethWei },
});

test("a stake beyond the configured cap is rejected before it reaches the chain", () => {
  const obs = observation(lstObservation());
  const action = {
    type: "lstDeposit" as const,
    amountWethWei: (6n * WAD).toString(),
  };
  const result = lstAdapter.validate(action, obs, balances(10n * WAD));
  assert.equal(result.ok, false);
});

test("a stake beyond the WETH balance is rejected", () => {
  const obs = observation(lstObservation());
  const action = {
    type: "lstDeposit" as const,
    amountWethWei: (2n * WAD).toString(),
  };
  assert.equal(lstAdapter.validate(action, obs, balances(WAD / 2n)).ok, false);
  assert.equal(lstAdapter.validate(action, obs, balances(4n * WAD)).ok, true);
});

test("selling more LST than you hold is rejected against the observation, not the wallet", () => {
  // The LST balance is not part of BalanceSnapshot -- the token is valued by the adapter rather
  // than summed as spot -- so the check has to come from the observation.
  const obs = observation(lstObservation({ lstBalanceWei: WAD.toString() }));
  const tooMuch = {
    type: "lstSwap" as const,
    tokenIn: "LST" as const,
    amountIn: (2n * WAD).toString(),
  };
  assert.equal(lstAdapter.validate(tooMuch, obs, balances(0n)).ok, false);
  const fits = { ...tooMuch, amountIn: (WAD / 2n).toString() };
  assert.equal(lstAdapter.validate(fits, obs, balances(0n)).ok, true);
});

test("claiming with nothing finalized is rejected rather than burned on a revert", () => {
  const obs = observation(lstObservation());
  assert.equal(
    lstAdapter.validate({ type: "lstClaimWithdraw" }, obs, balances(0n)).ok,
    false,
  );
  const ready = observation(
    lstObservation({ claimableWithdrawalWethWei: WAD.toString() }),
  );
  assert.equal(
    lstAdapter.validate({ type: "lstClaimWithdraw" }, ready, balances(0n)).ok,
    true,
  );
});

// ---------------------------------------------------------------------------
// Phase 2: congestion, varying yield, slashing
// ---------------------------------------------------------------------------

test("scoring uses the congested wait, not the vault's advertised floor", async () => {
  // The floor is 20 blocks and the horizon is 80 away, so judging by the floor the queue "fits".
  // The real wait for this size is 90 blocks, which does not -- and marking it at par would credit
  // an exit the agent could never complete.
  const { values } = await drive(valuationCtx({ horizonBlock: 180 }), [
    () => [20n, WAD /* throughput: rate-limited */, summary(WAD, WAD)],
    // stage 1 is [get_dy, estimateDelayBlocks] for the one holder
    () => [(WAD * 9000n) / 10_000n, 90n],
  ]);
  // Falls back to the pool's price rather than par.
  assert.equal(values[AGENT.id].valueUsdc, FAIR * 0.9);
});

test("an unlimited queue costs no extra read", async () => {
  const { asked } = await drive(valuationCtx(), [
    () => [20n, 0n /* throughput 0 = no limit */, summary(WAD, WAD)],
    () => [WAD],
  ]);
  // Stage 1 is the pool quote only: no delay read when the queue is not rate-limited.
  assert.equal(asked[1].length, 1);
});
