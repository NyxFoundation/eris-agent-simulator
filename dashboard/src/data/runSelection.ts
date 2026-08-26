import { useSyncExternalStore } from "react";

const STORAGE_KEY = "eris.selectedRun";

let selectedRunId: string | null = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
})();

const listeners = new Set<() => void>();

/** null means "latest run" — resolved by the provider against the run index. */
export function getSelectedRunId(): string | null {
  return selectedRunId;
}

export function setSelectedRunId(id: string | null): void {
  if (id === selectedRunId) return;
  selectedRunId = id;
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

/** Data hooks depend on this so a run change refetches every snapshot. */
export function useSelectedRunId(): string | null {
  return useSyncExternalStore(subscribe, getSelectedRunId, () => null);
}
