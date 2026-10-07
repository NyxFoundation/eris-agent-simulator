// The loaded state's clock, and the fresh node's (issue #263).
//
// A state dump is deployed on a warped clock: the deployer moves 14 days + 1 hour past Liquity's
// bootstrap period and then deploys the rest, so GMX's DataStore (and anything else stamped at
// deploy) holds timestamps up to the dump's head. An anvil that `--load-state`s that dump keeps the
// head block's timestamp, but mines its *next* block at wall-clock time plus its own offset, which
// is behind the head by the whole warp. Every GMX order in that window is cancelled with
// `Panic(0x11)` -- the keeper's time math underflows -- until wall clock catches up, which on a
// local bake took ~250 blocks of a 360-block epoch (measured 2026-10-06). The matrix's revert puts
// the head back every epoch, so every epoch started that way.
//
// setupLiquity's own warp did not cover it: it compares the *head's* timestamp with Liquity's
// opening, and the head is past it -- the deployer saw to that -- so it found nothing to do. The
// clock that matters is the next block's, and the only way to read that is to mine one.
//
// So, once per run and before any setup transaction: mine a block, and if it landed behind the
// state's head, move the node's clock up to the head. One warp per `--load-state` of a chain that
// is never reset (the practice devnet); every epoch on the matrix, where the revert undoes it.
import type { PublicClient } from "viem";
import { increaseTime, mine } from "@eris/sdk/chain.js";
import type { RunLogger } from "../logger.js";

export const STATE_CLOCK_EVENT = "state_clock_aligned";

export type StateClockReport = {
  stateHeadUnix: number;
  probeUnix: number;
  toUnix: number;
  warpedSeconds: number;
};

/** By how much the next block fell behind the state's head; 0 when the clock is already past it. */
export function clockShortfall(stateHeadUnix: bigint, nextBlockUnix: bigint): number {
  return nextBlockUnix >= stateHeadUnix ? 0 : Number(stateHeadUnix - nextBlockUnix);
}

export async function alignClockToState(
  publicClient: PublicClient,
  logger: RunLogger,
): Promise<StateClockReport | undefined> {
  const head = await publicClient.getBlock();
  await mine(publicClient);
  const probe = await publicClient.getBlock();
  const shortfall = clockShortfall(head.timestamp, probe.timestamp);
  if (shortfall === 0) return undefined;
  // One second past the head: the next block must be strictly later than the state it builds on.
  const warpedSeconds = shortfall + 1;
  await increaseTime(publicClient, warpedSeconds);
  await mine(publicClient);
  const after = await publicClient.getBlock();
  const report: StateClockReport = {
    stateHeadUnix: Number(head.timestamp),
    probeUnix: Number(probe.timestamp),
    toUnix: Number(after.timestamp),
    warpedSeconds,
  };
  logger.event({
    type: STATE_CLOCK_EVENT,
    ...report,
    note:
      "the loaded state's head is ahead of this node's clock (the deployer warped before deploying); " +
      "moved the clock up to it so time-stamped venue state (GMX) does not see time run backwards",
  });
  return report;
}
