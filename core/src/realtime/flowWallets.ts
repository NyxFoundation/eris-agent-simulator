// The background flow's wallets over a long period (issue #130): what they hold, when a balance guard
// changed an order, and what to refill.
//
// The flow wallets are funded once at setup. On a 360-block run that is invisible; over a month of
// ~12 flow transactions a block -- every one a taker paying venue fees, and any net lean draining one
// side faster -- a wallet runs out of one token, and the flow's balance guards (a sell is never sent
// against nothing) turn it into a one-way flow. From outside that looks exactly like a trending
// market, which is what agents are trading against. Nothing recorded the balances or the guards, so
// a drained wallet was unobservable even in an audit.
//
// This module is the pure part: collecting the guard notes the bot reports, and deciding what to
// refill. The coordinator reads the chain and sends.

import type { FlowGuardNote } from "../flow/logic.js";

// How often the balances are logged (and, when enabled, topped up), when the config does not say.
// Ten minutes at the practice cadence: 144 rows a day, and a drain shows up long before it matters.
export const FLOW_TELEMETRY_BLOCKS = 300;

// A token is refilled once it falls below this fraction of its funded amount, and refilled to the
// funded amount. Half leaves every order size the flow draws (≤ a few WETH against 150) far from the
// guards, and restoring to the target rather than adding a fixed amount keeps the wallets bounded.
export const FLOW_TOPUP_FLOOR_BPS = 5_000n;

export type FlowGuardCounts = Record<
  string,
  Partial<Record<FlowGuardNote["guard"], number>>
>;

/**
 * Collects the guard notes between two telemetry points. `record` returns the notes that are new in
 * this interval -- one per (wallet, base, guard) -- so the coordinator can emit an event the first
 * time a guard bites rather than one per order, and `drain` hands back the counts for the interval.
 */
export class FlowGuardLog {
  private counts: FlowGuardCounts = {};
  private seen = new Set<string>();

  record(notes: FlowGuardNote[]): FlowGuardNote[] {
    const fresh: FlowGuardNote[] = [];
    for (const n of notes) {
      const wallet = flowWalletKey(n);
      const byGuard = (this.counts[wallet] ??= {});
      byGuard[n.guard] = (byGuard[n.guard] ?? 0) + 1;
      const key = `${wallet}|${n.guard}`;
      if (!this.seen.has(key)) {
        this.seen.add(key);
        fresh.push(n);
      }
    }
    return fresh;
  }

  drain(): FlowGuardCounts {
    const out = this.counts;
    this.counts = {};
    this.seen.clear();
    return out;
  }
}

/** `uniswap:informed:WETH` -- the wallet a note is about, and which base. */
export function flowWalletKey(
  n: Pick<FlowGuardNote, "protocol" | "kind" | "base">,
): string {
  return `${n.protocol}:${n.kind}:${n.base}`;
}

export type FlowWalletHoldings = {
  ethWei: bigint;
  wethWei: bigint;
  usdcUnits: bigint;
  bases: Record<string, bigint>;
};

export type FlowWalletTargets = {
  ethWei: bigint;
  wethWei: bigint;
  usdcUnits: bigint;
  bases: Record<string, bigint>;
};

/** What to grant a wallet: the funded amount for every token below the floor, 0 for the rest. */
export type FlowTopUp = {
  ethWei: bigint;
  wethWei: bigint;
  usdcUnits: bigint;
  bases: Record<string, bigint>;
  // The tokens being refilled, with what they held -- for the event.
  refilled: Record<string, { heldWei: string; targetWei: string }>;
};

function below(held: bigint, target: bigint): boolean {
  return target > 0n && held * 10_000n < target * FLOW_TOPUP_FLOOR_BPS;
}

/** The level a token is refilled at: the floor `below` compares against. */
export function flowTopUpFloor(target: bigint): bigint {
  return (target * FLOW_TOPUP_FLOOR_BPS) / 10_000n;
}

/**
 * The most of each token one wallet's gap-closing legs can commit in a single round. Deterministic:
 * the informed size is `cap x min(1, deviation x 20)`, so `cap` is reached whenever the venue is far
 * enough from fair -- which is exactly when the environment needs the leg to act.
 */
export type FlowDrainPerRound = {
  wethWei: bigint;
  usdcUnits: bigint;
  bases: Record<string, bigint>;
};

/**
 * How often the wallets must be checked for the funded amount to survive until the next check.
 *
 * The refill interval and the flow's per-round caps used to be chosen independently -- 150 WETH every
 * 300 blocks against an informed cap of 2 WETH a block, which is 600 WETH of demand against 150 of
 * supply. The shortfall only bites when the deviation is large enough to put the informed leg at full
 * size, i.e. the gap-closing side runs out of money exactly when the gap is widest, and the venue
 * price then walks away from fair with nothing pulling it back (measured on the practice devnet: the
 * informed revert rate rose from ~0 % just after a top-up to 85 % just before the next one).
 *
 * Deriving the interval from the caps removes the second number: whatever a config sets the caps and
 * the funded amount to, the wallets are visited often enough that a full-size round every block
 * cannot empty one. Returns `configured` when top-ups are off (0) or nothing can drain (0 caps) --
 * this never turns a top-up on, it only shortens an interval that is already running.
 */
