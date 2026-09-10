// The seed-derived Liquity victim cohort (issue #107): the CDP counterpart of ADR 0009's Aave
// victims (core/src/stressVictims.ts).
//
// Why it exists: the CDP venue is deployed in every official regime and nothing in the set gives it
// work. The genesis Trove sits at 300 %, trove-manager defends its own, eUSD is seeded at par -- so
// across the eight epochs of the 2026-09-08 fixture (#94) `liquity_liquidation` never fired and
// redemption-arb never redeemed. A cohort opened near MCR turns a crash into liquidations (the
// Stability Pool's work) and a depeg into redemptions against the riskiest Trove (redemption arb's
// work), while trove-manager has to keep its own Trove out of the redemption path.
//
// Victims are passive: they open one Trove each at the configured ICR, keep the eUSD they minted,
// and are never scored (not in agentRuntimes). The same hard requirement as the Aave cohort applies
// -- fresh state per run, checked by the caller -- because a Trove that lingers from a previous run
// would sit in the sorted list at an ICR nobody configured.
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { troveManagerAbi } from "@eris/sdk/abis.js";
import { accountAddress, fundWallet, sendAndMine } from "@eris/sdk/chain.js";
import { LIQUITY } from "@eris/sdk/constants.js";
import { liquityAdapter } from "@eris/sdk/protocols/liquity.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";

const WAD = 10n ** 18n;

export type LiquityVictim = { id: string; privateKey: Hex; address: Address };

// Deterministic per (seed, index), on a salt of its own so the addresses never coincide with the
// Aave cohort's (`eris-stress-victim:`) or any flow wallet.
export function deriveLiquityVictims(
  seed: number,
  count: number,
): LiquityVictim[] {
  const victims: LiquityVictim[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = keccak256(
      stringToBytes(`eris-liquity-victim:${seed}:${i}`),
    );
    victims.push({
      id: `liquity-victim-${i}`,
      privateKey,
      address: accountAddress(privateKey),
    });
  }
  return victims;
}

// The debt to request so that the Trove *lands* at ICR₀ once Liquity has added the borrowing fee
// and the gas compensation to it. Liquity's ICR is coll·price / (debt + fee(debt) + gasComp), with
// fee(debt) = debt·rate (rate = the floor 0.5 % plus the decayed baseRate; getBorrowingRateWithDecay).
// Solving for the requested debt: debt = (coll·price/ICR₀ − gasComp) / (1 + rate). Pure, so the
// arithmetic can be pinned by a test without a chain (all WAD-scaled except icr0).
export function victimDebtForIcr(input: {
  collWei: bigint;
  priceWad: bigint; // USD per ETH, 1e18
  icr0: number;
  borrowingRateWad: bigint; // 1e18 = 100 %
  gasCompensationWei: bigint;
}): bigint {
  const icrWad = BigInt(Math.round(input.icr0 * 1e6)) * (WAD / 1_000_000n);
  const totalDebt = (input.collWei * input.priceWad) / icrWad;
  if (totalDebt <= input.gasCompensationWei) return 0n;
  return ((totalDebt - input.gasCompensationWei) * WAD) / (WAD + input.borrowingRateWad);
}

// The crash magnitude that puts a Trove opened at ICR₀ below MCR: ICR₀·(1 − m) < MCR ⇔ m > 1 − MCR/ICR₀.
// 1.20 → 0.083. The calibration warning the coordinator emits reads this.
export function liquityBreachMagnitude(icr0: number, mcr: number): number {
  return 1 - mcr / icr0;
}

// Fund each victim (gas ETH + the collateral as WETH; the adapter unwraps it at open time).
export async function setupLiquityVictims(
  ctx: SimContext,
  victims: LiquityVictim[],
  collWei: bigint,
): Promise<void> {
  const { publicClient, walletClient, chain } = ctx;
  for (const v of victims) {
    await fundWallet(
      publicClient,
      walletClient,
      chain,
      v.privateKey,
      1_000_000_000_000_000_000n, // 1 ETH (gas; openTrove pays with the WETH once unwrapped)
      collWei + 100_000_000_000_000_000n, // the collateral plus a 0.1 WETH buffer
      1_000_000n, // 1 USDC of dust: the cohort never trades
    );
  }
}

export type LiquityVictimTrove = {
  id: string;
  address: Address;
  // 1 = active, 2 = closed by owner, 3 = closed by liquidation, 4 = closed by redemption (Liquity's Status enum).
  status: number;
  debtEusdWei: bigint;
  collWei: bigint;
  icr: number; // against the price given to the reader; NaN when the Trove is gone
};

const NO_DEBT = 1e9;

