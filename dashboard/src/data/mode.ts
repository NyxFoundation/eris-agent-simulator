// How the server that serves us is configured to show runs (server/runsApi.ts `/runs/mode.json`).
//
// `audience` means the server is withholding what a competition in progress must not publish (the
// scenario behind each epoch, upcoming environment windows, decision logs and pending bids). The
// files simply are not there; this flag is how a page says *why* a panel is absent rather than
// rendering it empty -- an empty decision log claims the agent never thought, an empty schedule
// claims nothing was planned. `standings` is rules §4.7: the trial environment posts no standings.
//
// Read once per page load; a 404 (a dev server predating the endpoint) is the default, which is the
// operator's own view of local output.

import { useSyncExternalStore } from "react";

export interface DashboardMode {
  audience: boolean;
  standings: boolean;
}

const DEFAULT_MODE: DashboardMode = { audience: false, standings: true };

let mode: DashboardMode = DEFAULT_MODE;
let loaded: Promise<DashboardMode> | null = null;
const listeners = new Set<() => void>();

export function loadMode(): Promise<DashboardMode> {
  loaded ??= (async () => {
    try {
      const res = await fetch("/runs/mode.json");
      if (!res.ok) return DEFAULT_MODE;
      const body = (await res.json()) as Partial<DashboardMode>;
      mode = {
        audience: body.audience === true,
        standings: body.standings !== false,
      };
    } catch {
      mode = DEFAULT_MODE;
    }
    for (const listener of [...listeners]) listener();
    return mode;
  })();
  return loaded;
}

/** The mode as currently known (the default until loadMode resolves). */
export function getMode(): DashboardMode {
  if (!loaded) void loadMode();
  return mode;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  void loadMode();
  return () => listeners.delete(callback);
}

export function useMode(): DashboardMode {
  return useSyncExternalStore(subscribe, getMode, () => DEFAULT_MODE);
}
