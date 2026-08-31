import { fetchTopPageSnapshot } from "./provider";
import { useReplay } from "./replay";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { TopPageSnapshot } from "./types";

export function useTopPageSnapshot(): SnapshotState<TopPageSnapshot> {
  const runId = useSelectedRunId();
  // A replay head that moved is a different cross-section of the same run, so it keys the fetch.
  const replay = useReplay();
  const head = replay.runId === null ? "" : replay.block;
  return useSnapshot(
    `top:${runId ?? ""}`,
    fetchTopPageSnapshot,
    (data) => data.round.status === "live",
    head,
  );
}
