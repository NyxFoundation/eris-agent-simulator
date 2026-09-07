// Where every node on the world map sits, and how a transaction travels between two of them.
//
// The coordinates are the map's own, not the screen's: nodes are placed in a fixed 1320-wide space
// and the whole board is scaled to whatever width the page has. Everything here is arithmetic on
// that space — no measuring of rendered elements — so a wire and the dot travelling it are drawn
// from the same numbers as the boxes they connect, and a resize moves all three together.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

// The board is sized by its text, not the other way round. A node carries a name at the type
// scale's 13px -- an identity somebody reads across a room, or across a wide monitor -- and
// `cross-venue-arb` at 13px monospace is 117px before the glyph and the number beside it. Squeezing
// the name to 11px to keep the board narrow is how a map ends up legible only to whoever built it.
export const MAP_W = 1450;

const CHIP_W = 232;
const CHIP_H = 34;
const CHIP_PITCH = 38;
const CHIP_GAP = 14;
const TOP = 28;

const CHAIN_X = 534;
const CHAIN_W = 440;
// Tall enough for the six transactions the panel lists and no taller: the block is one object, and
// a panel stretched to the height of a 32-wallet column reads as a container waiting to be filled.
const CHAIN_H = 258;

const VENUE_X = 1054;
const VENUE_W = 356;
const VENUE_H = 66;
const VENUE_PITCH = 84;

/** The elbow of an agent→chain wire, and of a chain→venue one. */
export const AGENT_MID_X = 500;
export const VENUE_MID_X = 1014;

export interface WorldLayout {
  width: number;
  height: number;
  agents: Map<string, Box>;
  venues: Map<string, Box>;
  chain: Box;
}

/**
 * Agents fill two columns top-down; a field larger than 48 takes three, which is the point where a
 * two-column block is taller than the venues it has to line up with. Venues keep one column: there
 * are never many, and they are the side of the board the eye returns to.
 */
export function layoutWorld(
  agentIds: string[],
  venueIds: string[],
): WorldLayout {
  const cols = agentIds.length > 48 ? 3 : 2;
  const rows = Math.ceil(agentIds.length / cols);
  const agents = new Map<string, Box>();
  agentIds.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    agents.set(id, {
      x: 24 + col * (CHIP_W + CHIP_GAP),
      y: TOP + row * CHIP_PITCH,
      w: CHIP_W,
      h: CHIP_H,
    });
  });

  const agentsH = rows * CHIP_PITCH;
  const venuesH = venueIds.length * VENUE_PITCH;
  const height = Math.max(agentsH, venuesH, CHAIN_H) + TOP + 16;

  const venues = new Map<string, Box>();
  const venueTop = TOP + Math.max(0, (height - TOP - 16 - venuesH) / 2);
  venueIds.forEach((id, i) => {
    venues.set(id, {
      x: VENUE_X,
      y: venueTop + i * VENUE_PITCH,
      w: VENUE_W,
      h: VENUE_H,
    });
  });

  return {
    width: MAP_W,
    height,
    agents,
    venues,
    chain: {
      x: CHAIN_X,
      y: TOP + (height - TOP - 16 - CHAIN_H) / 2,
      w: CHAIN_W,
      h: CHAIN_H,
    },
  };
}

/** Right edge of `a` to left edge of `b`, turning once at `midX`. */
export function wirePoints(a: Box, b: Box, midX: number): Point[] {
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  return [
    { x: a.x + a.w, y: ay },
    { x: midX, y: ay },
    { x: midX, y: by },
    { x: b.x, y: by },
  ];
}

export function pathD(points: Point[]): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}

/** The point a fraction `k` of the way along a polyline, by length rather than by segment count. */
export function pointAt(points: Point[], k: number): Point {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
    lengths.push(d);
    total += d;
  }
  if (total === 0) return points[0];
  let want = Math.min(1, Math.max(0, k)) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (want <= lengths[i]) {
      const f = lengths[i] === 0 ? 0 : want / lengths[i];
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * f,
        y: points[i].y + (points[i + 1].y - points[i].y) * f,
      };
    }
    want -= lengths[i];
  }
  return points[points.length - 1];
}
