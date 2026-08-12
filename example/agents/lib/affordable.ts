// Sizing a swap you can actually pay for.
//
// Every bundled arbitrage agent used to pick its direction purely from the price gap and its size
// purely from `obs.limits`, with no reference to what the wallet held. Under the competition's
// USDC-only funding (`funding.wethWei: "0"`, so that nobody starts exposed to price drift) that
// meant an agent seeing a rich pool proposed selling WETH it did not have. The runtime rejected the
// action, the agent proposed it again the next block, and the run ended with the agent having never
// traded -- measured at 359 rejections out of 359 decisions for venue-arb in `calm`, and clean-arb,
// stat-arb and adaptive-arb reporting exactly 0.00 PnL for the same reason (issue #54).
//
// Two rules come out of that, and both belong here rather than in each agent:
//
//   1. Never propose a leg you cannot fund. A rejected action is indistinguishable in the score from
//      a strategy that chose not to trade, so the failure is silent.
//   2. When there is a choice of venue, choose among the ones you can fund. An agent holding only
//      USDC can still arbitrage -- it buys the cheap venue rather than selling the rich one.
import type { AgentObservation } from "@eris/sdk";

// Dust floor. Below this a leg is not worth a transaction: the gas and the fee eat it, and the
// swap may not even clear the venue's minimum.
const MIN_USDC_UNITS = 1_000_000n; // 1 USDC (6 decimals)
const MIN_WETH_WEI = 1_000_000_000_000_000n; // 0.001 WETH

export function minimumFor(tokenIn: string): bigint {
  return tokenIn === "USDC" ? MIN_USDC_UNITS : MIN_WETH_WEI;
}

// What the wallet holds of the token a swap would spend. Non-WETH bases come from balances.bases
// when the run has them (ADR 0013); stables other than USDC come from balances.stables, which since
// issue #27 keeps them apart instead of summing them into usdcUnits. An unknown symbol reads as
// zero, which is the safe direction -- it makes the agent skip rather than propose something
// unfundable.
export function balanceOf(obs: AgentObservation, tokenIn: string): bigint {
  if (tokenIn === "USDC") return BigInt(obs.balances.usdcUnits);
  if (tokenIn === "WETH") return BigInt(obs.balances.wethWei);
  const stable = obs.balances.stables?.[tokenIn];
  if (stable) return BigInt(stable.balance);
  const bases = (obs.balances as unknown as { bases?: Record<string, string> })
    .bases;
  const raw = bases?.[tokenIn];
  return raw === undefined ? 0n : BigInt(raw);
}

// The per-round rule cap for this token.
export function limitFor(obs: AgentObservation, tokenIn: string): bigint {
  if (tokenIn === "USDC") return BigInt(obs.limits.maxUsdcInUnits);
  if (tokenIn === "WETH") return BigInt(obs.limits.maxWethInWei);
  const perBase = (
    obs.limits as unknown as { maxBaseInUnits?: Record<string, string> }
  ).maxBaseInUnits;
  const raw = perBase?.[tokenIn];
  return raw === undefined ? 0n : BigInt(raw);
}

// The amount actually spendable: the smaller of what the rules allow and what the wallet holds.
// Returns 0n when the leg is not worth doing, which callers should treat as "pick another leg or
// do nothing" -- never as "send it anyway and let the runtime reject it".
export function affordable(
  obs: AgentObservation,
  tokenIn: string,
  desired: bigint,
): bigint {
  const capped =
    desired < limitFor(obs, tokenIn) ? desired : limitFor(obs, tokenIn);
  const held = balanceOf(obs, tokenIn);
  const spendable = capped < held ? capped : held;
  return spendable >= minimumFor(tokenIn) ? spendable : 0n;
}

export function canFund(obs: AgentObservation, tokenIn: string): boolean {
  return balanceOf(obs, tokenIn) >= minimumFor(tokenIn);
}
