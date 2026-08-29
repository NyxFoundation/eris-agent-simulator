import { fetchAgentDetailSnapshot } from "./provider";
import { useReplay } from "./replay";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { AgentDetailSnapshot } from "./types";

export function useAgentDetailSnapshot(
  agentId: string,
): SnapshotState<AgentDetailSnapshot> {
  const runId = useSelectedRunId();
  // A replay head that moved is a different cross-section of the same run, so it keys the fetch.
  const replay = useReplay();
  const head = replay.runId === null ? "" : replay.block;
  return useSnapshot(
    `agent:${runId ?? ""}:${agentId}`,
    () => fetchAgentDetailSnapshot(agentId),
    (data) => data.round.status === "live",
    head,
  );
}
