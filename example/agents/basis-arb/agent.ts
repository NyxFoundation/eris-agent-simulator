/**
 * basis-arb: trade one AMM leg against fair, and hedge the delta it creates on the GMX perp.
 *
 * Every other arbitrage agent here is two-legged *within the AMMs* (clean-arb buys the cheap venue
 * and sells the rich one in the same bundle) because a single leg leaves directional risk. That
 * shape pays a pool fee twice and needs a second venue to be dislocated the other way. This agent
 * takes the other route out: one AMM leg against the fair price, and the perp as the offsetting leg.
 *
 * What that buys, and what it costs (issue #30):
 *   + The perp marks at fair and the scorer values it at fair, so the hedge nets to zero delta in
 *     the score and the dislocation is booked on entry. There is no round trip to pay for and no
 *     convergence to wait for.
 *   - GMX cannot be bundled (it needs keeper execution), so the two legs cannot be atomic. The AMM
 *     leg lands first and the hedge follows a round later. Between them the position is naked.
 *     That is why the hedge is checked *before* looking for a new opportunity: an unhedged delta is
 *     a risk the agent is already carrying, and a new opportunity is one it merely might take.
 *
 * The funding leg of issue #30 is not implemented: the deployment leaves fundingFactor and
 * borrowingFactor at zero, so there is no funding to harvest and no carry to price. Holding the
 * cheap side costs nothing and earns nothing. When the environment models funding, it belongs on
 * top of the hedge sizing below rather than as a separate strategy.
 *
 * Baseline (what "delta-neutral" is measured against):
 *   The run hands every agent an inventory basket. That beta is not a position anyone chose, and
 *   the do-nothing baseline holds it too, so by default this agent leaves it alone and hedges only
 *   the delta its own trades created. Hedging the basket as well is a different strategy -- it is
 *   short the market relative to the field -- and it is reachable with ERIS_BASIS_HEDGE_INVENTORY.
 *
 * Env:
 *   ERIS_BASIS_EDGE_BPS          safety margin over the modelled cost (default 15)
 *   ERIS_BASIS_GMX_COST_BPS      GMX round trip (default 0 -- measured: no fee or impact factor)
 *   ERIS_BASIS_ORDER_COST_ETH    ETH kept per order after the execution-fee refund (default 0.0001)
 *   ERIS_BASIS_MIN_SIZE_BPS      floor on the budget fraction a leg takes (default 1000 = 10%)
 *   ERIS_BASIS_MAX_SIZE_BPS      ceiling on it (default 5000 = 50%)
 *   ERIS_BASIS_SIZE_GAIN         net edge -> size ramp (default 10000: 100bps net goes to the cap)
 *   ERIS_BASIS_CLOSE_BPS         close the pair once the exit price is this close to fair (10)
 *   ERIS_BASIS_DELAY_MULT        how much keeper-delay volatility to charge as cost (default 1)
 *   ERIS_BASIS_MIN_LEG_USD       floor on a leg's notional (default 250). Without it the sell leg
 *                                decays geometrically into a dust loop once the inventory drops
 *                                below the per-round cap
 *   ERIS_BASIS_HEDGE_TOL_USD     leave the hedge alone while the gap is under this (default 200)
 *   ERIS_BASIS_HEDGE_LEVERAGE    perp size / collateral (default 2). The perp is liquidated on its
 *                                own numbers -- GMX cannot see that the spot leg offsets it.
 *   ERIS_BASIS_HEDGE_INVENTORY   "1" = also hedge the funded basket, not just what was acquired
 */
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { marketViews, type MarketView } from "../lib/markets.js";

