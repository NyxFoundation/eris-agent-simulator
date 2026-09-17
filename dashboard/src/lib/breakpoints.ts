// The breakpoints, named once. The CSS side of the same numbers is in
// `src/styles/tokens/layout.css`; if one moves, move the other.
import { useMediaQuery } from "@/lib/useMediaQuery";

/** Below this the sidebar is a top bar with a drawer, and two-column layouts become one. */
export const MOBILE = "(max-width: 860px)";
/** A laptop half-screen or a tablet: still two columns, but tables drop their optional ones. */
export const NARROW = "(max-width: 1100px)";
/** A desktop monitor with room to spare, where a wide table can be shown whole. */
export const WIDE = "(min-width: 1700px)";

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE);
}
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW);
}
export function useIsWide(): boolean {
  return useMediaQuery(WIDE);
}
