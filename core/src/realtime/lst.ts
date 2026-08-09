// LST venue: the environment's side of the clock (issue #38).
//
// Yield does not come from EVM time. Warping time would also move Aave's rate accrual and GMX
// funding, so the vault runs on its own compressed *economic* clock instead: one block stands for
// `lst.simulatedSecondsPerBlock` seconds of staking, and the target APY is deliberately the same
// order as Aave's WETH supply rate -- a 1000x-speed LST would make every other venue irrelevant.
//
// Everything else about the venue is deployed (the vault and its pool are baked into the ADR 0016
// state dump for backtest fingerprinting). Only the per-block accrual and the phase-2 slash belong
// to the coordinator, which is all this file does.
import { encodeFunctionData, type Address, type Hex } from "viem";
import { lstVaultAbi } from "@eris/sdk/abis.js";
import { accountAddress, sendAndMine, sendNoMine } from "@eris/sdk/chain.js";
import { LST } from "@eris/sdk/constants.js";
import { getLstState, rewardRatePerBlockRay } from "@eris/sdk/protocols/lst.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import { Rng } from "@eris/sdk/rng.js";
import type { RunLogger } from "../logger.js";

// accrueRewards touches a handful of slots. Pinning the gas skips viem's eth_estimateGas (an extra
// EVM execution) on a tx the environment sends every block.
const ACCRUE_GAS = 200_000n;

// Salt for the APY Rng, so resampling the yield never disturbs the price path's or the flow's
// consumption sequence (same discipline as the stress overlay's STRS salt).
const LST_SEED_SALT = 0x4c_53_54_59; // "LSTY"

// A discount this large right after setup means the pool is not tracking the vault's redemption
// rate -- almost always an unwired rate oracle, which hands every agent the same risk-free arb
// (a beta-style freebie that destroys discrimination, ADR 0007). Calibration noise is far smaller.
export const LST_STARTUP_WARN_BPS = 25;
export const LST_STARTUP_FAIL_BPS = 200;

export type LstRuntime = {
  vault: Address;
  // Whether the environment's admin key can reconfigure the vault. Without it the run inherits the
  // rate baked in at deploy time, which is legitimate -- it just cannot be retuned per run.
  canConfigure: boolean;
  rewardRatePerBlockRay: bigint;
  // Phase 2: the seed-derived APY path, if the run asked for a varying one.
  apySchedule: ApySchedule | null;
};

/// Seed-driven APY variation (issue #38 phase 2).
///
/// A constant yield makes the venue trivial -- "stake everything at block 0" is optimal and stays
/// optimal. Resampling it from a range on a fixed cadence means holding LST has a changing
/// opportunity cost against the pool's discount, so the allocation is a decision rather than a
/// setup step. Deterministic in the seed, from an Rng of its own so the price path is untouched.
export class ApySchedule {
  private readonly rng: Rng;
  private readonly range: [number, number];
  readonly stepBlocks: number;
  private currentBps: number;
  private stepsTaken = 0;

  constructor(
    seed: number,
    range: [number, number],
    stepBlocks: number,
    initialBps: number,
  ) {
    this.rng = new Rng((seed ^ LST_SEED_SALT) >>> 0);
    this.range = range;
    this.stepBlocks = Math.max(1, stepBlocks);
    this.currentBps = initialBps;
  }

  /// The APY as of `blockIndex`, or null when nothing changed and no write is needed.
  ///
  /// Driven by "how many steps should have happened by now" rather than by an exact modulo, because
  /// the coordinator drops block notifications while it is busy. A missed index used to skip both
  /// the resample *and* its Rng draw, so every later step drew a different value than the same
  /// seed produced elsewhere -- destroying the reproducibility the salted Rng exists to give.
  nextAt(blockIndex: number): number | null {
    const dueSteps = Math.floor(blockIndex / this.stepBlocks) + 1;
    if (dueSteps <= this.stepsTaken) return null;
    const [lo, hi] = this.range;
    let sampled = this.currentBps;
    // Consume every draw the seed owes, so a dropped block costs a block of staleness and nothing
    // more. The path stays a pure function of (seed, blockIndex).
    while (this.stepsTaken < dueSteps) {
      sampled = Math.round(lo + (hi - lo) * this.rng.next());
      this.stepsTaken += 1;
    }
    if (sampled === this.currentBps) return null;
    this.currentBps = sampled;
    return sampled;
  }

  get apyBps(): number {
    return this.currentBps;
  }
}

