// The per-decision response bound (competition rules §2.3: 5,000 milliseconds).
//
// bot.ts races every call into decide() against it, whether the strategy is the one the participant
// shipped or one the model installed in-run. Past the bound the block is no action; a late answer, if
// one ever comes, is dropped -- the block it was for has closed. There is no restart and no freeze
// (§2.3): the agent simply goes on to the next block.
//
// What this can and cannot stop. A decide() that awaits something that never resolves is caught
// here. A decide() that spins synchronously blocks the event loop itself, so no timer inside this
// process fires until it returns -- nothing in-process can interrupt it, and that agent is silent for
// the rest of the epoch. That is the trade the rules make by stopping at "no action".
export const DECIDE_TIMEOUT_MS = 5000;

export class DecideTimeoutError extends Error {
  constructor(round: number) {
    super(
      `decide timeout: no answer within ${DECIDE_TIMEOUT_MS}ms (rules §2.3); block ${round} is no action`,
    );
    this.name = "DecideTimeoutError";
  }
}

// `pending` may be a value rather than a promise: a synchronous decide() returns its action directly,
// and a synchronous throw happens before this is ever called (the caller's try/catch sees it).
export function withDecideTimeout<T>(
  pending: Promise<T> | T,
  round: number,
  timeoutMs = DECIDE_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DecideTimeoutError(round)), timeoutMs);
  });
  return Promise.race([Promise.resolve(pending), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
