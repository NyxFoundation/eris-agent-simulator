// Which round (scoring epoch) the views are scoped to. Deliberately in-memory rather than
// localStorage: an epoch index only means something inside one run, and a remembered "round 7"
// would silently point at a different block range the next time a shorter run is opened.
import { useSyncExternalStore } from "react";

let selectedRound: number | null = null;

const listeners = new Set<() => void>();

/** 1-based round index, or null for "the whole run". */
export function getSelectedRound(): number | null {
  return selectedRound;
}

export function setSelectedRound(index: number | null): void {
  if (index === selectedRound) return;
  selectedRound = index;
  for (const listener of [...listeners]) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Data hooks depend on this so a round change refetches the snapshots that scope to it. */
export function useSelectedRound(): number | null {
  return useSyncExternalStore(subscribe, getSelectedRound, () => null);
}
