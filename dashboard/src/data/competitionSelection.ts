import { useSyncExternalStore } from "react";

// The outer half of the two-level selection: competition contains scenario (one run), which
// contains round (one scoring epoch). The scenario selection stays in runSelection.ts, so every
// run-level page works the same whether the run came from a competition or stood alone.

const STORAGE_KEY = "eris.competition";

/**
 * "The user asked for standalone runs", which is not the same as "no competition chosen yet".
 * Without the distinction, picking it would fall through to the same default resolution as a first
 * visit and put the newest competition straight back on screen.
 */
export const SINGLE_RUNS = "__single__";

let selectedId: string | null = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
})();

const listeners = new Set<() => void>();

/** null means "nothing chosen yet" — the picker resolves it to the newest competition on disk. */
export function getSelectedCompetitionId(): string | null {
  return selectedId;
}

export function setSelectedCompetitionId(id: string | null): void {
  if (id === selectedId) return;
  selectedId = id;
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

export function useSelectedCompetitionId(): string | null {
  return useSyncExternalStore(subscribe, getSelectedCompetitionId, () => null);
}

/**
 * The competition actually in view: the stored choice, or the newest one on disk when nothing has
 * been chosen yet. `null` means the outer unit is a single run.
 *
 * One resolver, used by the picker, the standings loader and the scenario title alike — three
 * places deciding "which competition" independently is three chances to disagree.
 */
export function resolveCompetitionId(
  index: { id: string; kind?: "matrix" }[],
): string | null {
  const stored = getSelectedCompetitionId();
  if (stored === SINGLE_RUNS) return null;
  const competitions = index.filter((e) => e.kind === "matrix");
  if (stored && competitions.some((m) => m.id === stored)) return stored;
  // The index is newest-first, so this is the most recent competition on disk.
  return competitions[0]?.id ?? null;
}
