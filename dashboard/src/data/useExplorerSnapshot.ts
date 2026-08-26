import { useEffect, useState } from "react";
import { fetchExplorerSnapshot } from "./provider";
import type { ExplorerSnapshot } from "./types";

interface ExplorerSnapshotState {
  data: ExplorerSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function useExplorerSnapshot(): ExplorerSnapshotState {
  const [state, setState] = useState<ExplorerSnapshotState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetchExplorerSnapshot()
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
