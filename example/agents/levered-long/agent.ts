/**
 * levered-long: borrows against its own inventory to hold more of the base than it was funded with.
 *
 * Every other agent in this repo trades a dislocation and goes flat. None of them borrow, which
 * leaves three things the scoring work (issue #56) has never been able to measure:
 *
 *   - ADR 0019 §2 records "a lucky leveraged week is rewarded" as the metric's known limitation.
 *     With no leveraged entry in any roster, nobody has seen how large that actually is. Now that a
 *     drift episode can be injected in either direction (`cexDrift`), both the lucky and the unlucky
 *     side are reachable.
 *   - G1 (the bankruptcy floor) and G2 (the scoring freeze) have never fired: every run so far
 *     reports `bankruptAtEpoch: null`. Rules that have never executed on real data are guesses.
 *   - G6 declines to add a leverage cap on the grounds that the protocols' own collateral limits are
 *     enough. That has not been tried by anything.
 *
 * The strategy itself is deliberately dumb -- it is a probe, not a contender. It is long the base and
 * nothing else, so it earns exactly the drift and pays exactly the funding, which is what makes it a
 * clean instrument for the questions above.
 *
 * Env:
 *   ERIS_LEVER_TARGET_HF   health factor to land on (default 1.8). Lower = more leverage.
 *   ERIS_LEVER_MIN_HF      deleverage below this (default target - 0.15, floored at 1.05).
 *   ERIS_LEVER_BASE        which base to be long (default WETH).
 */
import type {
  AaveObservation,
  AgentAction,
  AgentContext,
  AgentObservation,
  TokenSymbol,
} from "@eris/sdk";

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

const TARGET_HF = numberEnv("ERIS_LEVER_TARGET_HF", 1.8);
// A band, not a point: repaying the moment the ratio moves would trade every block against its own
// borrow. The floor of 1.05 is above Aave's liquidation threshold of 1.0 by enough to survive the
// one-block oracle lag every venue in this environment has.
const MIN_HF = numberEnv("ERIS_LEVER_MIN_HF", Math.max(1.05, TARGET_HF - 0.15));
const BASE = (process.env.ERIS_LEVER_BASE ?? "WETH") as TokenSymbol;
// Aave reports collateral and debt in USD with 8 decimals.
const BASE_UNIT = 1e8;
// Below this there is nothing worth a transaction, and acting anyway just burns gas on dust.
const DUST_USD = 25;

function health(aave: AaveObservation | undefined): {
  collateralUsd: number;
  debtUsd: number;
  hf: number;
  availableUsd: number;
} | null {
  if (!aave) return null;
  const collateralUsd = Number(aave.totalCollateralBase) / BASE_UNIT;
  const debtUsd = Number(aave.totalDebtBase) / BASE_UNIT;
  const availableUsd = Number(aave.availableBorrowsBase) / BASE_UNIT;
  // Aave returns uint256 max for a position with no debt; anything that large is "no constraint".
  const raw = Number(aave.healthFactor) / 1e18;
  const hf = Number.isFinite(raw) && raw < 1e6 ? raw : Number.POSITIVE_INFINITY;
  return { collateralUsd, debtUsd, hf, availableUsd };
}

