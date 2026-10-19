/**
 * noah: fair-anchored executable arbitrage around the starting basket.
 *
 * The score (ASCON rules §4.4.1) is a per-epoch z-score of P = V_K - V_0, and base balances are
 * marked at the reference (fair) price. So a fill whose executable price beats fair is profit
 * booked the moment it lands, and the starting basket (§4.2: 25k USDC + 8 WETH + 0.4 WBTC), which
 * every participant holds, is the neutral position -- drifting away from it is a bet against the
 * field. The strategy is therefore one rule, applied per base and venue:
 *
 *   trade only when the quote AT THE ACTUAL SIZE (quote.ts: QuoterV2 / querySwap / get_dy) clears
 *   fair by a margin, and size to the profit-maximising rung of a size ladder.
 *
 * The margin depends on direction. Moving *away* from the basket needs OPEN_EDGE_BPS (it takes on
 * relative beta and pays for fair being a block stale); moving *back* toward it needs only
 * RESTORE_EDGE_BPS. In a calm market that leaves the agent idle (measured on calm#101: the previous
 * mid-price/z-score version lost 170-430 USDC of alpha against a do-nothing baseline). In a crash or
 * spike (§3.2 regimes 6/8: a 15-22% fair gap while the pools still quote the old price) the same rule
 * sells into or buys out of the stale pools at size, bids hard for inclusion, and buys the basket
 * back once pools trade through fair. In the last CLOSE_OUT_BLOCKS of an epoch only restoring trades
 * are allowed, so the epoch ends near the basket.
 *
 * Every branch logs a reason and signals (issue #101). Out of scope here: GMX, Aave, LST and the
 * regime 7/11 pools -- quote.ts only reads uniswap/balancer/curve markets. Liquity (eUSD) is a
 * second, independent candidate source (liquity.ts, ported from example/agents/redemption-arb):
 * finishing a redemption already in flight (redeem/sell/wrap/unwind) always takes priority over a
 * fresh trade, since holding eUSD or ETH across blocks while chasing an AMM edge is a price bet
 * nobody chose to take; a fresh eUSD buy is ranked against the AMM candidates on the same
 * profitUsdc basis and the better of the two is taken (never both in the same block).
 *
 * JP: fair 基準・実サイズ見積もりの裁定。評価は fair 建てなので「実サイズの約定価格が fair を
 * 上回る（下回る）」分はその場で P に確定する。初期バスケットが中立なので、バスケットから離れる取引は
 * 高い閾値（OPEN）、戻す取引は低い閾値（RESTORE）。calm では何もせず、crash/spike では古い価格の
 * プールに実サイズで当て、強く入札する。エポック終盤は戻す取引だけ。Liquity(eUSD)は独立した
 * もう一つの候補源（liquity.ts）: 前回までの償還の後始末（redeem/sell/wrap/unwind）は常に最優先、
 * 新規のeUSD購入はAMM候補とprofitUsdcで比較して良い方だけを採る。
 */
import type { AgentAction, AgentContext, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import { marketViews, type AgentVenue, type MarketView } from "../lib/markets.js";
import { decideLiquity, LIQUITY_PARAMS, type LiquityDecision } from "./liquity.js";
import { quoteOut, type Side, type Venue } from "./quote.js";

// ---- tunables (one place, so a revision can change them as literals) ----
const PARAMS = {
  openEdgeBps: Number(process.env.NOAH_OPEN_EDGE_BPS ?? "40"), // min avg-fill edge vs fair, away from basket
  restoreEdgeBps: Number(process.env.NOAH_RESTORE_EDGE_BPS ?? "0"), // min avg-fill edge vs fair, back toward basket
  minProfitUsdc: Number(process.env.NOAH_MIN_PROFIT_USDC ?? "3"), // below this the gas and the stale fair eat it
  maxDevFrac: 1.0, // inventory may range over baseline x [1 - maxDevFrac, 1 + maxDevFrac]
  ladder: [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1.0], // fractions of the available room, quoted in order
  maxLegs: 4,
  slipFracOfEdge: 0.5, // slippage bound = this share of the quoted edge...
  minSlipBps: 10,
  maxSlipBps: 300, // ...clamped to this band
  ceilFraction: Number(process.env.NOAH_CEIL_FRACTION ?? "0.5"), // max share of profit bid as priority fee
  bigProfitUsdc: 100, // at or above this, bid the full ceiling: crash/spike edges go to the highest bid
  gasBudgetEth: 0.5, // of the 1 ETH gas stipend (rules §4.2); ETH is marked into V too
  closeOutBlocks: 30,
};

const GAS_PER_LEG = 200_000n;
const ONE_GWEI = 1_000_000_000n;

for (const [k, v] of Object.entries(PARAMS)) {
  if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) {
    process.stderr.write(`noah: invalid PARAMS.${k}: ${v}\n`);
    process.exit(1);
  }
}

