import { fetchWorldSnapshot } from "./provider";
import { useSelectedRound } from "./roundSelection";
import { useReplay } from "./replay";
import { useSelectedRunId } from "./runSelection";
import { useSnapshot, type SnapshotState } from "./useSnapshot";
import type { WorldSnapshot } from "./types";

/**
 * The world map's frames. Keyed like the explorer's: the run and the selected round are the view,
 * the replay head is a moment of it.
 *
 * The page's own playhead is deliberately not in the key. It walks frames the snapshot already
 * holds, so moving it is a render and not a fetch — a walk that refetched every step would be a
 * slideshow of loading states.
 */
export function useWorldSnapshot(base = "WETH"): SnapshotState<WorldSnapshot> {
  const runId = useSelectedRunId();
  const replay = useReplay();
  const head = replay.runId === null ? "" : replay.block;
  const round = useSelectedRound();
  return useSnapshot(
    `world:${runId ?? ""}:${round ?? "all"}:${base}`,
    () => fetchWorldSnapshot(base),
    (data) => data.round.status === "live",
    head,
  );
}