/// Align the deployed vault with this run's economic clock, and refuse to start on a market that
/// is not tracking the redemption rate.
export async function setupLst(
  ctx: SimContext,
  logger: RunLogger,
): Promise<LstRuntime | null> {
  if (!LST) {
    throw new Error(
      "the lst protocol is enabled but no LST deployment is available: the venue exists only " +
        "under local deploy (issue #38). Enable run.localDeploy with a state dump that includes lst, or drop lst from run.protocols.",
    );
  }
  const admin = accountAddress(ctx.adminPk);
  const canConfigure = (await ctx.publicClient.readContract({
    address: LST.vault,
    abi: lstVaultAbi,
    functionName: "operators",
    args: [admin],
  })) as boolean;

  const targetRate = rewardRatePerBlockRay(
    ctx.config.lstApyBps,
    ctx.config.lstSimulatedSecondsPerBlock,
  );
  if (canConfigure) {
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: LST.vault,
        data: encodeCall("setRewardRate", [targetRate]),
      },
    );
    if (ctx.config.lstWithdrawalDelayBlocks > 0) {
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: LST.vault,
          data: encodeCall("setWithdrawalDelayBlocks", [
            BigInt(ctx.config.lstWithdrawalDelayBlocks),
          ]),
        },
      );
    }
    if (ctx.config.lstQueueThroughputWeiPerBlock > 0n) {
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        {
          to: LST.vault,
          data: encodeCall("setQueueThroughput", [
            ctx.config.lstQueueThroughputWeiPerBlock,
          ]),
        },
      );
    }
  }

  const state = await getLstState(ctx);
  logger.event({
    type: "lst_setup",
    vault: LST.vault,
    pool: LST.pool,
    configured: canConfigure,
    // What the run asked for versus what the vault is actually running, so an inherited rate is
    // visible rather than silently different from the config.
    requestedApyBps: ctx.config.lstApyBps,
    effectiveApyBps: state.apyBps,
    simulatedSecondsPerBlock: ctx.config.lstSimulatedSecondsPerBlock,
    withdrawalDelayBlocks: state.withdrawalDelayBlocks,
    rewardReserveWei: state.rewardReserveWei.toString(),
    redemptionRateWeth: state.redemptionRateWeth,
    marketPriceWeth: state.midPriceWeth,
    discountBps: state.discountBps,
    // Phase 2 knobs, so a run's variation is visible in the log rather than only in its effects.
    apyRangeBps: ctx.config.lstApyRangeBps,
    apyStepBlocks: ctx.config.lstApyRangeBps ? ctx.config.lstApyStepBlocks : 0,
    queueThroughputWeiPerBlock: state.queueThroughputWeiPerBlock.toString(),
  });
  if (!canConfigure) {
    console.warn(
      `[lst] the admin key is not a vault operator, so this run inherits the deployed rate ` +
        `(${state.apyBps.toFixed(1)}bps APY) instead of the configured ${ctx.config.lstApyBps}bps`,
    );
  }

  // Fail fast on a market that does not track redemption. |discount| is used rather than the
  // signed value: a large premium is the same breakage seen from the other side. A pool that did
  // not quote at all is a different failure and gets its own message rather than being reported
  // as a 10000bps oracle fault.
  if (!state.marketQuoted) {
    throw new Error(
      "the LST/WETH pool did not quote at startup: it reverted or has no liquidity at probe size. " +
        "Check that the deploy seeded it (deployer/src/protocols/lst.ts), or drop lst from run.protocols.",
    );
  }
  const absDiscount = Math.abs(state.discountBps);
  if (absDiscount > LST_STARTUP_FAIL_BPS) {
    throw new Error(
      `lst no-arbitrage check failed at startup: the LST/WETH market sits ${state.discountBps.toFixed(1)}bps ` +
        `off the vault's redemption rate (limit ${LST_STARTUP_FAIL_BPS}bps). The usual cause is the pool's ` +
        "rate oracle not being wired to stEthPerToken, which leaves a permanent risk-free arb for everyone.",
    );
  }
  if (absDiscount > LST_STARTUP_WARN_BPS) {
    console.warn(
      `[lst] the LST/WETH market opens ${state.discountBps.toFixed(1)}bps off redemption ` +
        `(warn above ${LST_STARTUP_WARN_BPS}bps)`,
    );
  }

  if (state.rewardReserveWei === 0n) {
    logger.event({
      type: "lst_reward_reserve_empty",
      note: "the vault has no funded rewards left, so the redemption rate will not rise this run",
    });
  }

  // Varying the yield needs operator rights (it is a setRewardRate per step). Without them the run
  // keeps the deployed rate, which is a real limitation rather than a silent downgrade.
  const apySchedule =
    canConfigure && ctx.config.lstApyRangeBps
      ? new ApySchedule(
          ctx.config.seed,
          ctx.config.lstApyRangeBps,
          ctx.config.lstApyStepBlocks,
          ctx.config.lstApyBps,
        )
      : null;
  if (ctx.config.lstApyRangeBps && !canConfigure) {
    console.warn(
      "[lst] lst.apyRangeBps was set but the admin key is not a vault operator, so the yield stays fixed",
    );
  }

  return {
    vault: LST.vault,
    canConfigure,
    rewardRatePerBlockRay: targetRate,
    apySchedule,
  };
}