// Safety margin on top of the *measured* costs below, for what the cost model does not name.
const SAFETY_BPS = Number(process.env.ERIS_BASIS_EDGE_BPS ?? "15");
// The GMX round trip, in bps of notional. Read off the chain rather than assumed: the deployer
// writes no market config beyond the oracle, so POSITION_FEE_FACTOR, POSITION_IMPACT_FACTOR,
// FUNDING_FACTOR and BORROWING_FACTOR are all 0 in the DataStore. Opening and closing the perp
// costs nothing but the execution fee, which is priced separately because it is flat.
const GMX_ROUNDTRIP_BPS = Number(process.env.ERIS_BASIS_GMX_COST_BPS ?? "0");
// What one GMX order actually costs, in ETH. The order carries a 0.03 ETH execution fee, but
// GasUtils.payExecutionFee pays the keeper only its gas and refunds the remainder, so almost none
// of it is spent. Measured by differencing agents inside one run rather than assumed: an agent
// sending only AMM swaps burned 0.000406 ETH over 38 of them, and one sending 11 swaps plus 10 GMX
// orders burned 0.001023 -- both net of the 0.001306 every wallet pays to wrap its funded WETH.
// That leaves ~0.0000107 ETH per swap and ~0.00009 per order: 99.7% of the execution fee comes
// back. It is a flat cost, so it matters at small notionals and vanishes at large ones, which is
// why it belongs in the gate as bps of the leg rather than as a constant threshold.
const ORDER_COST_ETH = Number(
  process.env.ERIS_BASIS_ORDER_COST_ETH ?? "0.0001",
);
// Sizing ramp: how much of the budget a leg takes, scaled by how far the net edge clears cost.
const MIN_SIZE_BPS = Number(process.env.ERIS_BASIS_MIN_SIZE_BPS ?? "1000");
const MAX_SIZE_BPS = Number(process.env.ERIS_BASIS_MAX_SIZE_BPS ?? "5000");
// Net edge (as a fraction) that maps to MAX_SIZE_BPS. 0.01 = a 100bps net edge goes all in.
const SIZE_GAIN = Number(process.env.ERIS_BASIS_SIZE_GAIN ?? "10000");
// Close a pair once the dislocation it was opened on has come back inside this many bps of fair.
const CLOSE_BPS = Number(process.env.ERIS_BASIS_CLOSE_BPS ?? "10");
// How much of the keeper-delay volatility to charge as a cost.
//
// Issue #30 lists "expected keeper delay" among the costs to clear, and the estimator below returns
// one standard deviation of the fair price's move over the delay. But that move is symmetric: the
// hedge lands late in both directions, and a late long in a falling market helps as often as it
// hurts. Charging a full standard deviation every time is therefore a risk premium rather than an
// expected cost, and it is the term that decides whether a calm-regime dislocation (~39bps) clears
// the gate at all. 0 removes it; the roster carries a copy at 0 so the choice is measured.
const DELAY_MULT = Number(process.env.ERIS_BASIS_DELAY_MULT ?? "1");
const HEDGE_TOL_USD = Number(process.env.ERIS_BASIS_HEDGE_TOL_USD ?? "200");
const HEDGE_LEVERAGE = Math.max(
  1,
  Number(process.env.ERIS_BASIS_HEDGE_LEVERAGE ?? "2"),
);
const HEDGE_INVENTORY = process.env.ERIS_BASIS_HEDGE_INVENTORY === "1";
const LEG_SLIPPAGE_BPS = 120;
// Floor on an AMM leg, in USD of notional.
//
// Without one the sell leg decays geometrically: it sends a fixed fraction of
// min(inventory, per-round cap), so once the inventory drops below the cap every subsequent leg is
// that fraction of a shrinking remainder. Measured at ~0.023 USDC of notional twelve blocks in,
// still being sent every block -- a dust loop that pays gas, burns the round that the hedge or a
// real opportunity needed, and moves nothing.
const MIN_LEG_USD = Number(process.env.ERIS_BASIS_MIN_LEG_USD ?? "250");

// GMX carries USD amounts at 1e30.
const USD_1E30 = 1e30;

// WETH only for now. WBTC is a separate GMX market and needs the multi-market path in the
// observation (protocols.gmx.markets); adding it before the WETH leg is measured would mean
// reading two uncalibrated venues at once.
const BASE = "WETH";
const BASE_DECIMALS = 18;

/**
 * The inventory the run handed us, captured on the first decision.
 *
 * Stashed on globalThis rather than in a module-level variable on purpose: in improve mode the LLM
 * replaces this module mid-run (ADR 0018), and a module-level baseline would be re-captured from
 * whatever inventory the agent happened to be holding at that moment. The hedge target would reset
 * to zero and the agent would unwind a hedge it still needs.
 */
const BASELINE_KEY = "__erisBasisArbBaseline";

