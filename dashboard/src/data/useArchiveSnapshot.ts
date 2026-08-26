import { fetchArchiveSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { ArchiveSnapshot } from "./types";

export function useArchiveSnapshot(): SnapshotState<ArchiveSnapshot> {
  const runId = useSelectedRunId();
  // The snapshot carries its own live flag (its round is typed "archived"-only): while the run is
  // still in progress the page keeps polling, and settles on the final standings once it completes.
  return useSnapshot(
    `archive:${runId ?? ""}`,
    fetchArchiveSnapshot,
    (data) => data.live === true,
  );
}
