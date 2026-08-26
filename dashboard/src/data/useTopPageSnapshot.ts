import { fetchTopPageSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { TopPageSnapshot } from "./types";

export function useTopPageSnapshot(): SnapshotState<TopPageSnapshot> {
  const runId = useSelectedRunId();
  return useSnapshot(
    `top:${runId ?? ""}`,
    fetchTopPageSnapshot,
    (data) => data.round.status === "live",
  );
}
