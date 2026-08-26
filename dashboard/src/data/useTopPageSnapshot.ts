import { useEffect, useState } from "react";
import { fetchTopPageSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import type { TopPageSnapshot } from "./types";

interface TopPageSnapshotState {
  data: TopPageSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function useTopPageSnapshot(): TopPageSnapshotState {
  const runId = useSelectedRunId();
  const [state, setState] = useState<TopPageSnapshotState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetchTopPageSnapshot()
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
