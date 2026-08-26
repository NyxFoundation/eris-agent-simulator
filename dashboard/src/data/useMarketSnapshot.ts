import { fetchMarketSnapshot } from "./provider";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { MarketSnapshot } from "./types";

export function useMarketSnapshot(): SnapshotState<MarketSnapshot> {
  const runId = useSelectedRunId();
  return useSnapshot(
    `market:${runId ?? ""}`,
    fetchMarketSnapshot,
    (data) => data.round.status === "live",
  );
}
