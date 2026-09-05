// Shared helpers for the agent-created-market reference agents (issue #40 T7).
//
// The four questions every one of them has to answer about a registry entry, in one place:
//
//   who made it            — `mine`, for not trading against yourself
//   can its price be moved — `oracleOwner`, the parameter that decides who gets liquidated
//   has its code changed   — `codehashNow` against `codehashAtRegistration`
//   can I get out in time  — `blocksRemaining`, because under the round-trip rule a position still
//                            inside an unknown contract at the epoch's final block is worth zero
//
// The last one is the one that is easy to forget and expensive to get wrong: every trap class in
// this environment — honeypot token, owner drain, proxy swap-out, oracle rug — collapses into the
// same failure mode, which is that you could not get out in time.
import type {
  AgentObservation,
  LendingObservation,
  LendingPositionObservation,
  RegistryEntryObservation,
} from "@eris/sdk";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;

export type EntryVerdict = {
  ok: boolean;
  // Every reason it failed, not just the first: an entry that is both unverified and has a movable
  // oracle is a different thing from one that is only unverified.
  reasons: string[];
};

// Would a careful agent touch this at all? Deliberately conservative, and deliberately not the only
// possible answer: refusing everything unverified is a legal strategy, it just earns nothing.
export function assessEntry(
  entry: RegistryEntryObservation,
  opts: { requireVerified?: boolean } = {},
): EntryVerdict {
  const reasons: string[] = [];
  if (opts.requireVerified !== false && !entry.verified)
    reasons.push("unverified: the code is whatever its creator compiled");
  if (
    entry.codehashNow !== undefined &&
    entry.codehashNow.toLowerCase() !== entry.codehashAtRegistration.toLowerCase()
  ) {
    // The registry records the hash once and never refreshes it. Noticing the difference is the
    // agent's job, and it is the classic proxy rug.
    reasons.push("code changed since registration");
  }
  if (entry.kind === "lendingMarket") {
    if (entry.oracleOwner === undefined)
      reasons.push("oracle does not answer owner(): it may still be movable");
    else if (entry.oracleOwner.toLowerCase() !== ZERO_ADDRESS)
      reasons.push(`oracle price is movable by ${entry.oracleOwner}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// The lending markets in the observation, joined to their registry entries so the caller can see
// both the position and the provenance in one place.
export function lendingMarketsWithProvenance(
  obs: AgentObservation,
): Array<{
  market: LendingPositionObservation;
  entry?: RegistryEntryObservation;
}> {
  const byId = new Map<string, RegistryEntryObservation>();
  for (const e of obs.registry?.entries ?? []) {
    if (e.kind === "lendingMarket" && e.extra)
      byId.set(e.extra.toLowerCase(), e);
  }
  return (obs.protocols.lending?.markets ?? []).map((market) => ({
    market,
    entry: byId.get(market.marketId.toLowerCase()),
  }));
}

// Whether the market's price can still be moved by somebody. Undefined owner is treated as movable:
// a contract that does not answer `owner()` has not told you it is frozen.
export function oracleIsFrozen(entry: RegistryEntryObservation | undefined): boolean {
  return entry?.oracleOwner?.toLowerCase() === ZERO_ADDRESS;
}

// How many blocks are left, defaulting to "plenty" when the run has no block limit. Every exit
// decision in these agents keys off this: the round-trip rule is a deadline, not a preference.
export function blocksLeft(obs: AgentObservation): number {
  return obs.blocksRemaining ?? Number.POSITIVE_INFINITY;
}

// The collateral value of `amount` units, in loan-token units, at the market's own oracle price.
// Used for sizing a borrow, never for valuing a position: the market's oracle is the creator's
// parameter and the scorer does not read it.
export function collateralInLoanUnits(
  amount: bigint,
  priceScaled: bigint,
): bigint {
  return (amount * priceScaled) / ORACLE_PRICE_SCALE;
}

// A fraction of a balance, in basis points. Every agent here has to declare its own size: the
// competition removed per-order caps outright rather than raising them, so nothing hands one down.
export function bps(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(Math.max(0, Math.floor(basisPoints)))) / 10_000n;
}


// How much of a supply position the market can actually pay right now.
//
// "max" is the right ask and the wrong plan. `withdrawAll` takes the whole position, and a market
// whose loan tokens are out with a borrower cannot pay it -- the transaction reverts and the whole
// position stays inside. Under the round-trip rule that is the difference between zero and most of
// it, and retrying the same all-or-nothing call until the bell is the version of the mistake that
// looks like it is trying.
export function withdrawableNow(
  market: LendingPositionObservation | undefined,
): { supplied: bigint; available: bigint } {
  const supplied = BigInt(market?.supplyAssets ?? "0");
  const idle =
    BigInt(market?.totalSupplyAssets ?? "0") -
    BigInt(market?.totalBorrowAssets ?? "0");
  const available = idle < 0n ? 0n : idle < supplied ? idle : supplied;
  return { supplied, available };
}

// The withdrawal to send this block, or null when there is nothing the market can pay. Null is the
// answer to keep: submitting a call that is going to revert costs a transaction out of the
// per-block allowance and buys nothing.
export function withdrawAction(
  lending: LendingObservation | undefined,
  marketId: string,
  fee: string | undefined,
): Record<string, unknown> | null {
  const market = lending?.markets.find((m) => m.marketId === marketId);
  const { supplied, available } = withdrawableNow(market);
  if (supplied === 0n) return null;
  if (available === 0n) return null;
  return {
    type: "lendingWithdraw",
    marketId,
    // Only ask for everything when everything is there. Otherwise take what is.
    amount: available >= supplied ? "max" : available.toString(),
    maxPriorityFeePerGasWei: fee,
  };
}
