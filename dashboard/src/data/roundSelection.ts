// Which round the views are scoped to.
//
// This used to be its own store, which is how the dashboard ended up with three separate notions of
// "where on the round axis am I" — this one, the replay head, and the live head. It is now a view
// onto the single cursor in roundCursor.ts, so selecting a round on a scenario page and scrubbing
// the competition are the same act rather than two that can disagree.
//
// The numbering lines up without translation: the cursor's round is 1-based over epochs, and so is
// a scenario's, so round k of the competition is round k of each scenario in it. A scenario shorter than
// the cursor's position has simply ended — the pages that scope to a round say so rather than
// clamping silently, because a clamped view claims to show round k while showing something else.

import { getCursor, seekCursor, useCursor } from "./roundCursor";

/** 1-based round index, or null for "the whole run". */
export function getSelectedRound(): number | null {
  return getCursor().round;
}

export function setSelectedRound(index: number | null): void {
  seekCursor(index);
}

/** Data hooks depend on this so a round change refetches the snapshots that scope to it. */
export function useSelectedRound(): number | null {
  return useCursor().round;
}