// ---- epoch-local state (one process per epoch; a worker reload after a timeout resets it) ----
// The starting basket, pinned on first sight of each base. A re-pin after a reload can only make
// the agent treat its current inventory as neutral, which is the conservative failure.
const baselineByBase = new Map<string, bigint>();
let gasSpentWei = 0n;

// Liquity side's own baselines. redemption-arb can fix these once at the start of the run, because
// it never touches WETH/ETH any other way. noah cannot: its own AMM side buys and sells WETH on
// every open/restore trade, so a baseline fixed once would make ordinary AMM inventory look like
// redemption proceeds forever after -- exactly what happened on the first local test (the Liquity
// branch's `unwind` fired every block from early on, each time undoing whatever the AMM side had
// just bought). The fix: track the live balance by default (so an AMM-driven move is never "above
// baseline"), and only freeze it for the one block where a redemption is in flight, so that block's
// increase -- and only that one -- reads as proceeds.
let liquityBaselineEthWei: bigint | null = null;
let liquityBaselineWethWei: bigint | null = null;
let awaitingRedeemProceeds = false;

function baselineOf(base: string, balance: bigint): bigint {
  if (!baselineByBase.has(base)) baselineByBase.set(base, balance);
  return baselineByBase.get(base) ?? balance;
}

const toFloat = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;
const toRaw = (x: number, decimals: number): bigint =>
  BigInt(Math.max(0, Math.floor(x * 10 ** decimals)));

type Candidate = {
  base: string;
  venue: AgentVenue;
  side: Side;
  isRestore: boolean;
  amountIn: bigint;
  fillPx: number; // USDC per base at the quoted size
  edgeBps: number; // fill vs fair, positive = in our favour
  profitUsdc: number; // vs fair, before gas
};

// Probe-size price from the observation: a cheap pre-filter so only venues that could clear the
// margin are quoted at size.
function probePx(v: AgentVenue, side: Side): number {
  const fee = v.feeBps / 10_000;
  if (side === "sell") return v.sellPrice ?? v.price * (1 - fee);
  return v.buyPrice ?? v.price / (1 - fee);
}

function edgeBpsOf(side: Side, fillPx: number, fair: number): number {
  return (side === "sell" ? fillPx / fair - 1 : 1 - fillPx / fair) * 10_000;
}

// How much may move in this direction, in the INPUT token's raw units (base for a sell, USDC for a
// buy): `restoreRoom` only back to the basket, `openRoom` out to the deviation bound (or, while
// closing out, no further than the basket either).
function roomFor(
  view: MarketView,
  side: Side,
  usdcBal: bigint,
  isClosingOut: boolean,
): { restoreRoom: bigint; openRoom: bigint } {
  const inv = BigInt(view.baseBalanceWei || "0");
  const baseline = baselineOf(view.base, inv);
  const dev = toRaw(toFloat(baseline, view.baseDecimals) * PARAMS.maxDevFrac, view.baseDecimals);
  if (side === "sell") {
    const restore = inv > baseline ? inv - baseline : 0n;
    const floor = baseline > dev ? baseline - dev : 0n;
    const open = isClosingOut ? restore : inv > floor ? inv - floor : 0n;
    return { restoreRoom: restore, openRoom: open };
  }
  const usdcFor = (baseRaw: bigint): bigint =>
    toRaw(toFloat(baseRaw, view.baseDecimals) * view.fair, 6);
  const cap = (x: bigint): bigint => (x < usdcBal ? x : usdcBal);
  const restore = inv < baseline ? usdcFor(baseline - inv) : 0n;
  const ceiling = baseline + dev;
  const open = isClosingOut ? restore : inv < ceiling ? usdcFor(ceiling - inv) : 0n;
  return { restoreRoom: cap(restore), openRoom: cap(open) };
}

