// A timer for spans longer than Node's setTimeout can hold.
//
// setTimeout takes a 32-bit signed delay: anything above 2^31 - 1 ms (~24.8 days) is replaced by 1 ms
// with a TimeoutOverflowWarning. The practice period's run.seconds ceiling is 42 days, so a run that
// kept its time limit (one without stress events) ended one millisecond after it started, having
// mined nothing -- "realtime simulation completed ... (0 blocks, 0s)". This chains timers of at most
// the maximum until the deadline, measured against the clock rather than summed, so drift in the
// chain does not accumulate.

export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Calls `fn` once, `ms` from now. Returns a cancel function. `ms` must be positive. */
export function setLongTimeout(fn: () => void, ms: number): () => void {
  if (!(ms > 0))
    throw new Error(`setLongTimeout needs a positive delay, got ${ms}`);
  const deadline = Date.now() + ms;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (): void => {
    if (cancelled) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      fn();
      return;
    }
    handle = setTimeout(arm, Math.min(left, MAX_TIMEOUT_MS));
  };
  arm();
  return () => {
    cancelled = true;
    if (handle) clearTimeout(handle);
  };
}
