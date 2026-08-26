import { fetchExplorerSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { ExplorerSnapshot } from "./types";

export function useExplorerSnapshot(): SnapshotState<ExplorerSnapshot> {
  const runId = useSelectedRunId();
  return useSnapshot(
    `explorer:${runId ?? ""}`,
    fetchExplorerSnapshot,
    (data) => data.round.status === "live",
  );
}