export function decide(
  obs: AgentObservation,
  ctx?: AgentContext,
): AgentAction | null {
  const aave = obs.protocols.aave;
  const state = health(aave);
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  const log = (reason: string, extra: Record<string, unknown> = {}) =>
    ctx?.log({
      round: obs.round,
      reason,
      signals: {
        ...(state
          ? {
              ...(Number.isFinite(state.hf)
                ? { hf: Number(state.hf.toFixed(3)) }
                : {}),
              collateralUsd: Math.round(state.collateralUsd),
              debtUsd: Math.round(state.debtUsd),
            }
          : {}),
        ...extra,
      },
    });

  if (!state) {
    log("aave is not enabled in this run; nothing to lever against");
    return { type: "noop", reason: "no aave" };
  }

  const baseBalanceWei = BigInt(
    obs.baseBalances?.[BASE] ?? (BASE === "WETH" ? obs.balances.wethWei : "0"),
  );
  const usdcUnits = BigInt(obs.balances.usdcUnits);
  const basePriceUsd = obs.fairPricesUsd?.[BASE] ?? obs.fairPriceUsdcPerWeth;

  // 1. Deleverage first, ahead of everything else. A position that is late to repay does not get to
  //    choose what happens next -- the liquidator does.
  if (state.hf < MIN_HF && state.debtUsd > 0) {
    if (usdcUnits > 0n) {
      log(`hf ${state.hf.toFixed(3)} below ${MIN_HF}: repaying`);
      return {
        type: "aaveRepay",
        asset: "USDC",
        amount: "max",
        maxPriorityFeePerGasWei: fee,
      };
    }
    // No cash to repay with: sell the free base for some. If there is none of that either, the
    // position is already in the liquidator's hands and saying so is more useful than a silent noop.
    if (baseBalanceWei > 0n) {
      const cap = BigInt(obs.limits.maxWethInWei);
      const amountIn = baseBalanceWei < cap ? baseBalanceWei : cap;
      log(
        `hf ${state.hf.toFixed(3)} below ${MIN_HF}: selling ${BASE} to raise cash`,
      );
      return {
        type: "swap",
        tokenIn: BASE,
        base: BASE,
        amountIn: amountIn.toString(),
        slippageBps: 100,
        maxPriorityFeePerGasWei: fee,
      };
    }
    log(`hf ${state.hf.toFixed(3)} below ${MIN_HF} with nothing left to sell`);
    return { type: "noop", reason: "undercollateralised and out of assets" };
  }

  // 2. Put idle base to work as collateral. Held in the wallet it is the same exposure with none of
  //    the borrowing power, so there is no reason to leave it there.
  const reserveWei = BigInt(obs.limits.maxWethInWei); // one round's worth, kept for step 1's escape
  if (baseBalanceWei > reserveWei) {
    // Capped per round like every other action. Supplying the whole balance at once is rejected
    // outright rather than trimmed, so an agent that ignores the cap does nothing at all, forever --
    // which is exactly what this one did on its first run.
    const supplyCap = BigInt(obs.limits.maxAaveSupplyWethWei);
    const free = baseBalanceWei - reserveWei;
    const supplyWei = free < supplyCap ? free : supplyCap;
    log(`supplying ${BASE} as collateral`, { supplyWei: supplyWei.toString() });
    return {
      type: "aaveSupply",
      asset: BASE,
      amount: supplyWei.toString(),
      maxPriorityFeePerGasWei: fee,
    };
  }

  // 3. Borrow up to the target. Sized to *land* on it rather than to consume the headroom Aave
  //    reports: the headroom is an LTV limit while the health factor is a liquidation-threshold one,
  //    so spending the former overshoots the latter and the position then oscillates between
  //    borrowing and repaying (the LST carry agent learned this the expensive way).
  //
  //    The liquidation threshold is not in the observation, so it is inferred from the position
  //    itself: hf = collateral * lt / debt. Before there is any debt to infer from, a deliberately
  //    small first borrow opens one.
  if (state.hf > TARGET_HF && state.availableUsd > DUST_USD) {
    const impliedLt =
      state.debtUsd > 0 && Number.isFinite(state.hf)
        ? (state.hf * state.debtUsd) / state.collateralUsd
        : null;
    const targetDebtUsd =
      impliedLt !== null
        ? (state.collateralUsd * impliedLt) / TARGET_HF
        : state.debtUsd + Math.min(state.availableUsd * 0.25, 5_000);
    const borrowUsd = Math.min(
      targetDebtUsd - state.debtUsd,
      state.availableUsd,
    );
    if (borrowUsd > DUST_USD) {
      // The borrow has its own cap, separate from the swap cap used below.
      const capUnits = BigInt(obs.limits.maxAaveBorrowUsdcUnits);
      const wanted = BigInt(Math.floor(borrowUsd * 1e6));
      const amount = wanted < capUnits ? wanted : capUnits;
      log(`borrowing toward hf ${TARGET_HF}`, {
        borrowUsd: Math.round(borrowUsd),
        ...(impliedLt === null
          ? {}
          : { impliedLt: Number(impliedLt.toFixed(3)) }),
      });
      return {
        type: "aaveBorrow",
        asset: "USDC",
        amount: amount.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    }
  }

  // 4. Turn borrowed cash into exposure. This is the step that makes it a leveraged long rather than
  //    a loan nobody spent, and it feeds step 2 on the next round.
  if (usdcUnits > 0n && basePriceUsd > 0) {
    const capUnits = BigInt(obs.limits.maxUsdcInUnits);
    const amountIn = usdcUnits < capUnits ? usdcUnits : capUnits;
    if (Number(amountIn) / 1e6 > DUST_USD) {
      log(`buying ${BASE} with borrowed cash`, {
        amountInUsdc: Number(amountIn) / 1e6,
      });
      return {
        type: "swap",
        tokenIn: "USDC",
        base: BASE,
        amountIn: amountIn.toString(),
        slippageBps: 100,
        maxPriorityFeePerGasWei: fee,
      };
    }
  }

  log(
    `holding at hf ${Number.isFinite(state.hf) ? state.hf.toFixed(3) : "inf"}`,
  );
  return { type: "noop", reason: "at target" };
}
