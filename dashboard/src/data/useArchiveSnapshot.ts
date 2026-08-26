import { useEffect, useState } from "react";
import { fetchArchiveSnapshot } from "./provider";
import type { ArchiveSnapshot } from "./types";

interface ArchiveSnapshotState {
  data: ArchiveSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function useArchiveSnapshot(): ArchiveSnapshotState {
  const [state, setState] = useState<ArchiveSnapshotState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetchArchiveSnapshot()
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
