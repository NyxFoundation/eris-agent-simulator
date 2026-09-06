/**
 * peg-arb: buys a market-priced stable when it trades below a dollar, and sells it back as the peg
 * recovers (issue #27 (c)).
 *
 * This is the trade the second market-priced stable exists to make possible, and it is deliberately
 * a *different* trade from redemption-arb's. eUSD has a floor: a CDP will always exchange it for
 * $1 of collateral, so a discount is a claim you can enforce. A plain stable has no such thing --
 * only the belief that it is a dollar and the fact that the environment's dislocation is a window
 * rather than a permanent repricing. So the position is an opinion, and the risk is real: an agent
 * that buys at 0.985 and is still holding at the last block is marked at whatever the pool pays
 * then, not at par. Since issue #27 the scorer no longer pretends otherwise.
 *
 * The whole strategy is two thresholds and a size, because the point is to exercise the venue, not
 * to win with it:
 *
 *   below par by more than BUY_BPS   spend USDC to buy the stable
 *   above SELL_BPS of par            sell the stable back for USDC
 *
 * Both are read off `obs.balances.stables`, which since issue #27 carries each stable's balance and
 * what the market says it is worth -- `marketQuoted: false` means the price is par by assumption,
 * which is exactly the case where there is nothing to trade.
 */
import type { AgentAction, AgentContext, AgentObservation } from "@eris/sdk";

// A roster's `env` is a string map, so a typo silently becomes NaN and the comparison below is
// then false forever -- an agent that never trades, indistinguishable in the score from one that
// correctly sat out. Fail at startup instead, where the message is attached to the cause.
function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

// The discount at which buying is worth the round trip. The pool charges its fee on both legs and
// the exit price is not the entry price, so a few bps of dislocation is noise.
const BUY_BPS = numberEnv("ERIS_PEG_ARB_BUY_BPS", 40);
// Where to let go. Above par is a premium; waiting for one is waiting for the environment to
// overshoot, which the buy-back leg of the event does not promise.
const SELL_BPS = numberEnv("ERIS_PEG_ARB_SELL_BPS", 10);
// Fraction of the spendable dollar budget committed per buy, in bps. A single block's dislocation
// is not the deepest it will get, so this leaves room to keep buying into it.
const SIZE_BPS = BigInt(Math.round(numberEnv("ERIS_PEG_ARB_SIZE_BPS", 2500)));
// Which stable to trade. Unset = whichever quoted stable is furthest from par this block.
const TARGET = process.env.ERIS_PEG_ARB_STABLE ?? "";

// Dust floor, in dollars. Below this a leg is not worth a transaction: the gas eats it, and a
// balance of a few wei left over from an unwind would otherwise have the agent propose a swap every
// remaining block of the run for nothing.
const MIN_DOLLARS = 1n;
const MIN_USDC_UNITS = MIN_DOLLARS * 1_000_000n;
const SLIPPAGE_BPS = 100;

type StableView = {
  symbol: string;
  balance: bigint;
  decimals: number;
  discountBps: number;
};

// Every stable whose price came from a market this block. USDC is skipped: it is the numéraire and
// is a dollar by definition, so its "discount" is always exactly zero.
function quotedStables(obs: AgentObservation): StableView[] {
  const out: StableView[] = [];
  for (const [symbol, s] of Object.entries(obs.balances.stables ?? {})) {
    if (symbol === "USDC" || !s.marketQuoted) continue;
    if (TARGET && symbol !== TARGET) continue;
    // EUSD is reachable through stableSwap like any other market-priced stable, but its venue has
    // a better instrument for it: a redemption enforces par rather than hoping for it, which is
    // what `example/agents/redemption-arb/` trades. Leaving it here would have this agent take the
    // strictly worse side of the same dislocation.
    if (symbol === "EUSD") continue;
    out.push({
      symbol,
      balance: BigInt(s.balance),
      decimals: s.decimals,
      discountBps: (1 - s.priceUsdc) * 10_000,
    });
  }
  return out;
}

export function decide(
  obs: AgentObservation,
  ctx?: AgentContext,
): AgentAction | Record<string, unknown> | null {
  const stables = quotedStables(obs);
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  // Record why, every cycle. Sitting out is the correct move most of the time -- the pair is at par
  // until something moves it -- and without this a run where the agent correctly did nothing is
  // indistinguishable from one where it never saw the market at all.
  const widest = [...stables].sort((a, b) => b.discountBps - a.discountBps)[0];
  ctx?.log({
    round: obs.round,
    reason: widest
      ? `${widest.symbol} ${widest.discountBps.toFixed(1)}bps from par`
      : "no market-priced stable quoted this block",
    signals: Object.fromEntries(
      stables.map((s) => [
        `${s.symbol}DiscountBps`,
        Number(s.discountBps.toFixed(2)),
      ]),
    ),
  });
  if (stables.length === 0) return null;

  // Sell first. Holding through the end of the run is the one way this strategy loses money it
  // never had to lose, so unwinding takes priority over adding.
  const rich = stables
    .filter(
      (s) =>
        s.balance >= MIN_DOLLARS * 10n ** BigInt(s.decimals) &&
        s.discountBps <= SELL_BPS,
    )
    .sort((a, b) => a.discountBps - b.discountBps)[0];
  if (rich) {
    // Sell the whole holding of a stable that has come back above par. There is no cap to trim it
    // against, and this is the exit: leaving part of it behind is holding a position whose thesis
    // has already played out.
    const size = rich.balance;
    return {
      type: "stableSwap",
      stable: rich.symbol,
      tokenIn: rich.symbol,
      amountIn: size.toString(),
      slippageBps: SLIPPAGE_BPS,
      maxPriorityFeePerGasWei: fee,
    };
  }

  const cheap = stables
    .filter((s) => s.discountBps >= BUY_BPS)
    .sort((a, b) => b.discountBps - a.discountBps)[0];
  if (!cheap) return null;
  const usdc = BigInt(obs.balances.usdcUnits || "0");
  const size = (usdc * SIZE_BPS) / 10_000n;
  if (size < MIN_USDC_UNITS) return null;
  return {
    type: "stableSwap",
    stable: cheap.symbol,
    tokenIn: "USDC",
    amountIn: size.toString(),
    slippageBps: SLIPPAGE_BPS,
    maxPriorityFeePerGasWei: fee,
  };
}
