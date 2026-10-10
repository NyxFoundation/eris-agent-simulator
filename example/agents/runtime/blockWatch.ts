/**
 * blockWatch.ts: noticing a new block within tens of milliseconds, without polling every tens of
 * milliseconds (issue #275).
 *
 * The runtime used to poll eth_blockNumber every blockTime/4 = 500 ms. When it noticed a block was
 * anywhere in [0, 500) ms after the block existed, and *where* was fixed by the process's start time
 * for the whole epoch. Bids are capped at 5 gwei, so contested blocks fill with equal bids, and
 * anvil's `--order fees` orders equal bids by arrival: the same agent went first block after block
 * (measured: 11 of 13 contested blocks in one whale epoch, against a 12 ms read-path difference).
 *
 * A subscription would fix it, and is not available: the RPC gateway is HTTP and refuses
 * eth_subscribe on purpose (infra/rpc-gateway, issue #87). Polling every 25 ms would fix it too, at
 * ten times the requests -- against a per-client token bucket on the same gateway.
 *
 * Blocks come on a fixed cadence, so the next one is predictable from the last. This polls at the
 * old interval until shortly before the next block is due, densely from then until it arrives, and
 * at the old interval again if it is late. When a block is first seen bounds when it was made, so the
 * window converges onto the chain's phase within a few blocks, and it can never notice later than the
 * old 500 ms poll did: outside the window the old interval is still the longest wait.
 */

export type BlockWatchTiming = {
  // The chain's block time: the cadence the next block is predicted from.
  blockTimeMs: number;
  // Poll interval outside the window, and the most a block can go unnoticed. The old interval.
  coarseMs: number;
  // Poll interval inside the window.
  denseMs: number;
  // The window opens this long before the next block is due ...
  leadMs: number;
  // ... and stays open this long after, for a block that is late.
  lagMs: number;
};

export function blockWatchTiming(blockTimeMs: number): BlockWatchTiming {
  return {
    blockTimeMs,
    coarseMs: Math.max(100, Math.floor(blockTimeMs / 4)),
    denseMs: 25,
    leadMs: 150,
    lagMs: 400,
  };
}

/// How long to wait before the next poll. `lastSeenAt` is when the newest block was first seen,
/// null before the first one.
export function nextPollDelayMs(
  now: number,
  lastSeenAt: number | null,
  timing: BlockWatchTiming,
): number {
  if (lastSeenAt === null) return timing.coarseMs;
  const due = lastSeenAt + timing.blockTimeMs;
  const opens = due - timing.leadMs;
  if (now < opens) return Math.max(0, Math.min(timing.coarseMs, opens - now));
  if (now < due + timing.lagMs) return timing.denseMs;
  return timing.coarseMs;
}

/// Watch for new blocks. Calls `onBlock` once per new head (the newest only, as viem's watcher did:
/// a skipped block is not replayed), starting with the current one. Returns a stop function.
export function watchBlocks(opts: {
  getBlockNumber: () => Promise<bigint>;
  onBlock: (blockNumber: number) => void;
  timing: BlockWatchTiming;
  onError?: (error: unknown) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): () => void {
  const now = opts.now ?? (() => performance.now());
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stopped = false;
  let last = -1n;
  let lastSeenAt: number | null = null;
  void (async () => {
    while (!stopped) {
      try {
        const bn = await opts.getBlockNumber();
        if (bn > last) {
          last = bn;
          lastSeenAt = now();
          opts.onBlock(Number(bn));
        }
      } catch (error) {
        opts.onError?.(error);
      }
      if (stopped) break;
      await sleep(nextPollDelayMs(now(), lastSeenAt, opts.timing));
    }
  })();
  return () => {
    stopped = true;
  };
}
