import { useEffect, useState } from "react";
import { fetchTopPageSnapshot } from "./provider";
import type { TopPageSnapshot } from "./types";

interface TopPageSnapshotState {
  data: TopPageSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function useTopPageSnapshot(): TopPageSnapshotState {
  const [state, setState] = useState<TopPageSnapshotState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
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
  }, []);

  return state;
}