function baselineBaseWei(view: MarketView): bigint {
  if (HEDGE_INVENTORY) return 0n;
  const g = globalThis as unknown as Record<string, Record<string, string>>;
  const store = (g[BASELINE_KEY] ??= {});
  store[view.base] ??= view.baseBalanceWei;
  return BigInt(store[view.base] ?? "0");
}

// Signed perp exposure in USD: positive = long, negative = short. GMX keys a position by
// (market, collateral, isLong), so a long and a short can coexist; the observation surfaces one per
// market, which is why this agent never holds both sides at once (see hedgeAction).
function perpSignedUsd(obs: AgentObservation): number {
  const pos = obs.protocols?.gmx?.position;
  if (!pos) return 0;
  const size = Number(pos.sizeUsd) / USD_1E30;
  return pos.isLong ? size : -size;
}

/**
 * Hedge orders that have been sent but are not in the observation yet.
 *
 * The observation is a block behind and a GMX order only lands once the keeper executes it, so the
 * position an order creates is invisible for at least two rounds. Sizing the next hedge off the
 * observed position alone means re-sending the same order until it appears, overshooting, and then
 * unwinding -- measured at 23 increases and 22 decreases against 8 AMM legs, the same signature
 * lst-carry has on record for sizing off headroom instead of off a target.
 *
 * There is no delivery receipt to key this on: `decide` is told what to submit, never what landed.
 * So the entry is cleared either when the observed position moves (it arrived) or after a few
 * rounds (it did not, and continuing to subtract it would leave the agent permanently unhedged).
 * Kept on globalThis for the same reason as the baseline: improve swaps this module out mid-run.
 */
const PENDING_KEY = "__erisBasisArbPending";
const PENDING_TTL_ROUNDS = 3;

type Pending = { signedUsd: number; sinceRound: number; observedUsd: number };

function pendingSignedUsd(obs: AgentObservation, observedUsd: number): number {
  const g = globalThis as unknown as Record<string, Pending | undefined>;
  const p = g[PENDING_KEY];
  if (!p) return 0;
  const landed = Math.abs(observedUsd - p.observedUsd) > 1e-6;
  const expired = obs.round - p.sinceRound >= PENDING_TTL_ROUNDS;
  if (landed || expired) {
    g[PENDING_KEY] = undefined;
    return 0;
  }
  return p.signedUsd;
}

function rememberPending(
  obs: AgentObservation,
  signedUsd: number,
  observedUsd: number,
): void {
  const g = globalThis as unknown as Record<string, Pending | undefined>;
  g[PENDING_KEY] = { signedUsd, sinceRound: obs.round, observedUsd };
}

