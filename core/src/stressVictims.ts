// The seed-derived victim cohort that makes liquidation possible (ADR 0009 §4).
//
// It replaced a single fixed-key victim driven by ERIS_LIQUIDATION_DEMO, which shocked the Aave
// oracle directly from a configured round. That predecessor was removed once the realtime path
// arrived: a crash bakes the effective price into the Aave oracle through the ordinary mempool, so
// the victims break naturally and consistently with scoring and the PriceFeed, and nothing has to
// overwrite an oracle behind the price series.
import {
  encodeFunctionData,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { accountAddress, fundWallet, sendAndMine } from "@eris/sdk/chain.js";
import { AAVE, TOKENS } from "@eris/sdk/constants.js";
import { aavePoolAbi } from "@eris/sdk/protocols/aave.js";
import { approveTx } from "@eris/sdk/protocols/uniswap.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";

const AAVE_STABLE = TOKENS.USDC.address;
const VARIABLE_RATE = 2n;

// The cohort is built in the setup phase at HF≈HF0 and left alone; the crash window is what breaks
// it. Victims are excluded from scoring, which is what makes them a profit source for a liquidator
// agent rather than a competitor.
//
// [HARD REQUIREMENT] fresh state is required: since victims are built every run, with a soft-reset
// (anvil_reset []) the previous run's victim positions linger/stick and the HF calculation breaks.
// A fork satisfies this via a full re-fork (ARB_RPC_URL); a local deploy via resetFork's snapshot/revert
// clean slice (the calling coordinator fail-fast checks this. ADR 0009 §4 / ADR 0016 §2).

export type StressVictim = { id: string; privateKey: Hex; address: Address };

// Derive the victim cohort from seed-derived keys (deterministically reproducible per regime. addresses are fixed by seed).
export function deriveStressVictims(
  seed: number,
  count: number,
): StressVictim[] {
  const victims: StressVictim[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = keccak256(
      stringToBytes(`eris-stress-victim:${seed}:${i}`),
    );
    victims.push({
      id: `victim-${i}`,
      privateKey,
      address: accountAddress(privateKey),
    });
  }
  return victims;
}

// Fund each victim and approve the Aave Pool (once, during the setup phase. before interval mining).
export async function setupStressVictims(
  ctx: SimContext,
  victims: StressVictim[],
): Promise<void> {
  const { publicClient, walletClient, chain, config } = ctx;
  for (const v of victims) {
    await fundWallet(
      publicClient,
      walletClient,
      chain,
      v.privateKey,
      1_000_000_000_000_000_000n, // 1 ETH (gas)
      config.stressVictimSupplyWethWei + 1_000_000_000_000_000_000n, // supply + buffer
      1_000_000n, // 1 USDC (dust. victims borrow USDC, so no initial inventory is needed)
    );
    for (const tx of [
      approveTx(TOKENS.WETH.address, AAVE.Pool),
      approveTx(AAVE_STABLE, AAVE.Pool),
    ]) {
      await sendAndMine(publicClient, walletClient, chain, v.privateKey, {
        to: tx.to,
        data: tx.data,
      });
    }
  }
}

// Headroom to keep the borrow off the LTV edge (so a tiny state change between read->execute doesn't
// revert). Cap at 97% of availableBorrowsBase. An HF0 where targetUsdc doesn't fit under this clings to
// the LTV edge, so raise a feasibility error (the old code silently clamped to 99%, so from the 3rd victim
// on the borrow reverted at the margin -> entered the competition with debt=0. ADR 0009 §4 fix).
const VICTIM_LTV_HEADROOM_BPS = 9_700n;

// Account data for one victim (getUserAccountData).
async function victimAccountData(
  ctx: SimContext,
  address: Address,
): Promise<readonly bigint[]> {
  return (await ctx.publicClient.readContract({
    address: AAVE.Pool,
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [address],
  })) as readonly bigint[];
}

// Send a tx and verify the effect landed on chain, retrying once if not reflected.
// Under full re-fork setup, sendAndMine occasionally drops it (a transient mining race was observed
// where a different victim fails each time). sendAndMine doesn't check tx status, so re-reading to
// confirm the effect is the reliable approach.
async function sendVerified(
  ctx: SimContext,
  victim: StressVictim,
  data: Hex,
  landed: (acc: readonly bigint[]) => boolean,
  failMessage: string,
): Promise<readonly bigint[]> {
  const { publicClient, walletClient, chain } = ctx;
  for (let attempt = 0; attempt < 2; attempt++) {
    await sendAndMine(publicClient, walletClient, chain, victim.privateKey, {
      to: AAVE.Pool,
      data,
    });
    const acc = await victimAccountData(ctx, victim.address);
    if (landed(acc)) return acc;
  }
  throw new Error(`stress victim ${victim.id}: ${failMessage}`);
}

// Each victim supplies WETH -> borrows USDC to reach the target HF (hf0).
// Calibration (ADR 0009 §4. not a free parameter):
//   For a victim with WETH collateral and USDC debt, HF = (W·P·LT)/D. Building at target debt
//   D* = C·LT/HF0 gives HF≈HF0. Post-crash HF is HF0·(1−m), so liquidation at m > (HF0−1)/HF0.
//   However HF0 must satisfy the LTV cap (D ≤ C·LTV), and with headroom it can only be built if
//   HF0 ≳ LT/(0.97·LTV) (with measured Arbitrum WETH LT=0.84/LTV=0.80, ≈1.08).
//   Below this boundary the borrow clings to the LTV edge and reverts, so an unsatisfiable HF0 fail-fasts.
export async function openStressVictimPositions(
  ctx: SimContext,
  victims: StressVictim[],
  hf0: number,
): Promise<void> {
  const { config } = ctx;
  const h0Bps = BigInt(Math.round(hf0 * 10_000));
  for (const v of victims) {
    // supply (verify the collateral landed, retrying once on a transient drop)
    const supplyData = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [
        TOKENS.WETH.address,
        config.stressVictimSupplyWethWei,
        v.address,
        0,
      ],
    });
    const acc = await sendVerified(
      ctx,
      v,
      supplyData,
      (a) => a[0] > 0n,
      "WETH supply did not register (collateral=0 after retry). " +
        "Likely a transient setup mining race or a reverted supply (check reserve caps/flags). ADR 0009 §4",
    );
    // acc: [totalCollateralBase, totalDebtBase, availableBorrowsBase,
    //       currentLiquidationThreshold(bps), ltv(bps), healthFactor(1e18)] (USD is 8-digit)
    const collateralUsd8 = acc[0];
    const availUsd8 = acc[2];
    const ltBps = acc[3];
    const ltvBps = acc[4];
    // target debt (USD8) = C·LT/HF0 -> to USDC (6-digit) with /1e2
    const targetUsdc = (collateralUsd8 * ltBps) / h0Bps / 100n;
    // Cap the LTV limit at VICTIM_LTV_HEADROOM_BPS (keep it off the edge).
    const maxUsdc = (availUsd8 * VICTIM_LTV_HEADROOM_BPS) / 10_000n / 100n;
    if (targetUsdc <= 0n || targetUsdc > maxUsdc) {
      const ltOverLtv =
        ltvBps > 0n ? Number(ltBps) / Number(ltvBps) : Number.NaN;
      throw new Error(
        `stress victim ${v.id}: HF0=${hf0} is infeasible to build on this reserve ` +
          `(LT=${ltBps} / LTV=${ltvBps} bps; need HF0 ≳ ${(ltOverLtv / 0.97).toFixed(3)}). ` +
          "Raise ERIS_STRESS_VICTIM_HF0 (and crash magnitude so m > (HF0−1)/HF0). ADR 0009 §4",
      );
    }
    // borrow (verify the debt landed, retrying once on a transient drop)
    const borrowData = encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "borrow",
      args: [AAVE_STABLE, targetUsdc, VARIABLE_RATE, 0, v.address],
    });
    await sendVerified(
      ctx,
      v,
      borrowData,
      (a) => a[1] > 0n,
      "borrow did not register (debt=0 after retry). The borrow tx likely reverted " +
        "(reserve borrow cap / liquidity / LTV edge). Lower victim count or supply, " +
        "or adjust ERIS_STRESS_VICTIM_HF0. ADR 0009 §4",
    );
  }
}

export type VictimAccount = {
  id: string;
  address: Address;
  healthFactor: bigint; // 1e18 = 1.0
  totalCollateralBase: bigint; // USD 8-digit
  totalDebtBase: bigint; // USD 8-digit
};

// Bulk-read the victim cohort's account state (HF / collateral / debt). For visualization, liquidation detection, and stress metrics.
export async function readVictimsAccount(
  ctx: SimContext,
  victims: StressVictim[],
): Promise<VictimAccount[]> {
  // The batch transport bundles independent reads into a Multicall3 / JSON-RPC batch.
  const accounts = await Promise.all(
    victims.map(
      (v) =>
        ctx.publicClient.readContract({
          address: AAVE.Pool,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [v.address],
        }) as Promise<readonly bigint[]>,
    ),
  );
  return victims.map((v, i) => {
    const acc = accounts[i];
    return {
      id: v.id,
      address: v.address,
      healthFactor: acc[5],
      totalCollateralBase: acc[0],
      totalDebtBase: acc[1],
    };
  });
}
