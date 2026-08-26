import { useEffect, useState } from "react";
import { fetchAgentDetailSnapshot } from "./provider";
import type { AgentDetailSnapshot } from "./types";

interface AgentDetailSnapshotState {
  data: AgentDetailSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function useAgentDetailSnapshot(agentId: string): AgentDetailSnapshotState {
  const [state, setState] = useState<AgentDetailSnapshotState>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    fetchAgentDetailSnapshot(agentId)
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
  }, [agentId]);

  return state;
}