export function flowTopUpIntervalBlocks(
  configuredBlocks: number,
  target: FlowWalletTargets,
  drain: FlowDrainPerRound,
): number {
  if (configuredBlocks <= 0) return configuredBlocks;
  // The refill only triggers below the floor, so the balance a wallet is guaranteed to still have
  // when a check finds it solvent is the floor -- that, not the full target, is what has to last
  // until the next check.
  const rounds = flowSolventRounds(
    {
      ethWei: flowTopUpFloor(target.ethWei),
      wethWei: flowTopUpFloor(target.wethWei),
      usdcUnits: flowTopUpFloor(target.usdcUnits),
      bases: Object.fromEntries(
        Object.entries(target.bases).map(([s, v]) => [s, flowTopUpFloor(v)]),
      ),
    },
    drain,
  );
  // One round of slack: the check reads the balances the round's orders were already sized against,
  // and the grant it decides on lands a block later.
  if (rounds === null) return configuredBlocks;
  const safe = rounds - 1;
  if (safe >= configuredBlocks) return configuredBlocks;
  return safe < 1 ? 1 : safe;
}

/**
 * The quote balance an informed wallet needs to buy for as many rounds as it can sell.
 *
 * The informed leg spends either a base or that base's worth of the quote token, whichever closes
 * the gap. Each base has a funded balance of its own; all of them buy out of one quote balance. So a
 * run with two bases sells for as many rounds as ever and buys for half as many, and the side that
 * runs out first is the one that pulls a venue back *up* to the reference price.
 *
 * `funding.flowUsdcUnits` was written when WETH was the only base -- 450,000 USDC is 150 WETH at
 * $3,000, exactly its mirror -- and issue #124's second base, funded at the same notional three days
 * later, doubled the demand on it without touching the number. Summing the legs here rather than
 * restating the sum in every config means a third base cannot reopen the gap quietly.
 *
 * `configured` is a floor, never a cap: a run that funds its wallets more deeply than the legs need
 * keeps what it asked for.
 */
export function informedQuoteTarget(
  configured: bigint,
  quoteNotionalPerBase: Record<string, bigint>,
): bigint {
  let sum = 0n;
  for (const v of Object.values(quoteNotionalPerBase)) sum += v;
  return sum > configured ? sum : configured;
}

/**
 * The gap-closing wallets' base side: `funding.informedFlow*`, floored at what the other flow
 * wallets hold.
 *
 * A price gap in the official regimes does not recover (ADR 0029 Amendment 1), so after a down gap
 * the pools sit above fair until something sells base into them -- and the informed leg is the only
 * part of the environment that does. It used to hold what every flow wallet holds (150 WETH, sized
 * for the noise around fair), sold out after the second down gap of a crash epoch, and the WETH pools
 * ended 300-1,037bps above fair. The amount is the same in every run (rules §3.3), so it is set for
 * the largest gap any official regime declares, compounded with 3 sd of the epoch's walk;
 * `test/flowInformedBudget.test.ts` derives that from the regime files and the pool depth.
 *
 * Only the AMM informed wallets: the uninformed wallets' inventory is a calibration knob (#112).
 */
export function informedBaseTargets(config: {
  flowWethWei: bigint;
  flowBaseAmounts: Record<string, bigint>;
  informedFlowWethWei: bigint;
  informedFlowBaseAmounts: Record<string, bigint>;
}): { wethWei: bigint; bases: Record<string, bigint> } {
  const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
  const bases: Record<string, bigint> = { ...config.flowBaseAmounts };
  for (const [symbol, amount] of Object.entries(config.informedFlowBaseAmounts))
    bases[symbol] = max(bases[symbol] ?? 0n, amount);
  return {
    wethWei: max(config.flowWethWei, config.informedFlowWethWei),
    bases,
  };
}

/**
 * The base a constant-product pool takes to move its price down by `downFrac`, starting from
 * `reserveBase` of base: x' = x / sqrt(1 - d). Uniswap's full-range position and Balancer's 50/50
 * pool are both this curve; fees are left out, which only makes the number smaller than the truth by
 * the fee on the input.
 */
export function constantProductBaseToMoveDown(
  reserveBase: bigint,
  downFrac: number,
): bigint {
  if (!(downFrac > 0) || downFrac >= 1) throw new Error(`downFrac ${downFrac}`);
  const scale = 1_000_000n;
  const mult = BigInt(Math.ceil((1 / Math.sqrt(1 - downFrac) - 1) * 1e6));
  return (reserveBase * mult + scale - 1n) / scale;
}