function minBI(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function usdTo1e30(usd: number): string {
  return BigInt(Math.max(0, Math.floor(usd * 1e6))).toString() + "0".repeat(24);
}

type Quote = {
  swapType: MarketView["venues"][number]["swapType"];
  buy: number; // USDC paid per base, fee and impact included
  sell: number; // USDC received per base, fee and impact included
};

/**
 * Funding carry on the side the hedge holds, in bps per block. Positive = the hedge is paid.
 *
 * Zero by construction today: the deployment leaves fundingFactor and borrowingFactor at 0, and
 * GmxObservation carries no funding or open-interest fields, so there is nothing to read. This is
 * the seam issue #30 asks for -- the one place to change when the environment models funding. It
 * feeds the cost gate, so a carry that pays the hedge lowers the edge needed to open a pair and one
 * that charges it raises the bar, which is what an FR signal has to do to be worth anything.
 */
function fundingCarryBpsPerBlock(): number {
  return 0;
}

/**
 * What it costs to run this pair, in bps of the leg's notional, beyond the AMM quote.
 *
 * The AMM fee and impact are already inside `quoteOf` (it returns executable prices), so adding
 * them here would double count. What is left is the perp side and the delay:
 *
 *   - the GMX round trip (measured 0 -- no fee factor, no impact factor)
 *   - the execution fee, flat per order, so its bps depend on how big the leg is
 *   - the keeper delay: the hedge lands about two blocks after the AMM leg, and the fair price
 *     moves in between. Estimated from the run's own recent fair prices rather than assumed, so a
 *     quiet regime does not pay a volatile regime's premium
 *   - funding over the blocks the pair is expected to be held (0 today, see above)
 */
function costBps(
  obs: AgentObservation,
  notionalUsd: number,
  fair: number,
): number {
  const execBps =
    notionalUsd > 0 ? ((ORDER_COST_ETH * fair) / notionalUsd) * 10_000 : 0;
  const delayBps = keeperDelayBps(obs) * DELAY_MULT;
  const carryBps = fundingCarryBpsPerBlock() * HEDGE_DELAY_BLOCKS;
  return GMX_ROUNDTRIP_BPS + execBps + delayBps - carryBps + SAFETY_BPS;
}

// The hedge lands a block after the observation and a block after the keeper runs.
const HEDGE_DELAY_BLOCKS = 2;

// Expected adverse move of the fair price over the hedge delay, in bps: the per-block standard
// deviation of recent fair prices scaled by sqrt(delay). obs.history is the run's own record, so
// this tracks the regime instead of carrying a constant tuned on one of them.
function keeperDelayBps(obs: AgentObservation): number {
  const h = obs.history;
  if (!h || h.length < 3) return 0;
  const recent = h.slice(-24);
  const rets: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const a = recent[i - 1].fairPriceUsdcPerWeth;
    const b = recent[i].fairPriceUsdcPerWeth;
    if (a > 0 && b > 0) rets.push(b / a - 1);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr =
    rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(HEDGE_DELAY_BLOCKS) * 10_000;
}

// How much of the budget to commit, scaled by how far the net edge clears cost. A flat fraction
// spends the same on a 20bps dislocation as on a 400bps one, which is the sizing issue #30 asks to
// avoid ("size by basis magnitude vs cost").
function sizeBpsFor(netEdge: number): bigint {
  const scaled = Math.floor(netEdge * SIZE_GAIN);
  return BigInt(Math.min(MAX_SIZE_BPS, Math.max(MIN_SIZE_BPS, scaled)));
}

// balancer/curve carry a two-sided executable quote; uniswap does not, so derive one from its mid
// and pool fee. Trading off a mid that ignores the fee is what made phantom spreads look
// profitable before (the WBTC bleed), so never fall back to the raw mid.
function quoteOf(v: MarketView["venues"][number]): Quote {
  const edge = v.feeBps / 10_000;
  return {
    swapType: v.swapType,
    buy: v.buyPrice ?? v.price * (1 + edge),
    sell: v.sellPrice ?? v.price * (1 - edge),
  };
}

export function decide(
  obs: AgentObservation,
): AgentAction | Record<string, unknown> | null {
  if (!obs.protocols?.gmx)
    return { type: "noop", reason: "gmx venue not enabled in this run" };

  const view = marketViews(obs).find((v) => v.base === BASE);
  if (!view || view.venues.length === 0)
    return { type: "noop", reason: `no ${BASE} venue quotes` };
  if (!(view.fair > 0)) return { type: "noop", reason: "no fair price" };

  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // ---- the risk leg first: is the delta we already carry hedged? --------------------------
  const acquiredWei = BigInt(view.baseBalanceWei) - baselineBaseWei(view);
  const acquiredBase = Number(acquiredWei) / 10 ** BASE_DECIMALS;
  // To sit flat against the baseline the perp has to carry the opposite sign of what we acquired.
  const targetSignedUsd = -acquiredBase * view.fair;
  const observedSignedUsd = perpSignedUsd(obs);
  // What the perp will be once the orders already in flight execute. Sizing off the observed
  // position alone double-counts every gap for as long as the order is invisible.
  const currentSignedUsd =
    observedSignedUsd + pendingSignedUsd(obs, observedSignedUsd);
  const gapUsd = targetSignedUsd - currentSignedUsd;

  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const usdcCap = minBI(usdcBal, BigInt(obs.limits.maxUsdcInUnits));
  const baseBal = BigInt(view.baseBalanceWei || "0");
  const maxBaseIn = BigInt(view.maxSwapInBaseWei || "0");
  const baseCap = maxBaseIn > 0n ? minBI(baseBal, maxBaseIn) : baseBal;

  if (Math.abs(gapUsd) > HEDGE_TOL_USD) {
    const action = hedgeAction(obs, currentSignedUsd, gapUsd, fee);
    if (action) {
      rememberPending(obs, hedgeDeltaUsd(action), observedSignedUsd);
      return action;
    }
    // The hedge is wanted and cannot be sent -- the collateral it needs is not there. Waiting does
    // not help: nothing returns USDC on its own, so the gap would sit open for the rest of the run
    // (measured at 322-486 USD unhedged for twelve consecutive blocks, every one of them a noop).
    // Close it on the spot side instead by selling back what was acquired, which shrinks the target
    // and returns the USDC at the same time. Only reachable with acquired base in hand; short of
    // the baseline the repair would be a buy, and USDC is exactly what is missing.
    if (acquiredBase > 0 && baseCap > 0n) {
      const unwind = unwindLeg(view, acquiredWei, baseCap, fee);
      if (unwind) return unwind;
    }
    return {
      type: "noop",
      reason: `hedge gap ${gapUsd.toFixed(0)} USD unaffordable and no spot unwind available`,
    };
  }

  // A hedge is on its way but not visible yet. Opening another leg now stacks delta behind an
  // order that has not landed, which is the exposure this strategy exists to avoid.
  if (pendingSignedUsd(obs, observedSignedUsd) !== 0)
    return { type: "noop", reason: "hedge order in flight; not adding delta" };

  // ---- close a pair whose dislocation has come back ---------------------------------------
  // Issue #30 asks for this explicitly. Note that it does not realize the profit: the scorer marks
  // the spot leg and the perp at the same fair price, so the dislocation was booked when the pair
  // was opened, and closing pays a second pool fee to release the inventory rather than to earn.
  // What it buys is capacity -- budget and per-round caps back for the next dislocation.
  const closing = closeLeg(obs, view, acquiredWei, acquiredBase, usdcCap, fee);
  if (closing) return closing;

  // ---- the opportunity leg: one AMM leg against fair ---------------------------------------

  let best: { edgeBps: number; action: Record<string, unknown> } | null = null;

  for (const v of view.venues) {
    const q = quoteOf(v);

    // Buy the base where it is cheap against fair; the hedge that follows will short it back out.
    if (q.buy > 0 && usdcSpendable(usdcCap) > 0n) {
      const edgeBps = (1 - q.buy / view.fair) * 10_000;
      const budget = usdcSpendable(usdcCap);
      // Size against cost at the budget's own scale, then re-check the gate at the size actually
      // chosen -- the execution fee is flat, so a leg's cost in bps is not known until its size is.
      const probeUsd = Number(budget) / 1e6;
      const netEdge =
        edgeBps / 10_000 - costBps(obs, probeUsd, view.fair) / 10_000;
      const amountIn = (budget * sizeBpsFor(netEdge)) / 10_000n;
      const legUsd = Number(amountIn) / 1e6;
      const clears = edgeBps > costBps(obs, legUsd, view.fair);
      // USDC is 6 decimals, so the notional floor is a direct comparison.
      const bigEnough = amountIn >= BigInt(Math.floor(MIN_LEG_USD * 1e6));
      if (clears && bigEnough && (!best || edgeBps > best.edgeBps))
        best = {
          edgeBps,
          action: {
            type: q.swapType,
            tokenIn: "USDC",
            amountIn: amountIn.toString(),
            slippageBps: LEG_SLIPPAGE_BPS,
            maxPriorityFeePerGasWei: fee,
          },
        };
    }

    // Sell it where it is rich. This spends funded inventory, so the hedge goes the other way and
    // the agent still ends up flat against the baseline.
    if (baseCap > 0n) {
      const edgeBps = (q.sell / view.fair - 1) * 10_000;
      const capUsd = (Number(baseCap) / 10 ** BASE_DECIMALS) * view.fair;
      const netEdge =
        edgeBps / 10_000 - costBps(obs, capUsd, view.fair) / 10_000;
      const amountIn = (baseCap * sizeBpsFor(netEdge)) / 10_000n;
      const notionalUsd = (Number(amountIn) / 10 ** BASE_DECIMALS) * view.fair;
      const clears = edgeBps > costBps(obs, notionalUsd, view.fair);
      if (
        clears &&
        notionalUsd >= MIN_LEG_USD &&
        (!best || edgeBps > best.edgeBps)
      )
        best = {
          edgeBps,
          action: {
            type: q.swapType,
            tokenIn: BASE,
            amountIn: amountIn.toString(),
            slippageBps: LEG_SLIPPAGE_BPS,
            maxPriorityFeePerGasWei: fee,
          },
        };
    }
  }

  if (!best)
    return {
      type: "noop",
      reason: `no venue clears cost (~${costBps(obs, 1000, view.fair).toFixed(0)}bps at $1k) vs fair ${view.fair.toFixed(2)}`,
    };
  return best.action;
}

/**
 * Unwind a pair whose dislocation has closed (issue #30's "close on convergence").
 *
 * The side to exit is written on the inventory: acquired > 0 means the pair was opened on a
 * discount and the exit is a sell; acquired < 0 means it was opened on a premium and the exit is a
 * buy. Either way the trigger is the same -- the executable exit price has come back inside
 * CLOSE_BPS of fair, so the reason the position was opened no longer exists.
 *
 * Only the spot leg is sent here. The perp follows on the next round through the ordinary hedge
 * path, because the hedge target is derived from the inventory and this moves it.
 */
function closeLeg(
  obs: AgentObservation,
  view: MarketView,
  acquiredWei: bigint,
  acquiredBase: number,
  usdcCap: bigint,
  fee: string,
): Record<string, unknown> | null {
  if (acquiredBase === 0) return null;
  const near = CLOSE_BPS / 10_000;

  if (acquiredWei > 0n) {
    // Opened on a discount. Exit by selling into whichever venue pays most.
    let bestV = view.venues[0];
    for (const v of view.venues)
      if (quoteOf(v).sell > quoteOf(bestV).sell) bestV = v;
    const q = quoteOf(bestV);
    if (q.sell < view.fair * (1 - near)) return null; // still dislocated: hold the pair
    const maxIn = BigInt(view.maxSwapInBaseWei || "0");
    const amountIn = maxIn > 0n ? minBI(acquiredWei, maxIn) : acquiredWei;
    const notionalUsd = (Number(amountIn) / 10 ** BASE_DECIMALS) * view.fair;
    if (notionalUsd < MIN_LEG_USD) return null;
    return {
      type: q.swapType,
      tokenIn: BASE,
      amountIn: amountIn.toString(),
      slippageBps: LEG_SLIPPAGE_BPS,
      maxPriorityFeePerGasWei: fee,
    };
  }

  // Opened on a premium (the funded inventory was sold). Exit by buying it back.
  let bestV = view.venues[0];
  for (const v of view.venues)
    if (quoteOf(v).buy < quoteOf(bestV).buy) bestV = v;
  const q = quoteOf(bestV);
  if (q.buy > view.fair * (1 + near)) return null;
  // USDC needed to buy back the shortfall at the price this venue actually charges.
  const wantUsdc = BigInt(Math.floor(-acquiredBase * q.buy * 1e6));
  const amountIn = minBI(wantUsdc, usdcCap);
  if (amountIn < BigInt(Math.floor(MIN_LEG_USD * 1e6))) return null;
  return {
    type: q.swapType,
    tokenIn: "USDC",
    amountIn: amountIn.toString(),
    slippageBps: LEG_SLIPPAGE_BPS,
    maxPriorityFeePerGasWei: fee,
  };
}

// Sell acquired base back into the best venue to shrink the hedge target itself. This is the risk
// exit, not an opportunity: it fires when the perp cannot be funded, so it takes the best available
// price rather than waiting for one past the edge threshold. Capped at what was acquired, so it
// never eats into the funded basket that the baseline also holds.
function unwindLeg(
  view: MarketView,
  acquiredWei: bigint,
  baseCap: bigint,
  fee: string,
): Record<string, unknown> | null {
  let bestVenue = view.venues[0];
  for (const v of view.venues)
    if (quoteOf(v).sell > quoteOf(bestVenue).sell) bestVenue = v;
  const amountIn = minBI(acquiredWei, baseCap);
  const notionalUsd = (Number(amountIn) / 10 ** BASE_DECIMALS) * view.fair;
  if (notionalUsd < MIN_LEG_USD) return null;
  return {
    type: quoteOf(bestVenue).swapType,
    tokenIn: BASE,
    amountIn: amountIn.toString(),
    slippageBps: LEG_SLIPPAGE_BPS,
    maxPriorityFeePerGasWei: fee,
  };
}

// The signed exposure a submitted hedge order will add once it executes. Derived from the order
// rather than from the intended gap so that a size the limits clipped is recorded at what was
// actually sent.
function hedgeDeltaUsd(action: Record<string, unknown>): number {
  const size = Number(action.sizeDeltaUsd) / USD_1E30;
  const isLong = action.isLong === true;
  // A decrease removes exposure from the side it names; an increase adds it.
  const sign = action.type === "gmxDecrease" ? -1 : 1;
  return sign * (isLong ? size : -size);
}

// USDC that can be spent on an AMM leg while still leaving collateral for the hedge it will need.
// Spending the whole balance and then finding the hedge unaffordable is how a "delta-neutral"
// strategy ends up simply long.
function usdcSpendable(usdcCap: bigint): bigint {
  const l = BigInt(Math.round(HEDGE_LEVERAGE * 100));
  return (usdcCap * l) / (l + 100n);
}

function hedgeAction(
  obs: AgentObservation,
  currentSignedUsd: number,
  gapUsd: number,
  fee: string,
): Record<string, unknown> | null {
  const maxSizeUsd = Number(obs.limits.maxGmxSizeUsd) / USD_1E30;
  const holdingLong = currentSignedUsd > 0;
  const holdingSize = Math.abs(currentSignedUsd);

  // Opposite signs: close what is there before opening the other side, so the account never carries
  // a long and a short in the same market (the observation surfaces one position per market, and an
  // agent that cannot see half its book cannot hedge).
  const wantSigned = currentSignedUsd + gapUsd;
  const flipping =
    holdingSize > 0 && Math.sign(wantSigned) === -Math.sign(currentSignedUsd);
  const reducing = holdingSize > 0 && Math.abs(wantSigned) < holdingSize;

  if (flipping || reducing) {
    // Clip first, then derive everything from the clipped size. Flipping wants the whole position
    // closed, but maxGmxSizeUsd caps one order, so a position larger than the cap closes in parts --
    // and a collateral fraction computed from the intended size would withdraw 100% of the
    // collateral against a partial close, leaving the remainder of the position uncollateralized.
    const sizeUsd = Math.min(
      flipping ? holdingSize : Math.min(holdingSize, Math.abs(gapUsd)),
      maxSizeUsd,
    );
    if (sizeUsd <= 0) return null;
    // Take collateral back in proportion to the size being closed. Leaving it in ratchets USDC into
    // the position -- every increase adds collateral and no decrease ever returns it -- and the
    // balance that funds the AMM legs drains into a hedge that does not need it. Measured at
    // $18.2k of collateral behind a $6.8k position, with the AMM leg starved down to 8 trades
    // against the 44 the same strategy managed with the hedge switched off.
    const pos = obs.protocols?.gmx?.position;
    const collateralUnits = BigInt(pos?.collateralAmount ?? "0");
    const frac = Math.min(1, sizeUsd / holdingSize);
    const collateralDelta =
      (collateralUnits * BigInt(Math.round(frac * 10_000))) / 10_000n;
    return {
      type: "gmxDecrease",
      isLong: holdingLong,
      base: BASE,
      collateral: "USDC",
      collateralDeltaAmount: collateralDelta.toString(),
      sizeDeltaUsd: usdTo1e30(sizeUsd),
      maxPriorityFeePerGasWei: fee,
    };
  }

  // Growing the position (or opening it).
  const sizeUsd = Math.min(Math.abs(gapUsd), maxSizeUsd);
  if (sizeUsd <= 0) return null;
  const collateralUsdc = BigInt(Math.floor((sizeUsd / HEDGE_LEVERAGE) * 1e6));
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  if (collateralUsdc <= 0n || collateralUsdc > usdcBal) return null;
  return {
    type: "gmxIncrease",
    isLong: wantSigned > 0,
    base: BASE,
    collateral: "USDC",
    collateralAmount: collateralUsdc.toString(),
    sizeDeltaUsd: usdTo1e30(sizeUsd),
    maxPriorityFeePerGasWei: fee,
  };
}