async function readOne(
  ctx: SimContext,
  v: LiquityVictim,
  priceUsd: number,
): Promise<LiquityVictimTrove> {
  const d = LIQUITY!;
  const [status, entire] = await Promise.all([
    ctx.publicClient.readContract({
      address: d.troveManager,
      abi: troveManagerAbi,
      functionName: "getTroveStatus",
      args: [v.address],
    }) as Promise<bigint>,
    ctx.publicClient.readContract({
      address: d.troveManager,
      abi: troveManagerAbi,
      functionName: "getEntireDebtAndColl",
      args: [v.address],
    }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
  ]);
  const [debt, coll] = entire;
  const icr =
    Number(status) === 1 && debt > 0n
      ? (Number(coll) / 1e18) * priceUsd / (Number(debt) / 1e18)
      : Number(status) === 1
        ? NO_DEBT
        : Number.NaN;
  return {
    id: v.id,
    address: v.address,
    status: Number(status),
    debtEusdWei: debt,
    collWei: coll,
    icr,
  };
}

export async function readLiquityVictimTroves(
  ctx: SimContext,
  victims: LiquityVictim[],
  priceUsd: number,
): Promise<LiquityVictimTrove[]> {
  return Promise.all(victims.map((v) => readOne(ctx, v, priceUsd)));
}

// Open one Trove per victim at ICR₀, through the same builder an agent's `liquityOpenTrove`
// goes through (hints, WETH unwrap, native-ETH value), then read it back and refuse a cohort that
// did not land where it was asked to. Returns what was read.
export type LiquityVictimCohort = {
  troves: LiquityVictimTrove[];
  mcr: number;
  ccr: number;
  // The system TCR once the cohort is in, at the opening price.
  tcr: number;
};

export async function openLiquityVictimTroves(
  ctx: SimContext,
  victims: LiquityVictim[],
  opts: { icr0: number; collWei: bigint; priceUsd: number; toleranceBps?: number },
): Promise<LiquityVictimCohort> {
  const d = LIQUITY;
  if (!d) throw new Error("liquity victims require a Liquity deployment (local deploy only, issue #39)");
  const { publicClient, walletClient, chain } = ctx;
  const [rateWad, gasComp, mcrWad, ccrWad] = (await Promise.all([
    publicClient.readContract({
      address: d.troveManager,
      abi: troveManagerAbi,
      functionName: "getBorrowingRateWithDecay",
    }),
    publicClient.readContract({
      address: d.troveManager,
      abi: troveManagerAbi,
      functionName: "LUSD_GAS_COMPENSATION",
    }),
    publicClient.readContract({
      address: d.troveManager,
      abi: troveManagerAbi,
      functionName: "MCR",
    }),
    publicClient.readContract({
      address: d.troveManager,
      abi: troveManagerAbi,
      functionName: "CCR",
    }),
  ])) as [bigint, bigint, bigint, bigint];
  const mcr = Number(mcrWad) / 1e18;
  const ccr = Number(ccrWad) / 1e18;
  if (opts.icr0 <= mcr)
    throw new Error(
      `stress.liquityVictimIcr = ${opts.icr0} is at or below MCR ${mcr}: the Trove could not be opened ` +
        "(and a cohort born liquidatable measures nothing). Raise it, and keep the crash magnitude above 1 - MCR/ICR (issue #107)",
    );
  const priceWad = BigInt(Math.round(opts.priceUsd * 1e6)) * (WAD / 1_000_000n);
  const debt = victimDebtForIcr({
    collWei: opts.collWei,
    priceWad,
    icr0: opts.icr0,
    borrowingRateWad: rateWad,
    gasCompensationWei: gasComp,
  });
  const out: LiquityVictimTrove[] = [];
  for (const v of victims) {
    const txs = await liquityAdapter.buildTxs(
      ctx,
      v.address,
      {
        type: "liquityOpenTrove",
        collateralWethWei: opts.collWei.toString(),
        debtEusdWei: debt.toString(),
        // Generous: the fee is whatever the decayed baseRate says at open time, and a cohort that
        // fails to open on a fee cap is a regime that silently lost its victims.
        maxFeeBps: 500,
      },
      // The open path reads what it needs from the chain; no observation is involved.
      undefined,
    );
    for (const tx of txs) {
      await sendAndMine(publicClient, walletClient, chain, v.privateKey, {
        to: tx.to as Address,
        data: tx.data as Hex,
        ...(tx.value !== undefined ? { value: BigInt(tx.value) } : {}),
      });
    }
    const t = await readOne(ctx, v, opts.priceUsd);
    const tol = (opts.toleranceBps ?? 100) / 10_000;
    if (t.status !== 1 || !(Math.abs(t.icr / opts.icr0 - 1) <= tol))
      throw new Error(
        `liquity victim ${v.id}: Trove did not land at ICR ${opts.icr0} (status ${t.status}, ` +
          `ICR ${Number.isFinite(t.icr) ? t.icr.toFixed(4) : "n/a"}, debt ${t.debtEusdWei}, coll ${t.collWei}). ` +
          "The open reverted (fee cap, MIN_NET_DEBT, Recovery Mode) or the price moved between sizing and opening (issue #107)",
      );
    out.push(t);
  }
  // An epoch must not open in Recovery Mode: every ICR floor moves to the TCR and the liquidation
  // rules change under everyone (liquity_setup refuses the same thing for the venue as deployed).
  const tcrWad = (await publicClient.readContract({
    address: d.troveManager,
    abi: troveManagerAbi,
    functionName: "getTCR",
    args: [priceWad],
  })) as bigint;
  const tcr = Number(tcrWad) / 1e18;
  if (tcr < ccr)
    throw new Error(
      `the Liquity victim cohort puts the system TCR at ${tcr.toFixed(3)}, under CCR ${ccr}: the epoch ` +
        "would open in Recovery Mode. Fewer or smaller victims, or a higher ICR (issue #107; Recovery Mode is #59)",
    );
  return { troves: out, mcr, ccr, tcr };
}

// The env name the cohort's addresses travel under, for symmetry with ERIS_LIQUIDATION_VICTIMS.
// The reference agents do not need it (they read `riskiestTrove` off the observation); it is
// there so a participant can tell the environment's Troves from other agents'.
export const LIQUITY_VICTIM_ENV = "ERIS_LIQUITY_VICTIMS";