// Quote a ladder of sizes and keep the rung with the highest profit whose average fill still
// clears the margin. Profit is concave in size, so the ladder stops at the first rung that is worse.
async function bestRung(
  ctx: AgentContext,
  view: MarketView,
  venue: AgentVenue,
  side: Side,
  room: bigint,
  thresholdBps: number,
  problems: string[],
): Promise<{ amountIn: bigint; fillPx: number; edgeBps: number; profitUsdc: number } | null> {
  let best: { amountIn: bigint; fillPx: number; edgeBps: number; profitUsdc: number } | null = null;
  for (const frac of PARAMS.ladder) {
    const amountIn = (room * BigInt(Math.round(frac * 10_000))) / 10_000n;
    if (amountIn <= 0n) continue;
    const q = await quoteOut(ctx.publicClient, venue.protocol as Venue, view.base, side, amountIn);
    if (!q.ok) {
      problems.push(q.error);
      break;
    }
    const baseAmt = toFloat(side === "sell" ? amountIn : q.out, view.baseDecimals);
    const usdcAmt = toFloat(side === "sell" ? q.out : amountIn, 6);
    if (!(baseAmt > 0)) break;
    const fillPx = usdcAmt / baseAmt;
    const edgeBps = edgeBpsOf(side, fillPx, view.fair);
    const profitUsdc = side === "sell" ? usdcAmt - baseAmt * view.fair : baseAmt * view.fair - usdcAmt;
    if (edgeBps < thresholdBps) break;
    if (best && profitUsdc <= best.profitUsdc) break;
    best = { amountIn, fillPx, edgeBps, profitUsdc };
  }
  return best;
}

async function candidatesFor(
  ctx: AgentContext,
  view: MarketView,
  usdcBal: bigint,
  isClosingOut: boolean,
  problems: string[],
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const side of ["sell", "buy"] as const) {
    const r = roomFor(view, side, usdcBal, isClosingOut);
    // Try the open margin first (it allows the larger room), then fall back to restoring only.
    const tiers = [
      { room: r.openRoom, thresholdBps: PARAMS.openEdgeBps, isRestore: false },
      { room: r.restoreRoom, thresholdBps: PARAMS.restoreEdgeBps, isRestore: true },
    ];
    // Venues are quoted in parallel: in a crash every venue is a candidate, and a sequential ladder
    // over all of them is what would run into the 5 s decide limit (rules §2.3).
    const perVenue = await Promise.all(
      view.venues.map(async (venue): Promise<Candidate | null> => {
        const probeEdge = edgeBpsOf(side, probePx(venue, side), view.fair);
        for (const tier of tiers) {
          if (tier.room <= 0n || probeEdge < tier.thresholdBps) continue;
          const rung = await bestRung(ctx, view, venue, side, tier.room, tier.thresholdBps, problems);
          if (!rung || rung.profitUsdc < PARAMS.minProfitUsdc) continue;
          return { base: view.base, venue, side, isRestore: tier.isRestore, ...rung };
        }
        return null;
      }),
    );
    let best: Candidate | null = null;
    for (const c of perVenue) if (c && (!best || c.profitUsdc > best.profitUsdc)) best = c;
    if (best) out.push(best);
  }
  return out;
}

// Priority fee: the minimum that beats the last block's top competitor for ordinary edges; the
// whole ceiling for big ones (a crash gap is winner-take-most). Never more than ceilFraction of the
// profit, never past the epoch's gas budget.
function bidFor(obs: AgentObservation, profitUsdc: number, legs: number): bigint | null {
  const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
  const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
  const gasUnits = GAS_PER_LEG * BigInt(legs);
  const ethPx = obs.fairPriceUsdcPerWeth;
  const profitWei = BigInt(Math.max(0, Math.floor((profitUsdc / ethPx) * 1e9))) * ONE_GWEI;
  const ceiling = (profitWei * BigInt(Math.floor(PARAMS.ceilFraction * 10_000))) / 10_000n / gasUnits;
  if (ceiling < minBid) return null;
  const competitorMax = BigInt(obs.competition?.maxCompetitorPriorityFeeWei ?? "0");
  let bid =
    profitUsdc >= PARAMS.bigProfitUsdc ? ceiling : competitorMax + competitorMax / 5n + minBid;
  if (bid > ceiling) bid = ceiling;
  if (bid < minBid) bid = minBid;
  if (bid > maxBid) bid = maxBid;
  const budgetWei = BigInt(Math.floor(PARAMS.gasBudgetEth * 1e9)) * ONE_GWEI;
  if (gasSpentWei + bid * gasUnits > budgetWei) bid = minBid;
  return bid;
}

