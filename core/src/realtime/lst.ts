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
import type { RunLogger } from "../logger.js";

// accrueRewards touches a handful of slots. Pinning the gas skips viem's eth_estimateGas (an extra
// EVM execution) on a tx the environment sends every block.
const ACCRUE_GAS = 200_000n;

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
};

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
  });
  if (!canConfigure) {
    console.warn(
      `[lst] the admin key is not a vault operator, so this run inherits the deployed rate ` +
        `(${state.apyBps.toFixed(1)}bps APY) instead of the configured ${ctx.config.lstApyBps}bps`,
    );
  }

  // Fail fast on a market that does not track redemption. |discount| is used rather than the
  // signed value: a large premium is the same breakage seen from the other side.
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

  return {
    vault: LST.vault,
    canConfigure,
    rewardRatePerBlockRay: targetRate,
  };
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
  functionName: "setRewardRate" | "setWithdrawalDelayBlocks" | "accrueRewards",
  args: readonly unknown[],
): Hex {
  return encodeFunctionData({
    abi: lstVaultAbi,
    functionName,
    args: args as never,
  });
}
