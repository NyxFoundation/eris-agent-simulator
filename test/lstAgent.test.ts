// lst-carry's decision surface (issue #38).
//
// The venue is only exercised if the reference agent actually uses all of it, so these pin the
// branches that would otherwise rot into "always deposit": the carry, the premium harvest, and the
// two decisions that depend on how much run is left.
import test from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  decideCarry,
  queueFitsInRun,
} from "../example/agents/lst-carry/agent.js";
import type { LstObservation } from "@eris/sdk/types.js";

const WAD = 10n ** 18n;

function lst(overrides: Partial<LstObservation> = {}): LstObservation {
  return {
    redemptionRateWeth: 1.02,
    marketPriceWeth: 1.02,
    discountBps: 0,
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

const base = {
  wethBalanceWei: 10n * WAD,
  maxStakeWei: 5n * WAD,
  maxSwapWei: WAD,
  blocksRemaining: 60,
};

test("the queue check leaves slack rather than cutting it fine", () => {
  assert.ok(queueFitsInRun(60, 20));
  assert.ok(
    !queueFitsInRun(22, 20),
    "22 blocks is not enough room for a 20-block queue",
  );
  // No block limit means the queue is always an option.
  assert.ok(queueFitsInRun(undefined, 20));
});

test("a finalized redemption is claimed before anything else is considered", () => {
  // Even with a fat discount on the table, free WETH already in the queue comes first.
  const decision = decideCarry({
    ...base,
    lst: lst({ discountBps: 200, claimableWithdrawalWethWei: WAD.toString() }),
  });
  assert.equal(decision.kind, "claim");
});

test("a discount wider than costs buys LST", () => {
  const decision = decideCarry({ ...base, lst: lst({ discountBps: 60 }) });
  assert.equal(decision.kind, "carry");
  if (decision.kind !== "carry") return;
  // Sized off the WETH balance but clamped by the per-round swap cap.
  assert.equal(decision.wethIn, base.maxSwapWei);
});

test("a discount inside costs does not trade", () => {
  const decision = decideCarry({ ...base, lst: lst({ discountBps: 20 }) });
  assert.notEqual(decision.kind, "carry");
});

test("shares bought at a discount are queued for par on the next cycle", () => {
  const decision = decideCarry({
    ...base,
    wethBalanceWei: 0n, // spent on the carry leg
    lst: lst({ discountBps: 60, lstBalanceWei: WAD.toString() }),
  });
  assert.equal(decision.kind, "queue");
  if (decision.kind !== "queue") return;
  assert.equal(decision.lstIn, WAD);
});

test("redeeming what it holds comes before buying more", () => {
  // Buying first means buying until the discount closes and then holding an open position instead
  // of a realised profit -- measured in a live run as five buys and no redemption.
  const decision = decideCarry({
    ...base,
    wethBalanceWei: 10n * WAD,
    lst: lst({ discountBps: 60, lstBalanceWei: WAD.toString() }),
  });
  assert.equal(decision.kind, "queue");
});

test("a discount too small to have bought on is not worth queueing either", () => {
  // The bug this pins: a looser gate on the queue than on the buy drags the staked position into
  // the queue whenever the market drifts below par. A live run turned that into stake -> queue ->
  // stake churn and stranded 14 WETH in a queue that outlived the run.
  const decision = decideCarry({
    ...base,
    wethBalanceWei: 0n,
    lst: lst({ discountBps: 20, lstBalanceWei: WAD.toString() }),
  });
  assert.notEqual(decision.kind, "queue");
});

test("a premium is harvested by selling into the pool instead of queueing", () => {
  const decision = decideCarry({
    ...base,
    wethBalanceWei: 0n,
    lst: lst({ discountBps: -60, lstBalanceWei: WAD.toString() }),
  });
  assert.equal(decision.kind, "harvest");
});

test("with no dislocation it stakes toward the target allocation", () => {
  const decision = decideCarry({ ...base, lst: lst() });
  assert.equal(decision.kind, "stake");
  if (decision.kind !== "stake") return;
  // Target is 70% of the 10 WETH book, clamped by the 5 WETH per-stake cap.
  assert.equal(decision.wethIn, 5n * WAD);
});

test("it stops staking once the target allocation is reached", () => {
  // The bug this pins: staking a fixed slice of the *remaining* balance every block converges on the
  // same allocation while paying gas every time. A live run spent its entire loss that way.
  const decision = decideCarry({
    ...base,
    wethBalanceWei: 2n * WAD,
    lst: lst({ lstRedemptionValueWethWei: (8n * WAD).toString() }),
  });
  assert.equal(decision.kind, "hold");
});

test("queued WETH still counts as staked for the allocation", () => {
  // Shares in the withdrawal queue are on their way out, but they are not free WETH either --
  // counting them as unstaked would restake the same capital twice.
  const decision = decideCarry({
    ...base,
    wethBalanceWei: 2n * WAD,
    lst: lst({ pendingWithdrawalWethWei: (8n * WAD).toString() }),
  });
  assert.equal(decision.kind, "hold");
});

test("it stops staking once an exit could no longer be queued", () => {
  // Staking into the last blocks buys yield you cannot collect and an exit that has to pay the
  // pool's discount.
  const decision = decideCarry({ ...base, blocksRemaining: 10, lst: lst() });
  assert.equal(decision.kind, "hold");
});

test("it does not chase a discount it cannot redeem in time", () => {
  const decision = decideCarry({
    ...base,
    blocksRemaining: 10,
    lst: lst({ discountBps: 200 }),
  });
  assert.notEqual(decision.kind, "carry");
});

test("late in the run it holds rather than paying the pool to exit", () => {
  // Scoring already marks the shares at what the pool would pay, so selling here just donates the
  // fee. The reason has to say that, since a silent noop reads as a bug.
  const decision = decideCarry({
    ...base,
    blocksRemaining: 5,
    lst: lst({ lstBalanceWei: (2n * WAD).toString() }),
  });
  assert.equal(decision.kind, "hold");
  if (decision.kind !== "hold") return;
  assert.match(decision.reason, /queue no longer fits/);
});

test("a premium is still harvested late in the run", () => {
  // Selling is the only exit left anyway, so a pool paying above par is worth taking.
  const decision = decideCarry({
    ...base,
    blocksRemaining: 5,
    wethBalanceWei: 0n,
    lst: lst({ discountBps: -80, lstBalanceWei: WAD.toString() }),
  });
  assert.equal(decision.kind, "harvest");
});

test("dust does not trigger an action", () => {
  const decision = decideCarry({
    ...base,
    wethBalanceWei: 10n ** 12n, // 0.000001 WETH: gas would cost more than the yield
    lst: lst(),
  });
  assert.equal(decision.kind, "hold");
});

// ---------------------------------------------------------------------------
// Phase 2: the yield moves, so staking is a live decision
// ---------------------------------------------------------------------------

test("it does not stake through a lean stretch", () => {
  // The yield varies during the run (issue #38 phase 2). Below the floor it stops paying for the
  // slashing exposure that holding LST carries, so the right move is to sit in WETH.
  const decision = decideCarry({ ...base, lst: lst({ apyBps: 120 }) });
  assert.equal(decision.kind, "hold");
  if (decision.kind !== "hold") return;
  assert.match(decision.reason, /below the 200bps floor/);
});

test("it stakes again once the yield recovers", () => {
  const decision = decideCarry({ ...base, lst: lst({ apyBps: 600 }) });
  assert.equal(decision.kind, "stake");
});

test("a lean yield does not stop it taking a real discount", () => {
  // The carry is paid by the discount, not by the yield, so a poor APY is no reason to skip it.
  const decision = decideCarry({
    ...base,
    lst: lst({ apyBps: 120, discountBps: 60 }),
  });
  assert.equal(decision.kind, "carry");
});

test("congestion, not the advertised floor, closes the queue", () => {
  // The floor says 20 blocks and 40 remain, so the floor would green-light this. The queue is
  // congested and actually quotes 36, which does not fit.
  const decision = decideCarry({
    ...base,
    blocksRemaining: 40,
    wethBalanceWei: 0n,
    lst: lst({
      discountBps: 60,
      lstBalanceWei: WAD.toString(),
      withdrawalDelayBlocks: 20,
      estimatedQueueDelayBlocks: 36,
    }),
  });
  assert.notEqual(decision.kind, "queue");
});

test("a position too large for the queue is redeemed in the slice that fits", () => {
  // 30 blocks left, a 20-block floor and a 4-block margin leave 6 blocks of draining at 1 WETH per
  // block. Queueing all 10 WETH would strand 4 of them past the horizon (scored as unrealizable);
  // refusing to queue would forfeit the 6 that would have made it.
  const decision = decideCarry({
    ...base,
    blocksRemaining: 30,
    wethBalanceWei: 0n,
    lst: lst({
      discountBps: 60,
      lstBalanceWei: (10n * WAD).toString(),
      lstRedemptionValueWethWei: (10n * WAD).toString(),
      withdrawalDelayBlocks: 20,
      queueDelayPerWethBlocks: 21,
      estimatedQueueDelayBlocks: 30,
      queueThroughputWeiPerBlock: WAD.toString(),
    }),
  });
  assert.equal(decision.kind, "queue");
  if (decision.kind !== "queue") return;
  assert.equal(decision.lstIn, 6n * WAD);
});

test("an unlimited queue still redeems the whole position", () => {
  const decision = decideCarry({
    ...base,
    blocksRemaining: 30,
    wethBalanceWei: 0n,
    lst: lst({
      discountBps: 60,
      lstBalanceWei: (10n * WAD).toString(),
      lstRedemptionValueWethWei: (10n * WAD).toString(),
      // No throughput limit reported: the floor is the whole story.
    }),
  });
  assert.equal(decision.kind, "queue");
  if (decision.kind !== "queue") return;
  assert.equal(decision.lstIn, 10n * WAD);
});

// ---------------------------------------------------------------------------
// Phase 3: leverage, and the empty-hands case it created
// ---------------------------------------------------------------------------

test("empty hands with a posted position is not treated as an unusable venue", () => {
  // The bug this pins: a levered position holds its whole book as Aave collateral, so checking the
  // wallet alone reads "no WETH and no LST" as a misconfigured run. The agent then returned noop
  // from before the decision log, and the run looked like an agent that had stopped responding.
  const obs = {
    balances: { wethWei: "0", usdcUnits: "0", ethWei: "0" },
    fairPriceUsdcPerWeth: 3000,
    round: 1,
    limits: {
      maxWethInWei: WAD.toString(),
      maxLstDepositWethWei: (5n * WAD).toString(),
      defaultPriorityFeePerGasWei: "100000000",
    },
    protocols: {
      lst: lst({ aaveCollateral: true }),
      aave: {
        healthFactor: (2n ** 256n - 1n).toString(),
        totalCollateralBase: "1500000000000", // $15k posted
        totalDebtBase: "0",
        availableBorrowsBase: "0",
        supplied: {},
        borrowed: {},
      },
    },
  } as never;
  const action = decide(obs) as { type: string; reason?: string };
  assert.notEqual(
    action.reason,
    "no WETH and no LST: the lst venue is WETH-denominated, so this run needs funding.wethWei > 0",
  );
});

test("a borrow is sized to land on the target health factor, not past it", async () => {
  // Sizing off the headroom overshoots the target and the floor beneath it: measured as 24 borrows
  // against 22 forced repayments, oscillating 2.89 <-> 1.56. Scaling the existing debt by
  // hf/target lands on the target instead, because HF is collateral x LT / debt.
  process.env.ERIS_LST_LEVERAGE_TARGET_HF = "2.0";
  const mod = await import(
    `../example/agents/lst-carry/agent.js?lev=${Date.now()}`
  );
  // $3000 of debt at HF 3.0, target 2.0 -> borrow another $1500 to halve the ratio.
  const decision = mod.decideLeverage({
    lst: lst({ aaveCollateral: true }),
    aave: {
      healthFactor: (3n * WAD).toString(),
      totalDebtBase: (3000n * 10n ** 8n).toString(),
      availableBorrowsBase: (9000n * 10n ** 8n).toString(),
    },
    wethBalanceWei: 0n,
    fairPriceUsd: 3000,
  });
  assert.equal(decision?.kind, "borrow");
  // $1500 at $3000/WETH = 0.5 WETH.
  assert.equal(decision.wethOut, WAD / 2n);
  process.env.ERIS_LST_LEVERAGE_TARGET_HF = "0";
});
