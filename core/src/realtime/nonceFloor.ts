// Every account the environment knows starts the epoch at a nonce no earlier epoch reached.
//
// A scenario matrix runs every epoch in one process, from one snapshot. The keys do not change
// between epochs (walletKeys.ts draws them once per process; the role keys come from env), and the
// revert puts every nonce back where the snapshot had it -- so a transaction signed and mined in
// epoch s is valid again, byte for byte, in epoch s+1. Anyone holding it can send it: a participant
// whose state directory carries across epochs (agentState.ts, #77) can read every signed
// transaction of epoch s off the chain while it is still there, keep it, and replay it at the top of
// the next. The gateway relays any signed transaction.
//
// Measured on anvil 1.7: the admin's oracle update from epoch s, replayed first in epoch s+1, is
// mined, and the coordinator's own update at that nonce is refused as `replacement transaction
// underpriced` -- the oracle fee is the same constant every epoch, so the replay is never outbid.
// With the whole of epoch s's sequence queued, the price feed would follow epoch s's path. A
// participant's replayed trades execute stale orders and take the nonces its own runtime expects.
//
// Raising each nonce to a floor above anything an earlier epoch used makes every old transaction
// `nonce too low`. The floor is wall-clock based, so it also holds across processes (a `--resume`
// re-derives the agent wallets, but the role keys are the same) and across a voided epoch's re-run:
//
//   floor = Date.now() × NONCES_PER_MS
//
// Two epoch starts are at least the length of an epoch apart, and an epoch of 360 blocks at
// 30,000,000 gas per agent per block holds at most ~514,000 transactions from one sender (21,000
// gas each) -- under one second's worth of floor. The value stays below 2^53 until the year ~2255,
// so the runtimes' `number` nonces are exact.
import type { Address, PublicClient } from "viem";
import { setNonce } from "@eris/sdk/chain.js";

export const NONCES_PER_MS = 1000;

export function epochNonceFloor(nowMs: number = Date.now()): number {
  return Math.floor(nowMs) * NONCES_PER_MS;
}

export type NonceFloorReport = {
  floor: number;
  accounts: number;
  raised: number;
  /** An account already past the floor (only if the clock went backwards). Left where it is. */
  alreadyAbove: number;
};

export async function raiseNonces(
  publicClient: PublicClient,
  addresses: Iterable<Address>,
  floor: number,
): Promise<NonceFloorReport> {
  const unique = [...new Set([...addresses].map((a) => a.toLowerCase() as Address))];
  let raised = 0;
  let alreadyAbove = 0;
  await Promise.all(
    unique.map(async (address) => {
      const current = await publicClient.getTransactionCount({ address, blockTag: "pending" });
      if (current >= floor) {
        alreadyAbove++;
        return;
      }
      await setNonce(publicClient, address, floor);
      raised++;
    }),
  );
  return { floor, accounts: unique.length, raised, alreadyAbove };
}