function slipBps(edgeBps: number): number {
  return Math.round(
    Math.min(PARAMS.maxSlipBps, Math.max(PARAMS.minSlipBps, edgeBps * PARAMS.slipFracOfEdge)),
  );
}

// The non-"buy" kinds are a 1:1 port of redemption-arb's own action mapping (same action types,
// same fields). "buy" is folded in too so callers have one place to build a Liquity action from a
// decision; "hold" has no action (callers check for it before reaching here).
function liquityAction(decision: LiquityDecision, fee: string): Record<string, unknown> | null {
  switch (decision.kind) {
    case "buy":
      return {
        type: "liquitySwapEusd",
        tokenIn: "USDC",
        amountIn: decision.usdcIn.toString(),
        slippageBps: LIQUITY_PARAMS.slippageBps,
        maxPriorityFeePerGasWei: fee,
      };
    case "sell":
      return {
        type: "liquitySwapEusd",
        tokenIn: "EUSD",
        amountIn: decision.eusdIn.toString(),
        slippageBps: LIQUITY_PARAMS.slippageBps,
        maxPriorityFeePerGasWei: fee,
      };
    case "redeem":
      return {
        type: "liquityRedeem",
        amountEusdWei: decision.eusdIn.toString(),
        maxPriorityFeePerGasWei: fee,
      };
    case "wrap":
      return {
        type: "rawTx",
        tx: { to: TOKENS.WETH.address, data: "0xd0e30db0", value: decision.ethWei.toString() },
        maxPriorityFeePerGasWei: fee,
      };
    case "unwind":
      return {
        type: "swap",
        tokenIn: "WETH",
        amountIn: decision.wethWei.toString(),
        slippageBps: LIQUITY_PARAMS.slippageBps,
        maxPriorityFeePerGasWei: fee,
      };
    default:
      return null;
  }
}

function legAction(c: Candidate): Record<string, unknown> {
  const leg: Record<string, unknown> = {
    type: c.venue.swapType,
    tokenIn: c.side === "sell" ? c.base : "USDC",
    amountIn: c.amountIn.toString(),
    slippageBps: slipBps(c.edgeBps),
  };
  if (c.base !== "WETH") leg.base = c.base;
  return leg;
}

