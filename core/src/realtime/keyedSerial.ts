// One task at a time per key, any number across keys.
//
// The background flow's orders are relayed fire-and-forget, one batch per block. A batch whose sends
// outlast the block overlaps the next one, and when both hold an order for the same wallet, both
// sends resolve the same pending nonce: the second is refused as `replacement transaction
// underpriced` and the order is lost (issue #148 -- one in 358,970 over 22 hours of the practice
// rehearsal). The coordinator already keeps every other shared key sequential (the oracle, the LST
// accrual, the registrar); this does the same for the flow wallets, keyed by wallet, so different
// wallets still send concurrently.
export class KeyedSerial {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `task` after every earlier task for `key` has settled. A failure does not block the next. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with a task queued or in flight. */
  get pendingKeys(): number {
    return this.tails.size;
  }
}
