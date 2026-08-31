// Shared snapshot-fetching hook. Two behaviors the five per-page hooks all need:
//   - a key change (run switch, agent switch) drops the stale data and shows the loading state
//   - a snapshot that reports itself live schedules the next refresh WITHOUT dropping the data,
//     so live mode updates in place instead of flashing "Loading…" every few seconds
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/locale";

const LIVE_REFRESH_MS = 3_000;

export interface SnapshotState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/**
 * `key` identifies the *view* (which run, which agent): changing it drops the stale data and shows
 * the loading state, because what is on screen no longer describes the same thing.
 *
 * `revision` identifies a *moment* of that view — the replay head. Changing it refetches without
 * clearing, because the view is still the same one: blanking the page on every replay tick would
 * make the whole feature a strobe.
 */
export function useSnapshot<T>(
  key: string,
  fetcher: () => Promise<T>,
  isLive: (data: T) => boolean,
  revision: string | number = "",
): SnapshotState<T> {
  // Snapshots carry display strings built in the data layer (via t()), so a language switch is a
  // view change: the key includes the locale and the snapshot rebuilds in the new language.
  const locale = useLocale();
  key = `${locale}:${key}`;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  const keyRef = useRef<string | null>(null);
  const wasLiveRef = useRef(false);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<SnapshotState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    if (keyRef.current !== key) {
      keyRef.current = key;
      wasLiveRef.current = false;
      setState({ data: null, loading: true, error: null });
    }
    fetcherRef
      .current()
      .then((data) => {
        if (cancelled) return;
        setState({ data, loading: false, error: null });
        const isLiveNow = isLiveRef.current(data);
        // One grace refresh after live -> not-live: the run's completing artifacts settle over a
        // few seconds, and the first non-live snapshot may still be a transitional read. The extra
        // poll picks up the settled state instead of stopping on whatever the transition returned.
        const wasLive = wasLiveRef.current;
        wasLiveRef.current = isLiveNow;
        if (isLiveNow || wasLive) {
          timer = window.setTimeout(
            () => setTick((n) => n + 1),
            LIVE_REFRESH_MS,
          );
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [key, revision, tick]);

  return state;
}
