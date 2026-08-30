import { useSyncExternalStore } from "react";

// The outer half of the two-level selection: matrix (the competition) contains scenario (one run),
// which contains round (one scoring epoch). The dashboard used to start at the middle level, which
// meant it opened on a single draw from a regime's distribution — the exact reading
// config/scenarios/public.yaml warns against ("the published seeds are five draws from it, not the
// target"). The scenario selection stays in runSelection.ts and is unchanged, so every run-level
// page keeps working exactly as before, including for standalone `sim:realtime` runs that belong to
// no matrix at all.

const STORAGE_KEY = "eris.selectedMatrix";

/**
 * "The user asked for no matrix", which is not the same as "no matrix chosen yet". Without the
 * distinction, picking "all runs" would fall through to the same default resolution as a first
 * visit and put the newest matrix straight back on screen.
 */
export const NO_MATRIX = "__none__";

let selectedMatrixId: string | null = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
})();

const listeners = new Set<() => void>();

/** null means "no matrix chosen yet" — the picker resolves it to the newest one in the index. */
export function getSelectedMatrixId(): string | null {
  return selectedMatrixId;
}

export function setSelectedMatrixId(id: string | null): void {
  if (id === selectedMatrixId) return;
  selectedMatrixId = id;
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // per-viewer convenience only; selection still works for this session
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useSelectedMatrixId(): string | null {
  return useSyncExternalStore(subscribe, getSelectedMatrixId, () => null);
}
