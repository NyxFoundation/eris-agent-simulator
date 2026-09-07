// The glyphs the board names its nodes with.
//
// One sprite, defined once and referenced by every node, because a node's glyph is its taxonomy and
// the taxonomy has to be legible at a glance across a hundred of them: an arbitrageur, a liquidity
// provider, a lender, a baseline; a pool, a perp, a lending market, a staking vault, a CDP. They are
// category marks, never protocol logos — real logos are multi-colour, and the board spends its
// colour on what moved, not on branding.
//
// Ported from the conference demo's sprite (ascon/demo/world-surface), so the film and the
// dashboard name the same things the same way.

export const WORLD_SPRITE_ID = "world-icon";

/** Mount once per page; every `<WorldIcon>` references it. */
export function WorldSprite() {
  return (
    <svg
      width={0}
      height={0}
      aria-hidden="true"
      style={{ position: "absolute" }}
    >
      <defs>
        {/* agent roles */}
        <symbol id={`${WORLD_SPRITE_ID}-arb`} viewBox="0 0 16 16">
          <path
            d="M2 6h9M8.5 3 12 6l-3.5 3M14 10H5m3.5 3L5 10l3.5-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </symbol>
        <symbol id={`${WORLD_SPRITE_ID}-lp`} viewBox="0 0 16 16">
          <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <rect x="5.6" y="5.6" width="4.8" height="4.8" rx="1" fill="currentColor" />
        </symbol>
        <symbol id={`${WORLD_SPRITE_ID}-lend`} viewBox="0 0 16 16">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </symbol>
        <symbol id={`${WORLD_SPRITE_ID}-base`} viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </symbol>
        {/* the chain */}
        <symbol id={`${WORLD_SPRITE_ID}-chain`} viewBox="0 0 16 16">
          <rect x="1.3" y="5.2" width="5.4" height="5.6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="9.3" y="5.2" width="5.4" height="5.6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.7 8h2.6" stroke="currentColor" strokeWidth="1.5" />
        </symbol>
        {/* what an agent is thinking */}
        <symbol id={`${WORLD_SPRITE_ID}-brain`} viewBox="0 0 16 16">
          <path d="M8 2.6v10.8M8 5.2 5 3.6M8 5.2l3-1.6M8 9.4l-3.4 1.9M8 9.4l3.4 1.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="8" cy="2.6" r="1.5" fill="currentColor" />
          <circle cx="4.6" cy="3.3" r="1.3" fill="currentColor" />
          <circle cx="11.4" cy="3.3" r="1.3" fill="currentColor" />
          <circle cx="4.3" cy="11.6" r="1.3" fill="currentColor" />
          <circle cx="11.7" cy="11.6" r="1.3" fill="currentColor" />
        </symbol>
        {/* contract kinds */}
        <symbol id={`${WORLD_SPRITE_ID}-pool`} viewBox="0 0 16 16">
          <circle cx="5.8" cy="8" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="10.2" cy="8" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </symbol>
        <symbol id={`${WORLD_SPRITE_ID}-perp`} viewBox="0 0 16 16">
          <path d="M2.6 12.6V7.4M6.2 12.6V3.6M9.8 12.6V6M13.4 12.6V9.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </symbol>
        <symbol id={`${WORLD_SPRITE_ID}-stake`} viewBox="0 0 16 16">
          <path d="M8 1.9 14.1 8 8 14.1 1.9 8z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </symbol>
        <symbol id={`${WORLD_SPRITE_ID}-cdp`} viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 2.4v11.2M2.4 8h11.2" stroke="currentColor" strokeWidth="1.4" />
        </symbol>
      </defs>
    </svg>
  );
}

export type WorldIconName =
  | "arb"
  | "lp"
  | "lend"
  | "base"
  | "chain"
  | "brain"
  | "pool"
  | "perp"
  | "stake"
  | "cdp";

export function WorldIcon({
  name,
  size = 13,
  color,
}: {
  name: WorldIconName;
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      aria-hidden="true"
      style={{ color, flexShrink: 0, display: "block" }}
    >
      <use href={`#${WORLD_SPRITE_ID}-${name}`} />
    </svg>
  );
}

/** A competitor's glyph: what kind of strategy it is, with the benchmark set apart. */
export function agentIcon(
  category: "arb" | "mm" | "dir",
  baseline: boolean,
): WorldIconName {
  if (baseline) return "base";
  return category === "arb" ? "arb" : category === "mm" ? "lp" : "lend";
}

/** A contract's glyph: what kind of venue it is. */
export function venueIcon(
  kind: "pool" | "perp" | "lending" | "stake" | "cdp",
): WorldIconName {
  return kind === "lending" ? "lend" : kind;
}
