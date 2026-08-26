import { fetchArchiveSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { ArchiveSnapshot } from "./types";

export function useArchiveSnapshot(): SnapshotState<ArchiveSnapshot> {
  const runId = useSelectedRunId();
  // ArchiveSnapshot's round is typed "archived"-only, so it never self-reports live; the archive
  // view of an in-progress run is a static partial and settles once the run completes.
  return useSnapshot(
    `archive:${runId ?? ""}`,
    fetchArchiveSnapshot,
    () => false,
  );
}
