import { useEffect, useState } from "react";
import { fetchMarketSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import type { MarketSnapshot } from "./types";

interface MarketSnapshotState {
  data: MarketSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function useMarketSnapshot(): MarketSnapshotState {
  const runId = useSelectedRunId();
  const [state, setState] = useState<MarketSnapshotState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetchMarketSnapshot()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return state;
}
