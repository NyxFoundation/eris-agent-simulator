import { fetchExplorerSnapshot } from "./provider";
import { useSelectedRound } from "./roundSelection";
import { useReplay } from "./replay";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { ExplorerSnapshot } from "./types";

export function useExplorerSnapshot(): SnapshotState<ExplorerSnapshot> {
  const runId = useSelectedRunId();
  // A replay head that moved is a different cross-section of the same run, so it keys the fetch.
  const replay = useReplay();
  const head = replay.runId === null ? "" : replay.block;
  // The explorer is scoped to the selected round, so a round change is a refetch — the key carries
  // it for the same reason it carries the run.
  const round = useSelectedRound();
  return useSnapshot(
    `explorer:${runId ?? ""}:${round ?? "all"}`,
    fetchExplorerSnapshot,
    (data) => data.round.status === "live",
    head,
  );
}
