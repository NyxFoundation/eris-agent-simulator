// How the server that serves us is configured to show runs (server/runsApi.ts `/runs/mode.json`).
//
// `audience` means the server is withholding what a competition in progress must not publish (the
// scenario behind each epoch, upcoming environment windows, decision logs and pending bids). The
// files simply are not there; this flag is how a page says *why* a panel is absent rather than
// rendering it empty -- an empty decision log claims the agent never thought, an empty schedule
// claims nothing was planned. `standings` is rules §4.7: the trial environment posts no standings.
//
// Until the answer has arrived, the restrictions are on. The mode used to default to the operator's
// view (`standings: true`) both before the fetch resolved and when it failed, so a browser that
// could not load /runs/mode.json -- a proxy hiccup, a blocked request -- rendered ranks on the trial
// environment (issue #84 U). "Not yet known" is now an explicit state that withholds what either
// switch would withhold, and the fetch is retried while it stays unknown. A page that must not flash
// the restricted view at the operator waits on `known`.

import { useSyncExternalStore } from "react";

export interface DashboardMode {
  audience: boolean;
  standings: boolean;
  /** False until /runs/mode.json has answered. While false, both restrictions are on. */
  known: boolean;
}

/** The state before the server has said, and after it could not be asked: everything withheld. */
const UNKNOWN_MODE: DashboardMode = {
  audience: true,
  standings: false,
  known: false,
};

const RETRY_MS = 5_000;

let mode: DashboardMode = UNKNOWN_MODE;
let loaded: Promise<DashboardMode> | null = null;
let retrying = false;
// Bumped when the answer arrives. Snapshots are built against the mode (which files may be read,
// which panels may be drawn), so one built under the restricted default has to be rebuilt when a
// retry finally succeeds -- see useSnapshot, which folds this into every snapshot's key.
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

async function fetchMode(): Promise<DashboardMode | null> {
  try {
    const res = await fetch("/runs/mode.json");
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<DashboardMode>;
    return {
      audience: body.audience === true,
      standings: body.standings !== false,
      known: true,
    };
  } catch {
    return null;
  }
}

/** Retry in the background until the server answers, then wake every reader. */
function retryUntilKnown(): void {
  if (retrying) return;
  retrying = true;
  const attempt = async (): Promise<void> => {
    const answer = await fetchMode();
    if (answer) {
      retrying = false;
      mode = answer;
      generation += 1;
      emit();
      return;
    }
    setTimeout(() => void attempt(), RETRY_MS);
  };
  setTimeout(() => void attempt(), RETRY_MS);
}

/**
 * Resolves after one attempt, whatever it returned. Callers await this before building a snapshot
 * that depends on the mode, so it must not be able to hang: a page that waits forever on a
 * misrouted endpoint shows "Loading…" instead of the restricted view, which is worse than showing
 * the restricted view. A failed attempt keeps the restrictions on and retries in the background;
 * when the answer arrives every subscriber re-renders.
 *
 * A 404 is not an answer either: both mounts of the runs API serve the endpoint, so a missing one
 * is a misrouted request, and the safe reading of a misrouted request on a public box is
 * "restricted".
 */
export function loadMode(): Promise<DashboardMode> {
  loaded ??= (async () => {
    const answer = await fetchMode();
    if (answer) {
      mode = answer;
      generation += 1;
      emit();
    } else {
      retryUntilKnown();
    }
    return mode;
  })();
  return loaded;
}

/** How many times the mode has been answered. Part of every snapshot's key; see the note above. */
export function getModeGeneration(): number {
  return generation;
}

/** The mode as currently known (restricted until loadMode resolves). */
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
  return useSyncExternalStore(subscribe, getMode, () => UNKNOWN_MODE);
}