export async function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): Promise<AgentAction | Record<string, unknown> | null> {
  const round = obs.round;
  const signals: Record<string, number> = {};
  const problems: string[] = [];
  const noop = (reason: string): AgentAction => {
    const action: AgentAction = { type: "noop", reason };
    ctx.log({ round, action, reason, signals, ...(problems.length ? { state: { problems } } : {}) });
    return action;
  };

  if (!(obs.fairPriceUsdcPerWeth > 0)) return noop("invalid fair price");
  const usdcBal = BigInt(obs.balances.usdcUnits || "0");
  const fee = obs.limits.defaultPriorityFeePerGasWei;

  // Liquity: finish any position already open before anything else -- holding eUSD or ETH across
  // blocks while chasing an AMM edge is a price bet nobody chose to take (same ordering as
  // redemption-arb's own decideRedemption). A fresh buy is held back to compare against the AMM
  // candidates below instead of taken unconditionally.
  type LiquityBuy = Extract<LiquityDecision, { kind: "buy" }>;
  let liquityBuy: LiquityBuy | null = null;
  const liquity = obs.protocols.liquity;
  if (liquity) {
    const ethWei = BigInt(obs.balances.ethWei || "0");
    const liqWethWei = BigInt(obs.balances.wethWei || "0");
    // Track the live balance unless a redemption is in flight (see the comment on the state
    // above) -- otherwise re-baseline every call, so only that one block's increase can ever look
    // like proceeds.
    if (!awaitingRedeemProceeds || liquityBaselineEthWei === null) liquityBaselineEthWei = ethWei;
    if (!awaitingRedeemProceeds || liquityBaselineWethWei === null)
      liquityBaselineWethWei = liqWethWei;
    const ld = decideLiquity({
      liquity,
      usdcUnits: usdcBal,
      wethWei: liqWethWei,
      ethWei,
      ethBaselineWei: liquityBaselineEthWei,
      wethBaselineWei: liquityBaselineWethWei,
      canSellEth: obs.enabledProtocols.includes("uniswap"),
    });
    signals.eusd = Number(liquity.eusdBalanceWei) / 1e18;
    signals.discountBps = liquity.discountBps;
    if (ld.kind === "buy") {
      liquityBuy = ld;
    } else if (ld.kind !== "hold") {
      // unwind/wrap close out what redeem opened -- resume tracking the live balance from here.
      awaitingRedeemProceeds = ld.kind === "redeem";
      const action = liquityAction(ld, fee) ?? { type: "noop", reason: `liquity ${ld.kind}` };
      ctx.log({ round, action, signals, reason: `liquity ${ld.kind}` });
      return action;
    }
  }

  const views = marketViews(obs);
  if (views.length === 0 && !liquityBuy) return noop("no venue quoting any base");

  const isClosingOut =
    typeof obs.blocksRemaining === "number" && obs.blocksRemaining <= PARAMS.closeOutBlocks;
  signals.closingOut = isClosingOut ? 1 : 0;

  const candidates: Candidate[] = [];
  for (const view of views) {
    const inv = BigInt(view.baseBalanceWei || "0");
    const baseline = baselineOf(view.base, inv);
    signals[`dev_${view.base}`] =
      toFloat(inv, view.baseDecimals) - toFloat(baseline, view.baseDecimals);
    candidates.push(...(await candidatesFor(ctx, view, usdcBal, isClosingOut, problems)));
  }
  candidates.sort((a, b) => b.profitUsdc - a.profitUsdc);

  // The better of the two venues wins outright -- a Liquity buy never shares a block with an AMM
  // leg (neither strategy's sizing accounts for the other spending the same USDC balance).
  if (liquityBuy && liquityBuy.profitUsdc >= (candidates[0]?.profitUsdc ?? -Infinity)) {
    const action = liquityAction(liquityBuy, fee) as Record<string, unknown>;
    signals.profitUsdc = liquityBuy.profitUsdc;
    signals.maxEdgeBps = liquityBuy.edgeBps;
    ctx.log({
      round,
      action,
      signals,
      reason: `liquity buy ${liquityBuy.edgeBps.toFixed(0)}bps +${liquityBuy.profitUsdc.toFixed(2)}`,
    });
    return action;
  }

  if (candidates.length === 0) return noop("no fill clears fair by the margin at any size");

  // One leg per (base, venue): two legs on one pool would quote against the same state twice.
  const seen = new Set<string>();
  const legs = candidates.filter((c) => {
    const key = `${c.base}:${c.venue.protocol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, PARAMS.maxLegs);

  const profitUsdc = legs.reduce((s, c) => s + c.profitUsdc, 0);
  const bid = bidFor(obs, profitUsdc, legs.length);
  if (bid === null) return noop(`edge +${profitUsdc.toFixed(2)} USDC too thin for the floor bid`);
  gasSpentWei += bid * GAS_PER_LEG * BigInt(legs.length);

  signals.legs = legs.length;
  signals.profitUsdc = profitUsdc;
  signals.maxEdgeBps = Math.max(...legs.map((c) => c.edgeBps));
  signals.bidGwei = Number(bid) / 1e9;
  signals.restoring = legs.every((c) => c.isRestore) ? 1 : 0;

  const leaves = legs.map(legAction);
  const action: Record<string, unknown> =
    leaves.length === 1
      ? { ...leaves[0], maxPriorityFeePerGasWei: bid.toString() }
      : { type: "bundle", actions: leaves, maxPriorityFeePerGasWei: bid.toString() };
  const describe = legs
    .map((c) => `${c.side} ${c.base}@${c.venue.protocol} ${c.edgeBps.toFixed(0)}bps +${c.profitUsdc.toFixed(2)}${c.isRestore ? " (restore)" : ""}`)
    .join("; ");
  ctx.log({ round, action, signals, reason: describe });
  return action;
}
