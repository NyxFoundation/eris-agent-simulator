// The background flow's relay: the bot's orders for a block, sent from each flow wallet.
//
// The bot answers every block with a fresh set of orders, each sized and pointed against the pool
// and fair prices of that block. A send costs several round trips (quote, gas estimate, nonce, the
// send itself), and one wallet's sends have to be sequential (issue #148: two overlapping sends
// resolve the same pending nonce). Before this, a block's orders also went out one after another
// across wallets, and nothing bounded the per-wallet queue: on the practice devnet each gap-closing
// wallet sent ~1.24 orders a block against the bot's ~2, and the queue grew without end. The
// coordinator was sending orders the bot had made a day earlier (measured 2026-11-03: at least
// 44,100 blocks behind the head) -- each still re-quoted against the current pool, so it landed, but
// pointed at a market that no longer existed. The gap-closing side then pushed the venues *away*
// from fair, and the WETH pools reached 7.3x of it.
//
// Three rules, so a slow send costs orders instead of turning them around:
//   - wallets send independently: one wallet's slow send does not hold up another's;
//   - per wallet only the newest unsent block is kept: a block that arrives while the wallet is busy
//     replaces whatever was waiting, so the next send is always the newest decision, and both legs
//     of that block (WETH and every other base) stay together;
//   - an order from a block more than `maxAgeBlocks` behind the head is not sent at all.
// Every replaced and dropped order is counted, so a relay that cannot keep up says so.

export type FlowRelayBatch<T> = {
  /** The block whose state the bot sized these orders against. Undefined = unknown, never stale. */
  round: number | undefined;
  /** This wallet's orders from that block, in the bot's order. */
  items: T[];
};

export type FlowRelayStats = {
  /** Orders handed to `send`. */
  sent: number;
  /** Orders replaced by a newer block before their wallet got to them. */
  superseded: number;
  /** Orders dropped because their block was too far behind the head when their turn came. */
  stale: number;
  /** Orders whose send threw (the relay carries on with the next). */
  failed: number;
  /** Largest head - round seen at send time. */
  maxAgeBlocks: number;
  /** Longest single send, in ms. */
  maxSendMs: number;
};

export type FlowRelayOptions<T> = {
  /** The wallet an order is sent from; orders of one wallet go out one at a time. */
  walletOf: (item: T) => string;
  /** Send one order. Resolves when the transaction has been handed to the node. */
  send: (item: T, round: number | undefined) => Promise<void>;
  /** The newest block the coordinator knows about. */
  head: () => number | null;
  /** An order this many blocks or fewer behind the head is still sent. */
  maxAgeBlocks: number;
  now?: () => number;
};

export const FLOW_ORDER_MAX_AGE_BLOCKS = 2;

type WalletLane<T> = {
  busy: boolean;
  waiting: FlowRelayBatch<T> | null;
};

export class FlowRelay<T> {
  private readonly lanes = new Map<string, WalletLane<T>>();
  private stats: FlowRelayStats = FlowRelay.emptyStats();
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly opts: FlowRelayOptions<T>) {}

  private static emptyStats(): FlowRelayStats {
    return {
      sent: 0,
      superseded: 0,
      stale: 0,
      failed: 0,
      maxAgeBlocks: 0,
      maxSendMs: 0,
    };
  }

  /** Hand over one block's orders. Returns at once; the sends happen in the background. */
  push(round: number | undefined, items: T[]): void {
    const byWallet = new Map<string, T[]>();
    for (const item of items) {
      const wallet = this.opts.walletOf(item);
      const list = byWallet.get(wallet);
      if (list) list.push(item);
      else byWallet.set(wallet, [item]);
    }
    for (const [wallet, list] of byWallet) {
      let lane = this.lanes.get(wallet);
      if (!lane) {
        lane = { busy: false, waiting: null };
        this.lanes.set(wallet, lane);
      }
      if (lane.waiting) this.stats.superseded += lane.waiting.items.length;
      lane.waiting = { round, items: list };
      if (!lane.busy) void this.drain(wallet, lane);
    }
  }

  private async drain(wallet: string, lane: WalletLane<T>): Promise<void> {
    lane.busy = true;
    const now = this.opts.now ?? Date.now;
    while (lane.waiting) {
      const batch = lane.waiting;
      lane.waiting = null;
      for (const item of batch.items) {
        // Checked per order, not per batch: a batch of three orders whose first send took two blocks
        // must not send the other two against a market that has moved on.
        const head = this.opts.head();
        const age =
          batch.round !== undefined && head !== null ? head - batch.round : 0;
        if (age > this.opts.maxAgeBlocks) {
          this.stats.stale += 1;
          continue;
        }
        // A newer block for this wallet arrived while the previous order was in flight: the rest of
        // this one is superseded by it.
        if (lane.waiting) {
          this.stats.superseded += 1;
          continue;
        }
        if (age > this.stats.maxAgeBlocks) this.stats.maxAgeBlocks = age;
        const started = now();
        try {
          await this.opts.send(item, batch.round);
          this.stats.sent += 1;
        } catch {
          this.stats.failed += 1;
        }
        const took = now() - started;
        if (took > this.stats.maxSendMs) this.stats.maxSendMs = took;
      }
    }
    lane.busy = false;
    this.lanes.delete(wallet);
    if (this.lanes.size === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** The counts since the last call, reset. */
  drainStats(): FlowRelayStats {
    const out = this.stats;
    this.stats = FlowRelay.emptyStats();
    return out;
  }

  /** Wallets with a send in flight or waiting. */
  get busyWallets(): number {
    return this.lanes.size;
  }

  /** Resolves once no wallet has anything in flight or waiting. */
  idle(): Promise<void> {
    if (this.lanes.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
