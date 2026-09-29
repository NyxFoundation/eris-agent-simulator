import { useEffect, useState } from "react";

/**
 * The browser's clock, re-read every `everyMs`. For what the schedule says about "now" — which
 * period is current, whether registration is still open — so that a page left open across midnight
 * JST changes its answer without a reload.
 */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}
