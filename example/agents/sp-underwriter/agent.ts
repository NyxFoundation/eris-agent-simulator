/**
 * sp-underwriter: the Stability Pool side of the CDP venue (issue #39).
 *
 * A Stability Pool deposit is an underwriting position, not a yield position. It sits there doing
 * nothing until a Trove falls under 110%, and then it is *spent*: the pool burns your eUSD against
 * the liquidated debt and hands you the collateral that backed it. Because Liquity only liquidates
 * below MCR, that collateral is worth more than the debt it cancelled — the difference, minus the
 * price move you now carry, is the whole return.
 *
 * So there are three decisions, and they are not the same decision:
 *
 *   how much to deposit   the pool pays out in proportion to your share, so depth is the position.
 *                         But deposited eUSD cannot be spent on anything else, and a run with no
 *                         liquidations pays nothing at all.
 *   whether to liquidate  Liquity's liquidation is permissionless and pays the caller a gas
 *                         compensation plus 0.5% of the collateral. A depositor has a second reason
 *                         to call it: nothing pays out until somebody does.
 *   when to take the ETH  the gain accrues as collateral, which is a price bet the agent never
 *                         chose. Claiming and selling converts it back to the unit it is scored in.
 *
 * The agent buys its eUSD on the market rather than borrowing it, so it never has a Trove of its
 * own and never competes with itself: being liquidated while underwriting liquidations would be a
 * different (and much worse) strategy.
 */
import type {
  AgentAction,
  AgentContext,
  AgentObservation,
  LiquityObservation,
} from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";

// Share of the USDC book to convert into eUSD and underwrite with. Not all of it: a pool deposit is
// illiquid for as long as it is there, and the run may never liquidate anything.
const UNDERWRITE_BPS = Number(process.env.ERIS_SP_UNDERWRITE_BPS ?? "5000");

// Never buy eUSD above this premium. Underwriting at a premium means paying more than a dollar for
// a claim the protocol values at a dollar, which the liquidation discount then has to earn back.
const MAX_PREMIUM_BPS = Number(process.env.ERIS_SP_MAX_PREMIUM_BPS ?? "10");

// Liquidate anything whose ICR is under MCR by this margin. A Trove exactly at the line is a race
// against the next oracle write, and a liquidation that arrives after the price recovers reverts.
const LIQUIDATION_MARGIN = Number(process.env.ERIS_SP_LIQ_MARGIN ?? "0.005");

// Claim the ETH gain once it is worth more than this in USD -- below it, the gas and the AMM fee on
// the way back to USDC eat the gain.
const MIN_CLAIM_USD = Number(process.env.ERIS_SP_MIN_CLAIM_USD ?? "50");

const SLIPPAGE_BPS = Number(process.env.ERIS_SP_SLIPPAGE_BPS ?? "100");
const MIN_USDC_UNITS = 200n * 10n ** 6n;
const MIN_EUSD_WEI = 200n * 10n ** 18n;
const MIN_WETH_WEI = 10n ** 16n;

/// The native ETH the agent started with. The Stability Pool pays out in native ETH, so what is
/// tradable is the balance above the endowment that pays for gas.
let baselineEthWei: bigint | null = null;
let baselineWethWei: bigint | null = null;

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function fraction(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.max(0, Math.round(bps)))) / 10_000n;
}

export type UnderwriterDecision =
  | { kind: "liquidate"; borrower: string; icr: number }
  | { kind: "claim"; gainUsd: number }
  | { kind: "buy"; usdcIn: bigint }
  | { kind: "deposit"; amountEusdWei: bigint }
  | { kind: "wrap"; ethWei: bigint }
  | { kind: "unwind"; wethWei: bigint }
  | { kind: "hold"; reason: string };

