// Shared snapshot-fetching hook. Two behaviors the five per-page hooks all need:
//   - a key change (run switch, agent switch) drops the stale data and shows the loading state
//   - a snapshot that reports itself live schedules the next refresh WITHOUT dropping the data,
//     so live mode updates in place instead of flashing "Loading…" every few seconds
import { useEffect, useRef, useState } from "react";

const LIVE_REFRESH_MS = 3_000;

export interface SnapshotState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export function useSnapshot<T>(
  key: string,
  fetcher: () => Promise<T>,
  isLive: (data: T) => boolean,
): SnapshotState<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  const keyRef = useRef<string | null>(null);
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
      setState({ data: null, loading: true, error: null });
    }
    fetcherRef
      .current()
      .then((data) => {
        if (cancelled) return;
        setState({ data, loading: false, error: null });
        if (isLiveRef.current(data)) {
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
  }, [key, tick]);

  return state;
}
