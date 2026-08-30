// The round cursor: the dashboard's clock.
//
// Everything in this system is measured in scoring epochs. The score is the mean and spread of
// per-epoch returns, rank changes happen at epoch boundaries, and an environment event lands in one.
// The UI nonetheless had no time axis — its spine was "which run am I looking at", which is a file
// picker — so the round axis got reinvented locally three times over: a round selection for scoping,
// a replay head for walking a finished run, and a live head for one in progress. Three stores, one
// concept: a position on the round axis.
//
// This is that position, held once. `round` is 1-based and competition-relative: at round k every
// scenario in the competition is at its own round k, which is what makes 35 independent worlds
// watchable as one competition. `null` means the end — the finished result, which is what a
// standing means when nobody is scrubbing.
//
// Sub-round movement (walking the blocks inside one scenario) stays in replay.ts: it is a
// refinement of this position, not a competing notion of it, and it only exists once a single
// scenario is open. When replay is armed it drives the cursor; the cursor never drives it back.

import { useSyncExternalStore } from "react";

/** Rounds advanced per tick at 1x. Slower than replay's block tick: a round is a bigger step. */
const TICK_MS = 700;

export const CURSOR_SPEEDS = [1, 2, 4] as const;
export type CursorSpeed = (typeof CURSOR_SPEEDS)[number];

export interface CursorState {
  /** 1-based round, or null for "the end" — the finished result. */
  round: number | null;
  /** The highest round any scenario in the current competition reaches. 0 when unknown. */
  maxRound: number;
  playing: boolean;
  speed: CursorSpeed;
}

const INITIAL: CursorState = {
  round: null,
  maxRound: 0,
  playing: false,
  speed: 1,
};

let state: CursorState = INITIAL;
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
    if (!state.playing) return;
    const at = state.round ?? state.maxRound;
    const next = at + state.speed;
    if (next >= state.maxRound) {
      // Park at the end rather than looping. A cursor that silently restarts reads as a competition
      // that rewound, and this one never does.
      state = { ...state, round: null, playing: false };
      stopTimer();
    } else {
      state = { ...state, round: next };
    }
    emit();
  }, TICK_MS);
}

export function getCursor(): CursorState {
  return state;
}

/**
 * Tell the cursor how long the thing in view is — the longest scenario of a competition, or a
 * single run's epoch count when none is selected.
 *
 * A position that still exists in the new range is kept, so walking from the competition into one of its
 * scenarios lands on the round you were already looking at. A position past the new end is parked
 * at the end rather than clamped to it: round 20 of a nine-round scenario is not round 9, and
 * pretending otherwise would label a view with a round it is not showing.
 */
export function setCursorRange(maxRound: number): void {
  if (maxRound === state.maxRound) return;
  const round =
    state.round !== null && state.round <= maxRound ? state.round : null;
  if (round === null) stopTimer();
  state = {
    ...state,
    maxRound,
    round,
    playing: round === null ? false : state.playing,
  };
  emit();
}

/** null parks at the end. Out-of-range values are clamped rather than rejected. */
export function seekCursor(round: number | null): void {
  const next =
    round === null
      ? null
      : Math.min(Math.max(1, Math.round(round)), Math.max(1, state.maxRound));
  // Landing on the last round is the same view as the end, but "round 29 of 29" and "final" are
  // different claims about whether more is coming, so they stay distinguishable.
  if (next === state.round) return;
  state = { ...state, round: next };
  emit();
}

export function setCursorPlaying(playing: boolean): void {
  if (playing === state.playing) return;
  if (playing && state.maxRound <= 0) return;
  // Pressing play at the end rewinds to the first round — the only rewind a viewer asks for.
  const round = playing && state.round === null ? 1 : state.round;
  state = { ...state, playing, round };
  if (playing) startTimer();
  else stopTimer();
  emit();
}

export function setCursorSpeed(speed: CursorSpeed): void {
  if (state.speed === speed) return;
  state = { ...state, speed };
  emit();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useCursor(): CursorState {
  return useSyncExternalStore(subscribe, getCursor, () => INITIAL);
}
