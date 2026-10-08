// ADR 0011 §1 / §5-3, §5-4: under economicGas the environment mines the blocks itself, and only once
// the prices for the next block are in storage.
//
// The economic profile finalizes prices with storage writes (PriceFeed, every Aave aggregator, the
// GMX provider) instead of txs at the top of the block. Under anvil's interval mining those writes
// race the timer: a block cut between two of them carries a PriceFeed and an Aave oracle from
// different steps, and a write made right after block N was processed sits in `latest` for most of
// a block time before block N+1 uses it, so whoever polls fastest reads next block's price first.
// The miner closes both. The block pass *stages* its writes instead of making them, once it has
// finished reading the head block (anvil writes storage into the head's state, so a write made
// mid-pass is read back as the head's own price); at the tick the miner waits for that, applies the
// writes, and mines in the next call. Every block is mined on a complete price set, and a price is
// in `latest` for one RPC round trip before the block that uses it.
//
// A pass that never stages (a hung read, an exception before the oracle task) must not stop the
// chain: after `gateTimeoutMs` the block is mined on whatever is in storage -- the previous step's
// prices, consistently across every oracle -- and the miss is reported.

export type GatedMinerOptions = {
  blockTimeMs: number;
  // How long a tick waits for the head block's prices before mining without them.
  gateTimeoutMs: number;
  // The chain head the miner starts from. The first block waits for the first pass's stage like
  // every other: setup's prices are not a stage, and a resume starts on a catch-up pass.
  startHead: number;
  // Mine one block; resolves to the new head.
  mine: () => Promise<number>;
  // The chain's head, read before each gate. `mine` is not the only way the head moves -- a mine
  // that timed out here can still land, a head read after a successful mine can fail, and a resumed
  // period's setup mines blocks -- and a head the miner does not know about is a gate it skips: the
  // next block would go out before the pass for the real head staged.
  readHead?: () => Promise<number>;
  // A mine that has not answered in this long is given up on and retried at the next tick, so a hung
  // RPC cannot hold the chain (or the teardown, which waits for the loop) forever. Default 10 blocks.
  mineTimeoutMs?: number;
  // Every block it mines, so the block pass can start at once instead of waiting for the watcher's
  // next poll (a quarter block): the pass is what the next block waits for.
  onMined?: (head: number) => void;
  onGateTimeout?: (info: { head: number; stagedFor: number; waitedMs: number }) => void;
  onWriteError?: (info: { forBlock: number; error: unknown; retried: boolean }) => void;
  onMineError?: (info: { head: number; error: unknown }) => void;
  // The schedule fell more than MAX_CATCHUP_BLOCKS behind and was restarted from now.
  onResync?: (info: { head: number; behindBlocks: number }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Staged = { forBlock: number; apply: () => Promise<void>; applied: boolean };

// Short enough that a stop or a staged write is noticed within a fraction of a 2 s block.
const POLL_MS = 10;
// Behind schedule, blocks come at no less than half a block time until the schedule is caught up:
// the chain keeps its wall-clock cadence (run.endsAt, the interval length and every agent's
// dayBlocksRemaining are converted at blockTimeSec), and an agent still gets most of a block to act.
const MIN_GAP_FRACTION = 0.5;
// Further behind than this (a long stall), the lost time is written off rather than caught up:
// catching up an hour at half-block spacing would be an hour of a different market.
export const MAX_CATCHUP_BLOCKS = 30;

export class GatedMiner {
  private readonly opts: Required<
    Pick<GatedMinerOptions, "now" | "sleep" | "mineTimeoutMs">
  > &
    GatedMinerOptions;
  private staged: Staged;
  private head: number;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private gateTimeouts = 0;
  private mined = 0;
  private mineErrors = 0;
  private resyncs = 0;

  constructor(opts: GatedMinerOptions) {
    this.opts = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      mineTimeoutMs: opts.blockTimeMs * 10,
      ...opts,
    };
    this.head = opts.startHead;
    this.staged = {
      forBlock: opts.startHead - 1,
      apply: async () => {},
      applied: true,
    };
  }

  // The block pass for `forBlock` hands over the writes that price block `forBlock + 1`. A later
  // stage replaces an earlier one that was never applied: only the newest prices matter.
  stage(forBlock: number, apply: () => Promise<void>): void {
    if (forBlock < this.staged.forBlock) return;
    this.staged = { forBlock, apply, applied: false };
  }

  start(): void {
    if (this.loop) return;
    // run() handles its own errors; this is the last line, so a bug in it is not an unhandled
    // rejection that takes the coordinator down.
    this.loop = this.run().catch((error) =>
      this.opts.onMineError?.({ head: this.head, error }),
    );
  }

  // Stop mining without waiting: the run is over (its end block was processed), and every block
  // after it would only be a gate timeout.
  halt(): void {
    this.stopped = true;
  }

  // Stops mining, then applies a stage the loop did not get to. Without that, whether the last
  // block's history carries the prices written for the block after it would depend on where the
  // loop happened to be, and the end block would read differently live and in the post-run sweep.
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    await this.applyStaged();
  }

  stats(): {
    mined: number;
    gateTimeouts: number;
    mineErrors: number;
    resyncs: number;
    head: number;
  } {
    return {
      mined: this.mined,
      gateTimeouts: this.gateTimeouts,
      mineErrors: this.mineErrors,
      resyncs: this.resyncs,
      head: this.head,
    };
  }

  private async sleepUntil(t: number): Promise<void> {
    while (!this.stopped) {
      const left = t - this.opts.now();
      if (left <= 0) return;
      await this.opts.sleep(Math.min(POLL_MS, left));
    }
  }

  // The writes are idempotent storage sets, so a failed apply is retried once: mining on a mix of
  // new and old prices (one oracle written, another not) is what the gate exists to prevent.
  private async applyStaged(): Promise<void> {
    const staged = this.staged;
    if (staged.applied) return;
    staged.applied = true;
    for (const retried of [false, true]) {
      try {
        await staged.apply();
        return;
      } catch (error) {
        this.opts.onWriteError?.({ forBlock: staged.forBlock, error, retried });
      }
    }
  }

  // A real timer, not opts.sleep (which a test's clock advances), and cleared once the mine answers
  // so a finished run is not held open by it.
  private async mineOnce(): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`mine did not answer within ${this.opts.mineTimeoutMs} ms`)),
        this.opts.mineTimeoutMs,
      );
    });
    try {
      return await Promise.race([this.opts.mine(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(): Promise<void> {
    const { blockTimeMs, gateTimeoutMs, now, sleep } = this.opts;
    let origin = now();
    let k = 1;
    let lastMine = origin;
    while (!this.stopped) {
      const onSchedule = origin + k * blockTimeMs;
      const behind = Math.floor((now() - onSchedule) / blockTimeMs);
      if (behind > MAX_CATCHUP_BLOCKS) {
        this.resyncs++;
        this.opts.onResync?.({ head: this.head, behindBlocks: behind });
        origin = now();
        k = 1;
        continue;
      }
      await this.sleepUntil(
        Math.max(onSchedule, lastMine + blockTimeMs * MIN_GAP_FRACTION),
      );
      if (this.stopped) break;
      if (this.opts.readHead) {
        try {
          this.head = Math.max(this.head, await this.opts.readHead());
        } catch {
          // The gate runs on the head it knows; the next tick reads again.
        }
      }

      const gateStart = now();
      while (
        !this.stopped &&
        this.staged.forBlock < this.head &&
        now() - gateStart < gateTimeoutMs
      ) {
        await sleep(POLL_MS);
      }
      if (this.stopped) break;
      if (this.staged.forBlock < this.head) {
        this.gateTimeouts++;
        this.opts.onGateTimeout?.({
          head: this.head,
          stagedFor: this.staged.forBlock,
          waitedMs: now() - gateStart,
        });
      }

      await this.applyStaged();

      try {
        this.head = await this.mineOnce();
      } catch (error) {
        // The block was not mined (or not confirmed): try again at the next slot. The staged writes
        // are already in storage, so the retry mines the same prices.
        this.mineErrors++;
        this.opts.onMineError?.({ head: this.head, error });
        lastMine = now();
        k++;
        continue;
      }
      this.mined++;
      lastMine = now();
      k++;
      this.opts.onMined?.(this.head);
    }
  }
}
