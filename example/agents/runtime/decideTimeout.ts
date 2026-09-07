// The per-decision response bound (competition rules §2.3: 5,000 milliseconds).
// StrategyRunner enforces it on the parent event loop and terminates the worker on expiry, so both
// synchronous loops and unresolved awaits cost only that decision. Submissions are committed only
// with an on-time result. The next call reloads the selected strategy; the agent process, revision
// history and state directory continue. Worker-local variables reset; no automatic rollback occurs.
// withDecideTimeout also bounds standalone async executors. It alone cannot interrupt synchronous
// JavaScript; production decisions must run through StrategyRunner.
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