/// The decision, separated from the observation plumbing so it can be reasoned about (and tested)
/// without a chain.
///
/// Liquidating comes first because it is the only branch with a deadline: a Trove under MCR is a
/// race, both against the price recovering and against every other agent watching the same list.
/// Everything else here can wait a block without costing anything.
export function decideUnderwriting(input: {
  liquity: LiquityObservation;
  usdcUnits: bigint;
  wethWei: bigint;
  ethWei: bigint;
  ethBaselineWei: bigint;
  wethBaselineWei: bigint;
  canSellEth: boolean;
}): UnderwriterDecision {
  const l = input.liquity;

  // 1. Somebody is under water. Nothing in the pool pays out until this call is made, and whoever
  //    makes it also takes the gas compensation.
  const riskiest = l.riskiestTrove;
  if (riskiest && riskiest.icr < l.mcr - LIQUIDATION_MARGIN) {
    return { kind: "liquidate", borrower: riskiest.owner, icr: riskiest.icr };
  }

  // 2. Convert what the last liquidation paid back into the unit this is scored in.
  if (input.canSellEth) {
    const sellable =
      input.wethWei > input.wethBaselineWei
        ? input.wethWei - input.wethBaselineWei
        : 0n;
    if (sellable >= MIN_WETH_WEI) {
      // Sold whole: there is no per-round swap cap to slice it against any more.
      return { kind: "unwind", wethWei: sellable };
    }
    const reserve =
      input.ethBaselineWei > BigInt(l.suggestedGasReserveWei)
        ? input.ethBaselineWei
        : BigInt(l.suggestedGasReserveWei);
    if (input.ethWei > reserve + MIN_WETH_WEI)
      return { kind: "wrap", ethWei: input.ethWei - reserve };
  }

  // 3. The gain accrues as collateral inside the pool, which is a price bet the agent never took.
  //    Withdrawing zero claims it without touching the deposit.
  const gainUsd = (Number(l.spEthGainWei) / 1e18) * l.priceUsd;
  if (gainUsd >= MIN_CLAIM_USD) return { kind: "claim", gainUsd };

  // 4. Build the position. eUSD first, then depth.
  const eusd = BigInt(l.eusdBalanceWei);
  if (eusd >= MIN_EUSD_WEI) return { kind: "deposit", amountEusdWei: eusd };

  const target = fraction(input.usdcUnits, UNDERWRITE_BPS);
  if (target >= MIN_USDC_UNITS && l.marketQuoted) {
    // discountBps is negative at a premium, so this is "not much above par".
    if (-l.discountBps > MAX_PREMIUM_BPS)
      return {
        kind: "hold",
        reason: `eUSD is ${(-l.discountBps).toFixed(1)}bps above par; underwriting at a premium means the liquidation discount has to earn it back first`,
      };
    if (target >= MIN_USDC_UNITS) return { kind: "buy", usdcIn: target };
  }

  return {
    kind: "hold",
    reason:
      `${(Number(l.spDepositEusdWei) / 1e18).toFixed(0)} eUSD underwriting ` +
      `${(Number(l.spShareBps) / 100).toFixed(1)}% of the pool; riskiest Trove at ICR ` +
      `${(riskiest?.icr ?? 0).toFixed(2)} against MCR ${l.mcr}`,
  };
}

export function decide(
  obs: AgentObservation,
  ctx?: AgentContext,
): AgentAction | Record<string, unknown> | null {
  const liquity = obs.protocols.liquity;
  if (!liquity) {
    return {
      type: "noop",
      reason: "the liquity venue is not enabled this run",
    };
  }
  const ethWei = BigInt(obs.balances.ethWei || "0");
  const wethWei = BigInt(obs.balances.wethWei || "0");
  if (baselineEthWei === null) baselineEthWei = ethWei;
  if (baselineWethWei === null) baselineWethWei = wethWei;

  const decision = decideUnderwriting({
    liquity,
    usdcUnits: BigInt(obs.balances.usdcUnits || "0"),
    wethWei,
    ethWei,
    ethBaselineWei: baselineEthWei,
    wethBaselineWei: baselineWethWei,
    canSellEth: obs.enabledProtocols.includes("uniswap"),
  });
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  ctx?.log({
    round: obs.round,
    reason: decision.kind === "hold" ? decision.reason : decision.kind,
    signals: {
      spDeposit: Number((Number(liquity.spDepositEusdWei) / 1e18).toFixed(0)),
      spShareBps: liquity.spShareBps,
      spEthGain: Number((Number(liquity.spEthGainWei) / 1e18).toFixed(4)),
      riskiestIcr: Number((liquity.riskiestTrove?.icr ?? 0).toFixed(3)),
      mcr: liquity.mcr,
      recoveryMode: liquity.recoveryMode ? 1 : 0,
    },
  });

  switch (decision.kind) {
    case "liquidate":
      return {
        type: "liquityLiquidate",
        borrowers: [decision.borrower],
        maxPriorityFeePerGasWei: fee,
      };
    case "claim":
      // Zero is the protocol's own idiom for "pay me the gain, leave the deposit".
      return {
        type: "liquityWithdrawFromSP",
        amountEusdWei: "0",
        maxPriorityFeePerGasWei: fee,
      };
    case "buy":
      return {
        type: "liquitySwapEusd",
        tokenIn: "USDC",
        amountIn: decision.usdcIn.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      };
    case "deposit":
      return {
        type: "liquityProvideToSP",
        amountEusdWei: decision.amountEusdWei.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "wrap":
      return {
        type: "rawTx",
        tx: {
          to: TOKENS.WETH.address,
          data: "0xd0e30db0", // WETH9.deposit()
          value: decision.ethWei.toString(),
        },
        maxPriorityFeePerGasWei: fee,
      };
    case "unwind":
      return {
        type: "swap",
        tokenIn: "WETH",
        amountIn: decision.wethWei.toString(),
        slippageBps: SLIPPAGE_BPS,
        maxPriorityFeePerGasWei: fee,
      };
    default:
      return { type: "noop", reason: decision.reason };
  }
}
