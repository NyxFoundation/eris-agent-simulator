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
// mid-pass is read back as the head's own price); at the tick the miner waits for that, then writes
// and mines in one JSON-RPC batch (`commit`, on a node measured to serve a batch in order) or in two
// requests. Every block is mined on a complete price set. With the batch, the new prices are visible
// in `latest` only while the node builds the block -- measured 5.5 ms median, 14 ms max on a local
// calm run -- and a transaction sent after seeing them goes into the next block, not this one.
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
  // An apply that has not answered in this long counts as failed. Default one block time.
  applyTimeoutMs?: number;
  // Every block it mines, so the block pass can start at once instead of waiting for the watcher's
  // next poll (a quarter block): the pass is what the next block waits for.
  onMined?: (head: number) => void;
  onGateTimeout?: (info: { head: number; stagedFor: number; waitedMs: number }) => void;
  onWriteError?: (info: { forBlock: number; error: unknown; retried: boolean }) => void;
  // An apply failed twice, so the block was held rather than mined on a half-written price set;
  // `minedAnyway` after MAX_HELD_TICKS held ticks in a row, when the chain goes on regardless.
  onApplyHeld?: (info: { forBlock: number; heldTicks: number; minedAnyway: boolean }) => void;
  onMineError?: (info: { head: number; error: unknown }) => void;
  // The schedule fell more than MAX_CATCHUP_BLOCKS behind and was restarted from now.
  onResync?: (info: { head: number; behindBlocks: number }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// `commit`, when the stage has one, writes and mines in one request and resolves to the new head
// (a JSON-RPC batch the node serves in order; the coordinator checks that at startup). The new prices
// are then in `latest` only inside the node's handling of that request. `apply` is the fallback, and
// what stop() uses (it writes without mining).
type Staged = {
  forBlock: number;
  apply: () => Promise<void>;
  commit?: () => Promise<number>;
  applied: boolean;
};

// Short enough that a stop or a staged write is noticed within a fraction of a 2 s block.
const POLL_MS = 10;
// Behind schedule, blocks come at no less than half a block time until the schedule is caught up:
// the chain keeps its wall-clock cadence (run.endsAt, the interval length and every agent's
// dayBlocksRemaining are converted at blockTimeSec), and an agent still gets most of a block to act.
const MIN_GAP_FRACTION = 0.5;
// Further behind than this (a long stall), the lost time is written off rather than caught up:
// catching up an hour at half-block spacing would be an hour of a different market.
export const MAX_CATCHUP_BLOCKS = 30;
// A price set that cannot be written holds the block this many ticks before the chain goes on with
// what is in storage (and says so): a chain that stops is worse than one block on mixed prices.
export const MAX_HELD_TICKS = 3;
// The write-to-mine window samples kept for stats() (the most recent ones).
const WINDOW_SAMPLES = 5_000;

export class GatedMiner {
  private readonly opts: Required<
    Pick<GatedMinerOptions, "now" | "sleep" | "mineTimeoutMs" | "applyTimeoutMs">
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
  private heldTicks = 0;
  private held = 0;
  // From the start of a tick's apply to its block being mined: how long the next block's prices sat
  // in `latest` before the block that uses them existed (an upper bound on that window).
  private windows: number[] = [];

  constructor(opts: GatedMinerOptions) {
    this.opts = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      mineTimeoutMs: opts.blockTimeMs * 10,
      applyTimeoutMs: opts.blockTimeMs,
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
  stage(
    forBlock: number,
    apply: () => Promise<void>,
    commit?: () => Promise<number>,
  ): void {
    if (forBlock < this.staged.forBlock) return;
    this.staged = { forBlock, apply, ...(commit ? { commit } : {}), applied: false };
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
    held: number;
    head: number;
    writeToMineMs: { samples: number; p50: number; p99: number; max: number } | null;
  } {
    const w = [...this.windows].sort((a, b) => a - b);
    const at = (q: number): number => w[Math.min(w.length - 1, Math.floor(q * w.length))];
    return {
      mined: this.mined,
      gateTimeouts: this.gateTimeouts,
      mineErrors: this.mineErrors,
      resyncs: this.resyncs,
      held: this.held,
      head: this.head,
      writeToMineMs:
        w.length > 0
          ? { samples: w.length, p50: at(0.5), p99: at(0.99), max: w[w.length - 1] }
          : null,
    };
  }

  private async sleepUntil(t: number): Promise<void> {
    while (!this.stopped) {
      const left = t - this.opts.now();
      if (left <= 0) return;
      await this.opts.sleep(Math.min(POLL_MS, left));
    }
  }

  // The writes are idempotent storage sets, so a failed apply is retried once, each attempt bounded
  // by applyTimeoutMs. False when both failed: the stage stays unapplied for the next tick, because
  // mining on a mix of new and old prices (one oracle written, another not) is what the gate exists
  // to prevent.
  private async applyStaged(): Promise<boolean> {
    const staged = this.staged;
    if (staged.applied) return true;
    for (const retried of [false, true]) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          staged.apply(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`apply did not finish within ${this.opts.applyTimeoutMs} ms`)),
              this.opts.applyTimeoutMs,
            );
          }),
        ]);
        staged.applied = true;
        return true;
      } catch (error) {
        this.opts.onWriteError?.({ forBlock: staged.forBlock, error, retried });
      } finally {
        clearTimeout(timer);
      }
    }
    return false;
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

      const applyStart = now();
      // One request for the writes and the block, when the stage can do that. A failure falls back
      // to the two steps below (apply with its retry and hold, then mine), so it costs nothing new.
      if (!this.staged.applied && this.staged.commit) {
        const staged = this.staged;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const head = await Promise.race([
            staged.commit!(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`commit did not answer within ${this.opts.mineTimeoutMs} ms`)),
                this.opts.mineTimeoutMs,
              );
            }),
          ]);
          staged.applied = true;
          this.head = Math.max(this.head, head);
          this.heldTicks = 0;
          this.mined++;
          if (this.windows.length >= WINDOW_SAMPLES) this.windows.shift();
          this.windows.push(now() - applyStart);
          lastMine = now();
          k++;
          this.opts.onMined?.(this.head);
          continue;
        } catch (error) {
          this.opts.onWriteError?.({ forBlock: staged.forBlock, error, retried: false });
        } finally {
          clearTimeout(timer);
        }
      }
      if (!(await this.applyStaged())) {
        this.heldTicks++;
        const minedAnyway = this.heldTicks >= MAX_HELD_TICKS;
        this.opts.onApplyHeld?.({
          forBlock: this.staged.forBlock,
          heldTicks: this.heldTicks,
          minedAnyway,
        });
        if (!minedAnyway) {
          this.held++;
          lastMine = now();
          k++;
          continue;
        }
        // Give up on this stage: the chain goes on with what storage holds.
        this.staged.applied = true;
      }
      this.heldTicks = 0;

      try {
        this.head = await this.mineOnce();
        if (this.windows.length >= WINDOW_SAMPLES) this.windows.shift();
        this.windows.push(now() - applyStart);
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