/**
 * Each base leg's inventory as quote units, which is what `informedQuoteTarget` sums.
 *
 * WETH comes from `funding.flowWethWei` and never from `flowBaseAmounts`: the resolved config
 * carries a `WETH: 0` entry there (the WETH inventory has its own field, and the funding path
 * ignores a WETH key in the base map), so reading the map for it would make the whole derivation a
 * no-op -- 0 is skipped, the sum comes to the WBTC leg alone, and that is exactly the number the
 * configured floor already was.
 */
export function informedQuoteNotionals(
  flowWethWei: bigint,
  flowBaseAmounts: Record<string, bigint>,
  quote: (amount: bigint, symbol: string) => bigint | null,
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  const add = (symbol: string, amount: bigint): void => {
    if (amount <= 0n) return;
    const q = quote(amount, symbol);
    if (q !== null && q > 0n) out[symbol] = q;
  };
  add("WETH", flowWethWei);
  for (const [symbol, amount] of Object.entries(flowBaseAmounts)) {
    if (symbol === "WETH") continue;
    add(symbol, amount);
  }
  return out;
}

/**
 * The tokens whose funded amount cannot carry `rounds` rounds of full-size flow.
 *
 * Shortening the interval only helps while one round is affordable at all: a wallet funded with less
 * than a single round's demand is short however often it is visited, and the caps or the funding have
 * to move. `rounds = 1` is therefore the satisfiability check on a config, and the coordinator says so
 * at startup rather than letting the gap-closing side go quiet mid-run.
 */
export function flowBudgetShortfall(
  funded: FlowWalletTargets,
  drain: FlowDrainPerRound,
  rounds: number,
): Array<{ symbol: string; funded: bigint; needed: bigint }> {
  const need = BigInt(Math.max(0, Math.floor(rounds)));
  const pairs: Array<[string, bigint, bigint]> = [
    ["WETH", funded.wethWei, drain.wethWei],
    ["USDC", funded.usdcUnits, drain.usdcUnits],
    ...Object.entries(drain.bases).map(
      ([symbol, d]): [string, bigint, bigint] => [
        symbol,
        funded.bases[symbol] ?? 0n,
        d,
      ],
    ),
  ];
  const out: Array<{ symbol: string; funded: bigint; needed: bigint }> = [];
  for (const [symbol, t, d] of pairs) {
    // A token the flow cannot spend is not short of it; one it can spend but was never funded with
    // is the balance guard's business from block one, not a budget to repair.
    if (d <= 0n || t <= 0n) continue;
    const needed = d * need;
    if (t < needed) out.push({ symbol, funded: t, needed });
  }
  return out;
}

/**
 * How many rounds of full-size flow a funded wallet survives, or null when nothing can drain it.
 * With a top-up this is how long a refill lasts; without one (every official regime) it is how far
 * into the run the gap-closing side can still act.
 */
export function flowSolventRounds(
  funded: FlowWalletTargets,
  drain: FlowDrainPerRound,
): number | null {
  const pairs: Array<[bigint, bigint]> = [
    [funded.wethWei, drain.wethWei],
    [funded.usdcUnits, drain.usdcUnits],
    ...Object.entries(drain.bases).map(
      ([symbol, d]): [bigint, bigint] => [funded.bases[symbol] ?? 0n, d],
    ),
  ];
  let limit: bigint | null = null;
  for (const [t, d] of pairs) {
    // A token the run never funded is one the flow can never spend either -- the balance guard
    // suppresses that leg from the first block - so it places no constraint on the interval.
    if (d <= 0n || t <= 0n) continue;
    const rounds = t / d;
    if (limit === null || rounds < limit) limit = rounds;
  }
  return limit === null ? null : Number(limit);
}

/**
 * null when nothing is below its floor. A token funded with 0 (a config that never gave the flow any)
 * is never refilled -- the top-up restores what the run chose, it does not invent inventory.
 */
export function planFlowTopUp(
  held: FlowWalletHoldings,
  target: FlowWalletTargets,
): FlowTopUp | null {
  const plan: FlowTopUp = {
    ethWei: 0n,
    wethWei: 0n,
    usdcUnits: 0n,
    bases: {},
    refilled: {},
  };
  const mark = (symbol: string, h: bigint, t: bigint): boolean => {
    if (!below(h, t)) return false;
    plan.refilled[symbol] = { heldWei: h.toString(), targetWei: t.toString() };
    return true;
  };
  if (mark("ETH", held.ethWei, target.ethWei)) plan.ethWei = target.ethWei;
  if (mark("WETH", held.wethWei, target.wethWei)) plan.wethWei = target.wethWei;
  if (mark("USDC", held.usdcUnits, target.usdcUnits))
    plan.usdcUnits = target.usdcUnits;
  for (const [symbol, t] of Object.entries(target.bases)) {
    if (symbol === "WETH") continue;
    if (mark(symbol, held.bases[symbol] ?? 0n, t)) plan.bases[symbol] = t;
  }
  return Object.keys(plan.refilled).length > 0 ? plan : null;
}
