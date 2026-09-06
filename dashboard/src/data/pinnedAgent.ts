// The agent a viewer follows. There is no sign-in, so "mine" is a per-browser choice kept in
// localStorage: the standings highlight the row and the score chart draws the line in the accent
// colour, whatever else is on screen. One agent, because the question it answers is "where am I".

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "eris.pinnedAgent";

let pinned: string | null = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
})();

const listeners = new Set<() => void>();

export function getPinnedAgent(): string | null {
  return pinned;
}

export function setPinnedAgent(id: string | null): void {
  if (id === pinned) return;
  pinned = id;
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // per-viewer convenience only
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function usePinnedAgent(): string | null {
  return useSyncExternalStore(subscribe, getPinnedAgent, () => null);
}
