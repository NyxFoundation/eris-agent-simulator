// What the environment submitted, kept only until the blocks.csv flush has attributed it (issue #134).
//
// The coordinator records every transaction it sends -- oracle writes, flow relays, stress actors,
// registry writes -- so the flush can attribute a mined transaction to the mechanism that sent it
// rather than only to the sending address. That lookup is the one reader. A hash that has been
// attributed in a flushed block cannot appear in another block, so the read removes it.
//
// Transactions that are never mined (dropped, replaced) never reach that read. Each entry is stamped
// with the flush position when it was recorded, and a sweep on every flush removes entries that have
// sat unread for more than `retainBlocks` flushed blocks. The stamp is the flush position rather than
// the head because it is the one number every call site can see without threading the block number
// through the flow relay and the stress actors, and it only ever errs late: a transaction recorded at
// flush position F lands at F + 1 or later.
//
// Before this, the map grew by roughly one entry per environment transaction for the life of the
// process: ~23 per block, ~1M per day at the practice cadence, ~200 MB of heap per day, and a
// month-long period ran into the heap limit in about three weeks.

// Twenty minutes at the practice cadence. Far beyond any honest inclusion delay (the environment's
// transactions land within a block or two), far below a size that matters (~23 entries per block).
export const SUBMITTED_RETAIN_BLOCKS = 600;

type Entry<M> = { meta: M; stampedAt: number };

export class SubmittedLedger<M> {
  private readonly byHash = new Map<string, Entry<M>>();
  private flushedThrough = 0;

  constructor(private readonly retainBlocks: number = SUBMITTED_RETAIN_BLOCKS) {
    if (!Number.isInteger(retainBlocks) || retainBlocks < 1)
      throw new Error(
        `retainBlocks must be a positive integer, got ${retainBlocks}`,
      );
  }

  record(hash: string, meta: M): void {
    this.byHash.set(hash.toLowerCase(), {
      meta,
      stampedAt: this.flushedThrough,
    });
  }

  /** The attribution for a mined transaction, removed on read: it cannot be mined twice. */
  take(hash: string): M | undefined {
    const key = hash.toLowerCase();
    const entry = this.byHash.get(key);
    if (!entry) return undefined;
    this.byHash.delete(key);
    return entry.meta;
  }

  /**
   * Called after the flush has written every block up to `flushedThrough`. Removes the entries that
   * were recorded more than `retainBlocks` flushed blocks ago and were never mined; returns how many.
   */
  sweep(flushedThrough: number): number {
    if (flushedThrough > this.flushedThrough)
      this.flushedThrough = flushedThrough;
    const cutoff = this.flushedThrough - this.retainBlocks;
    let removed = 0;
    for (const [key, entry] of this.byHash) {
      if (entry.stampedAt < cutoff) {
        this.byHash.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.byHash.size;
  }
}
