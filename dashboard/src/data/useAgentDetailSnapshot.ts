import { fetchAgentDetailSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { AgentDetailSnapshot } from "./types";

export function useAgentDetailSnapshot(
  agentId: string,
): SnapshotState<AgentDetailSnapshot> {
  const runId = useSelectedRunId();
  return useSnapshot(
    `agent:${runId ?? ""}:${agentId}`,
    () => fetchAgentDetailSnapshot(agentId),
    (data) => data.round.status === "live",
  );
}
