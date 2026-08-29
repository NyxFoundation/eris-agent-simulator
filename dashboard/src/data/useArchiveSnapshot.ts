import { fetchArchiveSnapshot } from "./provider";
import { useReplay } from "./replay";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { ArchiveSnapshot } from "./types";

export function useArchiveSnapshot(): SnapshotState<ArchiveSnapshot> {
  const runId = useSelectedRunId();
  // A replay head that moved is a different cross-section of the same run, so it keys the fetch.
  const replay = useReplay();
  const head = replay.runId === null ? "" : replay.block;
  // The snapshot carries its own live flag (its round is typed "archived"-only): while the run is
  // still in progress the page keeps polling, and settles on the final standings once it completes.
  return useSnapshot(
    `archive:${runId ?? ""}`,
    fetchArchiveSnapshot,
    (data) => data.live === true,
    head,
  );
}
