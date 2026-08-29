// Replay: walk a completed run forward as if it were happening.
//
// The live views (issue #63 Phase 3) only exist while a run is in progress and only on the machine
// that ran it — the file tails are the dev server's own filesystem and the chain reads go to the
// agents' anvil. A run finished, or run somewhere else and collected afterwards, could only ever be
// read as a finished thing.
//
// Replay is the other direction: an archived run carries *more* than a live one (market.json, the
// scored epoch series, the complete blocks.csv), so "show this run as of block B" is a stronger view
// than live, not a simulation of it. Everything the provider builds is already derived from block
// ranges, so replay is one clamp applied before the derivations rather than a second rendering path.
//
// The one rule it has to keep: **never show the future.** A round that has not closed at B has no
// result, and the standings are recomputed from the returns up to B rather than read off the
// finished run — otherwise the replay would be a slideshow with the answer printed on every frame.

import { useSyncExternalStore } from "react";

/** Blocks advanced per tick at 1x. The tick rate is fixed so the refetch cost does not scale. */
const TICK_MS = 250;
export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface ReplayState {
  /** The run being replayed; null when replay is off. */
  runId: string | null;
  /** The block the replay head is at. */
  block: number;
  fromBlock: number;
  toBlock: number;
  playing: boolean;
  speed: ReplaySpeed;
}

const OFF: ReplayState = {
  runId: null,
  block: 0,
  fromBlock: 0,
  toBlock: 0,
  playing: false,
  speed: 1,
};

let state: ReplayState = OFF;
let timer: number | undefined;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function stopTimer(): void {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

function startTimer(): void {
  stopTimer();
  timer = window.setInterval(() => {
    if (!state.playing || state.runId === null) return;
    const next = state.block + state.speed;
    if (next >= state.toBlock) {
      // Stop at the end rather than looping: a replay that silently restarts looks like a live run
      // that rewound, which is the one thing this chain never does.
      state = { ...state, block: state.toBlock, playing: false };
      stopTimer();
    } else {
      state = { ...state, block: next };
    }
    emit();
  }, TICK_MS);
}

export function getReplay(): ReplayState {
  return state;
}

/** Arm replay over a run's block range, parked at the first block and paused. */
export function startReplay(
  runId: string,
  fromBlock: number,
  toBlock: number,
): void {
  state = {
    runId,
    fromBlock,
    toBlock,
    block: fromBlock,
    playing: false,
    speed: state.speed,
  };
  stopTimer();
  emit();
}

export function stopReplay(): void {
  state = { ...OFF, speed: state.speed };
  stopTimer();
  emit();
}

export function setReplayPlaying(playing: boolean): void {
  if (state.runId === null || playing === state.playing) return;
  // Pressing play at the end restarts from the beginning — the only rewind a viewer asks for.
  const block =
    playing && state.block >= state.toBlock ? state.fromBlock : state.block;
  state = { ...state, playing, block };
  if (playing) startTimer();
  else stopTimer();
  emit();
}

export function seekReplay(block: number): void {
  if (state.runId === null) return;
  const clamped = Math.min(state.toBlock, Math.max(state.fromBlock, block));
  if (clamped === state.block) return;
  state = { ...state, block: clamped };
  emit();
}

export function setReplaySpeed(speed: ReplaySpeed): void {
  if (state.speed === speed) return;
  state = { ...state, speed };
  emit();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Data hooks depend on this so the head moving refetches every snapshot. */
export function useReplay(): ReplayState {
  return useSyncExternalStore(subscribe, getReplay, () => OFF);
}

/** The head block for a run, or null when this run is not the one being replayed. */
export function replayHeadFor(runId: string): number | null {
  return state.runId === runId ? state.block : null;
}