/// Resample the APY for this block if the schedule says so (issue #38 phase 2). Returns the new
/// value when it changed, so the caller can log it.
export async function stepLstApy(
  ctx: SimContext,
  runtime: LstRuntime,
  blockIndex: number,
  priorityFeeWei: bigint,
): Promise<number | null> {
  const next = runtime.apySchedule?.nextAt(blockIndex);
  if (next === null || next === undefined) return null;
  const rate = rewardRatePerBlockRay(
    next,
    ctx.config.lstSimulatedSecondsPerBlock,
  );
  await sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: runtime.vault,
      data: encodeCall("setRewardRate", [rate]),
      gas: ACCRUE_GAS,
    },
    priorityFeeWei,
  );
  return next;
}

/// Apply a staking penalty (the stress overlay's lstSlash, issue #38 phase 2). The vault settles
/// accrued rewards first, so the cut lands on the current pool rather than on a stale one.
export async function slashLst(
  ctx: SimContext,
  runtime: LstRuntime,
  magnitude: number,
  logger: RunLogger,
  priorityFeeWei: bigint,
): Promise<void> {
  const bps = BigInt(Math.round(magnitude * 10_000));
  if (bps <= 0n) return;
  if (!runtime.canConfigure) {
    logger.event({
      type: "lst_slash_skipped",
      reason: "the admin key is not a vault operator",
      bps: Number(bps),
    });
    return;
  }
  const before = await getLstState(ctx);
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: runtime.vault,
      data: encodeCall("slash", [bps]),
    },
  );
  const after = await getLstState(ctx);
  logger.event({
    type: "lst_slash",
    bps: Number(bps),
    redemptionRateBefore: before.redemptionRateWeth,
    redemptionRateAfter: after.redemptionRateWeth,
    // The market has not repriced yet: the gap this opens is the opportunity the event creates.
    marketPriceWeth: after.midPriceWeth,
    discountBps: after.discountBps,
  });
}

/// Advance the vault's clock one block. Accrual is permissionless and its size is a pure function
/// of blocks elapsed, so this only keeps the on-chain rate current -- it grants the environment
/// nothing an agent could not do itself.
export async function accrueLst(
  ctx: SimContext,
  runtime: LstRuntime,
  opts: { priorityFeeWei: bigint },
): Promise<Hex> {
  return sendNoMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: runtime.vault,
      data: encodeCall("accrueRewards", []),
      gas: ACCRUE_GAS,
    },
    opts.priorityFeeWei,
  );
}

// The vault also exposes `slash`, gated to the same operator. Nothing calls it yet: a slashing
// event belongs to the stress overlay, which is phase 2 of issue #38. It lives in the contract
// rather than waiting for that phase because the vault is baked into the state dump, and adding a
// function later would mean rebuilding the dump.

/// Per-block telemetry: how far the market is from redemption, and whether the reserve is running
/// out. Cheap (one readState the coordinator already needs) and the primary post-run source for
/// whether the venue behaved.
export function lstBlockEvent(
  state: Awaited<ReturnType<typeof getLstState>>,
  blockNumber: number,
): Record<string, unknown> {
  return {
    type: "lst_block",
    blockNumber,
    redemptionRateWeth: state.redemptionRateWeth,
    marketPriceWeth: state.midPriceWeth,
    discountBps: state.discountBps,
    queueLength: state.queueLength,
    rewardReserveWei: state.rewardReserveWei.toString(),
  };
}

function encodeCall(
  functionName:
    | "setRewardRate"
    | "setWithdrawalDelayBlocks"
    | "setQueueThroughput"
    | "accrueRewards"
    | "slash",
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({
    abi: lstVaultAbi,
    functionName,
    args: args as never,
  });
}
