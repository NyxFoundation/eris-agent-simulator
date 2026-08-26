import { useEffect, useState } from "react";
import { fetchExplorerSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import type { ExplorerSnapshot } from "./types";

interface ExplorerSnapshotState {
  data: ExplorerSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function useExplorerSnapshot(): ExplorerSnapshotState {
  const runId = useSelectedRunId();
  const [state, setState] = useState<ExplorerSnapshotState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
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
  }, [runId]);

  return state;
}
