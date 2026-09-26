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
