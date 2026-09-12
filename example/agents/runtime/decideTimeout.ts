// The per-decision response bound (competition rules §2.3: 5,000 milliseconds).
// StrategyRunner enforces it on the parent event loop and terminates the worker on expiry, so both
// synchronous loops and unresolved awaits cost only that decision. Submissions are committed only
// with an on-time result. The next call reloads the selected strategy; the agent process, revision
// history and state directory continue. Worker-local variables reset; no automatic rollback occurs.
// withDecideTimeout also bounds standalone async executors. It alone cannot interrupt synchronous
// JavaScript; production decisions must run through StrategyRunner.
export const DECIDE_TIMEOUT_MS = 5000;

// The bound on loading the strategy module into a fresh worker. This is a separate number from the
// decision bound on purpose: §2.3 bounds a decision, not a `tsx` compile, and reusing 5,000 ms for
// the module load killed 13 of 31 agents at boot on a loaded host ("strategy worker startup
// exceeded 5000ms" -> exit 1 -> the agent is dead for the epoch, issue #100 / #93 F-J). Sixty
// seconds is the coordinator's own agents-ready bound (`run.agentsReadyTimeoutSec`, PR #97): an
// agent that has not loaded by then has already missed the first block. A module that spins forever
// is still cut off, just not one that merely compiles slowly.
export const STRATEGY_STARTUP_TIMEOUT_MS = 60_000;

// After this many consecutive failed decisions (a throw, a crash, a timeout) the runner stops
// replacing the worker every block. Each failure discards the worker -- callbacks from a failed
// decision must never trade later -- and each replacement is a `tsx` boot, so a strategy that throws
// on every block was a worker spawn every 2 s for the whole run: `lp-provider` at ~100 % of a core
// in every epoch (issue #100 / #93 F-H). The back-off doubles from one block up to
// STRATEGY_BACKOFF_MAX_BLOCKS and resets on the first decision that returns.
export const STRATEGY_BACKOFF_AFTER = 3;
export const STRATEGY_BACKOFF_MAX_BLOCKS = 64;

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
