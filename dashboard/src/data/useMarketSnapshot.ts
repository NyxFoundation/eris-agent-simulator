import { fetchMarketSnapshot } from "./provider";
import { useSelectedRound } from "./roundSelection";
import { useReplay } from "./replay";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { MarketSnapshot } from "./types";

export function useMarketSnapshot(
  base = "WETH",
): SnapshotState<MarketSnapshot> {
  const runId = useSelectedRunId();
  // A replay head that moved is a different cross-section of the same run, so it keys the fetch.
  const replay = useReplay();
  const head = replay.runId === null ? "" : replay.block;
  // Every series on the page is scoped to the selected round, so a round change is a refetch — the
  // same reason the key carries the run.
  const round = useSelectedRound();
  return useSnapshot(
    `market:${runId ?? ""}:${round ?? "all"}:${base}`,
    () => fetchMarketSnapshot(base),
    (data) => data.round.status === "live",
    head,
  );
}
