// Market stress event overlay (ADR 0009 §1-3).
//
// Pure functions that advance the OU price path (base) as-is and derive the effective price by layering a
// SEED-randomized deterministic event overlay on top. Outside the window it keeps β≈0 as before
// (not polluting base); only inside the window does a sharp deviation (spike/crash) arise. The effective
// price propagates consistently to the PriceFeed, the Aave WETH oracle, GMX, and scoring (base/effective
// separation; does not compromise ADR 0007).
//
// Design (the central argument of ADR 0009):
//   - Events are trapezoids (ramp->hold->decay) expressed as a WETH multiplier (wethMult). Because an
//     instantaneous jump interacts poorly with the 1-block delay of oracle updates, we leave room for
//     everyone to react equally with a 1-block lag (fairness).
//   - config gives ranges rather than fixed values, and the actual timing/magnitude are deterministically
//     derived from SEED (prevents memorizing constants and measures generalization; ADR 0004). It uses an
//     Rng independent of the price main path and flow, so the price RNG consumption sequence is not
//     disturbed (reproducibility is maintained via SEED).
//   - It also keeps usdcPx returnable for depeg (v1 is always 1; made variable in phase 2).
import { Rng } from "@eris/sdk/rng.js";
import type { TokenSymbol } from "@eris/sdk/types.js";

// spike / crash distort a base's price through the overlay. The others are different in kind:
//   lstSlash       a one-shot staking penalty applied to the LST vault (issue #38 phase 2); the
//                  exchange rate is permanently lower afterwards
//   whale          a single large market order that moves the mid (ADR 0017 regime 3). Unlike crash,
//                  the fair price does not move at all -- the pool is knocked away from an unchanged
//                  fair, which is the opposite direction of dislocation and a different trade to find
//   liquidityPull  seeded pool depth is withdrawn for the length of a window and put back afterwards
//                  (issue #52). Neither a price multiplier nor a one-shot: it is a *state* the
//                  coordinator holds for the window, so it has a trapezoid like spike/crash but the
//                  envelope drives a target depth instead of a price. Composed with crash on the
//                  same window it is what makes regime 6 a crash rather than a larger opportunity --
//                  the gap says what is on offer, the depth says how much of it anyone can take.
// They share this config section because from a run's point of view they are the same thing: a
// seed-placed shock the agents have to survive.
export type StressEventType =
  "spike" | "crash" | "lstSlash" | "whale" | "liquidityPull";

// How the run consumes each type:
//   overlay  a multiplier layered on the fair price every block of its window (`at()`)
//   point    executed once, on the block it lands on (`pointEventsAt()`)
//   state    a target the coordinator holds the venue at for the window (`depthMultiplierAt()`)
//
// A total Record rather than one opt-in Set per consumer: with separate Sets, adding a sixth type
// and forgetting one of them compiles, typechecks, and produces a schedule that logs itself and then
// does nothing. That is not hypothetical -- `pointEventsAt` shipped once with exactly that shape of
// hole (see the note on the caught-up range below). Here the compiler demands the decision.
const EVENT_KIND: Record<StressEventType, "overlay" | "point" | "state"> = {
  spike: "overlay",
  crash: "overlay",
  lstSlash: "point",
  whale: "point",
  liquidityPull: "state",
};

const isPointEvent = (type: StressEventType): boolean =>
  EVENT_KIND[type] === "point";
const isPriceOverlay = (type: StressEventType): boolean =>
  EVENT_KIND[type] === "overlay";

// Which way a whale trades. "random" (the default) lets the seed pick, which is what keeps the
// direction from being memorizable across a published regime's seeds.
export type WhaleSide = "buy" | "sell" | "random";

// Event spec given via env (ERIS_STRESS_EVENTS). Ranges are given, not values.
export type StressEventConfig = {
  type: StressEventType;
  // ADR 0013: the base the event targets (default WETH). Lets crash/spike apply to WBTC etc.
  base?: TokenSymbol;
  // Deviation width of the price multiplier. spike acts as +, crash as −. The seed picks from [min,max].
  // For lstSlash this is the fraction of the staking pool burnt (0.02 = a 2% slash).
  // For liquidityPull this is the fraction of the seeded pool depth withdrawn at the top of the
  // trapezoid (0.5 = half the book gone while the window holds).
  // For whale this is the order size in whole base units (30 = a 30 WETH market order). Absolute
  // rather than a fraction because what matters is the size against pool depth, and depth is a
  // property of the deployed venue, not of this config.
  magnitudeRange: [number, number];
  // whale only: which way it trades. Default "random" = the seed decides.
  side?: WhaleSide;
  // whale only: the venue it hits. Default "uniswap" (the deepest pool, so the size has to be real
  // to move it).
  venue?: "uniswap" | "balancer" | "curve";
  // Fraction of run length for the event start position [min,max]. The seed picks.
  windowFrac: [number, number];
  // Start where the first event of this type starts, instead of drawing an independent position.
  // windowFrac is still required and still drawn (so the schedule stays a pure function of the
  // event list) -- the draw is simply not used for the start.
  //
  // This exists because "same range" is not "same window": two events sampling [0.25, 0.7] of a
  // 360-block run land ~160 blocks apart on average, so a liquidityPull configured alongside a crash
  // would almost never thin the book while the price is gapping. Issue #52's composition is a
  // property of the pair, not of either event, and it has to be stated rather than hoped for.
  alignWith?: StressEventType;
  // Length of each trapezoid segment (block count; fixed). Not applicable to lstSlash, which is
  // instantaneous, so they default to 0 there.
  rampBlocks: number;
  holdBlocks: number;
  decayBlocks: number;
};

// A slash is instantaneous, so its window is the single block it lands on.
const POINT_EVENT_SPAN = 1;

// Event resolved by the seed (blockIndex is 0-based from runStart).
export type ResolvedStressEvent = {
  type: StressEventType;
  base: string; // target base (default WETH)
  magnitude: number;
  // whale only: resolved from config.side, with "random" collapsed to a concrete side by the seed.
  side?: "buy" | "sell";
  venue?: "uniswap" | "balancer" | "curve";
  startBlock: number;
  rampBlocks: number;
  holdBlocks: number;
  decayBlocks: number;
  endBlock: number; // startBlock + ramp + hold + decay (this value is not included in the window)
};

// The overlay returned by at(blockIndex). effective[base] = baseFair[base] * baseMults[base].
// wethMult is for backward compatibility (= baseMults["WETH"]). usdcPx is unused in v1.
export type OverlayState = {
  wethMult: number;
  usdcPx: number;
  baseMults: Record<string, number>;
};

// Salt for a derived seed that does not collide with the price main-path Rng (seed) or flow Rng (flowSeed).
const STRESS_SEED_SALT = 0x53_54_52_53; // "STRS"

// Trapezoid envelope e(blockIndex) ∈ [0,1]:
//   ramp:  0 → 1 (rises over rampBlocks)
//   hold:  1 (holdBlocks)
//   decay: 1 → 0 (returns over decayBlocks)
//   outside window: 0
// spike is wethMult = 1 + m·e, crash is 1 − m·e. At e=1 the deviation is at most ±m.
function envelope(ev: ResolvedStressEvent, blockIndex: number): number {
  const t = blockIndex - ev.startBlock;
  if (t < 0) return 0;
  const { rampBlocks: r, holdBlocks: h, decayBlocks: d } = ev;
  if (t < r) return r === 0 ? 1 : (t + 1) / r; // rise (takes effect from the first window block)
  if (t < r + h) return 1; // hold
  if (t < r + h + d) return d === 0 ? 1 : 1 - (t - (r + h) + 1) / d; // decay
  return 0; // outside window (from endBlock onward)
}

// Pure-function deterministic schedule (config + seed + runBlocks → at(blockIndex)).
// Unit-tested. Never touches the chain or I/O.
export class EventSchedule {
  readonly events: ResolvedStressEvent[];

  constructor(configs: StressEventConfig[], seed: number, runBlocks: number) {
    if (configs.length > 0 && runBlocks <= 0) {
      // The window is determined by a fraction of run length, so a fixed-length run (ERIS_RUN_BLOCKS>0) is required.
      throw new Error(
        "ERIS_STRESS_EVENTS requires a fixed-length run: set ERIS_RUN_BLOCKS > 0 (ADR 0009)",
      );
    }
    // An Rng independent of the price main path and flow. The same SEED deterministically yields the same schedule.
    const rng = new Rng((seed ^ STRESS_SEED_SALT) >>> 0);
    this.events = configs.map((c) => {
      const magnitude = lerp(
        c.magnitudeRange[0],
        c.magnitudeRange[1],
        rng.next(),
      );
      const startFrac = lerp(c.windowFrac[0], c.windowFrac[1], rng.next());
      const span = isPointEvent(c.type)
        ? POINT_EVENT_SPAN
        : c.rampBlocks + c.holdBlocks + c.decayBlocks;
      // Clamp startBlock so the window fits inside the run window (scoring history depth; event window ⊂ run window).
      const maxStart = Math.max(0, runBlocks - span);
      const startBlock = Math.max(
        0,
        Math.min(Math.round(startFrac * runBlocks), maxStart),
      );
      // Draw the side for every whale regardless of config so the RNG consumption stays a pure
      // function of the event list -- making it conditional would let one event's `side: buy` shift
      // the schedule of every event after it.
      const sideDraw = c.type === "whale" ? rng.next() : undefined;
      const side =
        c.type === "whale"
          ? c.side === undefined || c.side === "random"
            ? sideDraw! < 0.5
              ? ("buy" as const)
              : ("sell" as const)
            : c.side
          : undefined;
      return {
        type: c.type,
        base: c.base ?? "WETH",
        magnitude,
        ...(side !== undefined ? { side } : {}),
        ...(c.type === "whale" ? { venue: c.venue ?? "uniswap" } : {}),
        startBlock,
        rampBlocks: c.rampBlocks,
        holdBlocks: c.holdBlocks,
        decayBlocks: c.decayBlocks,
        endBlock: startBlock + span,
      };
    });

    // Second pass: move the events that follow another one onto its start. Done after every draw so
    // the RNG consumption stays a pure function of the event list -- an alignment must not shift the
    // schedule of the events around it.
    configs.forEach((c, i) => {
      if (c.alignWith === undefined) return;
      const anchorIndex = this.events.findIndex(
        (ev, j) => j !== i && ev.type === c.alignWith,
      );
      if (anchorIndex < 0) {
        throw new Error(
          `stress event[${i}] has alignWith: "${c.alignWith}", but no event of that type is configured`,
        );
      }
      // Chains would depend on the order this pass happens to visit the events (following an anchor
      // that is itself moved later reads its pre-alignment start), so they are refused rather than
      // resolved half the time.
      if (configs[anchorIndex].alignWith !== undefined) {
        throw new Error(
          `stress event[${i}] aligns with event[${anchorIndex}], which is itself aligned; chained alignWith is not supported`,
        );
      }
      const anchor = this.events[anchorIndex];
      const ev = this.events[i];
      const span = ev.endBlock - ev.startBlock;
      // A follower with a longer trapezoid than its anchor cannot start where the anchor does when
      // the anchor sits near the end of the run. Silently sliding it earlier would un-align the pair
      // -- which is the single thing alignWith exists to guarantee -- so this is a config error.
      if (anchor.startBlock + span > runBlocks) {
        throw new Error(
          `stress event[${i}] aligns with a ${c.alignWith} at block ${anchor.startBlock}, but its own ` +
            `window is ${span} blocks and the run is ${runBlocks}: shorten it, or lower windowFrac's ` +
            "upper bound (a heavily shortened run, e.g. --blocks on a smoke test, can hit this on " +
            "some seeds where the regime's own length does not)",
        );
      }
      this.events[i] = {
        ...ev,
        startBlock: anchor.startBlock,
        endBlock: anchor.startBlock + span,
      };
    });
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  // Whether the run needs the depth-withdrawal machinery at all (issue #52). The coordinator only
  // discovers and tracks the seeded LP positions when this is true, so an ordinary run pays nothing.
  hasLiquidityPull(): boolean {
    return this.events.some((ev) => ev.type === "liquidityPull");
  }

  // The bases a liquidityPull targets. The coordinator needs them at setup, before any window opens,
  // to fail fast on a venue it cannot withdraw from.
  liquidityPullBases(): string[] {
    return [
      ...new Set(
        this.events
          .filter((ev) => ev.type === "liquidityPull")
          .map((ev) => ev.base),
      ),
    ];
  }

  // The in-window event at this blockIndex, of any kind (if several overlap, the first one). For
  // visualization/logging. Callers that mean "is the price dislocated right now" want
  // activePriceEventAt: since issue #52 a window can be open with the price untouched.
  activeEventAt(blockIndex: number): ResolvedStressEvent | null {
    return this.activeIn(blockIndex, () => true);
  }

  // The in-window *price* event at this blockIndex. A liquidityPull window does not count: it moves
  // depth, not price, so treating it as an active event makes consumers gated on dislocation (the
  // victim health-factor reads) fire on blocks where nothing has moved -- and its trapezoid is
  // deliberately longer than the crash's, so those blocks exist by design.
  activePriceEventAt(blockIndex: number): ResolvedStressEvent | null {
    return this.activeIn(blockIndex, isPriceOverlay);
  }

  private activeIn(
    blockIndex: number,
    accept: (type: StressEventType) => boolean,
  ): ResolvedStressEvent | null {
    for (const ev of this.events) {
      if (!accept(ev.type)) continue;
      if (blockIndex >= ev.startBlock && blockIndex < ev.endBlock) return ev;
    }
    return null;
  }

  // The overlay at this blockIndex. Overlapping events compose their multipliers multiplicatively
  // (if non-overlapping, each event appears as-is).
  // Events applied once rather than as an overlay (currently the LST slash), for every index in
  // the caught-up range fromIndex..toIndex.
  //
  // A range rather than a single index because the coordinator skips block notifications while it
  // is still processing the previous one (`if (processing) return`), and every other consumer here
  // already compensates the same way (keeperTask, vulnTask, logBlock all take fromBlock..toBlock).
  // Matching one index exactly meant a dropped block silently swallowed the whole stress axis: the
  // run logged its schedule and then never slashed.
  pointEventsAt(fromIndex: number, toIndex = fromIndex): ResolvedStressEvent[] {
    return this.events.filter(
      (ev) =>
        isPointEvent(ev.type) &&
        ev.startBlock >= fromIndex &&
        ev.startBlock <= toIndex,
    );
  }

  // Fraction of the seeded pool depth that should still be in the pool at this block, per base
  // (1 = untouched). The coordinator reconciles the venue against this every block rather than
  // removing once and restoring once: the target is a pure function of blockIndex, so a dropped
  // block notification costs one block of lag instead of stranding the pool at the wrong depth.
  // Overlapping pulls compose multiplicatively, the same way overlapping price events do.
  depthMultiplierAt(blockIndex: number): Record<string, number> {
    const byBase: Record<string, number> = {};
    for (const ev of this.events) {
      if (ev.type !== "liquidityPull") continue;
      const e = envelope(ev, blockIndex);
      if (e === 0) continue;
      const cur = byBase[ev.base] ?? 1;
      byBase[ev.base] = cur * (1 - ev.magnitude * e);
    }
    return byBase;
  }

  at(blockIndex: number): OverlayState {
    const baseMults: Record<string, number> = {};
    for (const ev of this.events) {
      if (!isPriceOverlay(ev.type)) continue; // executed, not a price distortion
      const e = envelope(ev, blockIndex);
      if (e === 0) continue;
      const sign = ev.type === "crash" ? -1 : 1;
      const cur = baseMults[ev.base] ?? 1;
      baseMults[ev.base] = cur * (1 + sign * ev.magnitude * e);
    }
    const wethMult = baseMults.WETH ?? 1;
    return { wethMult, usdcPx: 1, baseMults };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Parse and validate ERIS_STRESS_EVENTS (a JSON array). Empty/unset yields [].
// Strictly checks the "give ranges, not values" spec, and misconfiguration fails fast before the run starts.
export function parseStressEvents(
  json: string | undefined,
): StressEventConfig[] {
  if (json === undefined || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `ERIS_STRESS_EVENTS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ERIS_STRESS_EVENTS must be a JSON array");
  }
  return parsed.map((raw, i) => parseOne(raw, i));
}

function parseOne(raw: unknown, i: number): StressEventConfig {
  const label = `ERIS_STRESS_EVENTS[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  if (
    o.type !== "spike" &&
    o.type !== "crash" &&
    o.type !== "lstSlash" &&
    o.type !== "whale" &&
    o.type !== "liquidityPull"
  ) {
    throw new Error(
      `${label}.type must be "spike", "crash", "lstSlash", "whale" or "liquidityPull"`,
    );
  }
  if (o.alignWith !== undefined) {
    if (
      o.alignWith !== "spike" &&
      o.alignWith !== "crash" &&
      o.alignWith !== "lstSlash" &&
      o.alignWith !== "whale" &&
      o.alignWith !== "liquidityPull"
    ) {
      throw new Error(`${label}.alignWith must be a stress event type`);
    }
    // Following your own type is ambiguous the moment there are two of them, and it says nothing:
    // the point of alignWith is to tie two *different* shocks to one moment.
    if (o.alignWith === o.type)
      throw new Error(`${label}.alignWith must name a different event type`);
  }
  if (o.side !== undefined) {
    if (o.type !== "whale")
      throw new Error(`${label}.side only applies to type "whale"`);
    if (o.side !== "buy" && o.side !== "sell" && o.side !== "random")
      throw new Error(`${label}.side must be "buy", "sell" or "random"`);
  }
  if (o.venue !== undefined) {
    // liquidityPull is uniswap-only in phase 1 (issue #52): each venue needs its own proportional
    // withdrawal path, so balancer/curve arrive with phase 2 rather than being silently accepted here.
    if (o.type !== "whale")
      throw new Error(`${label}.venue only applies to type "whale"`);
    if (o.venue !== "uniswap" && o.venue !== "balancer" && o.venue !== "curve")
      throw new Error(
        `${label}.venue must be "uniswap", "balancer" or "curve"`,
      );
  }
  if (o.base !== undefined && typeof o.base !== "string") {
    throw new Error(`${label}.base must be a token symbol string`);
  }
  const magnitudeRange = parseRange(
    o.magnitudeRange,
    `${label}.magnitudeRange`,
    {
      min: 0,
      exclusiveMin: true,
      // A slash is a fraction of the pool, and wiping it out entirely is not a stress event: at
      // 100% totalPooledWeth hits zero, convertToAssets falls back to its 1:1 branch, the pool's
      // rate oracle snaps back to par, and every staker is silently erased while the discount
      // reads 0. Exclusive, matching the sentence above it.
      //
      // A liquidityPull is bounded the same way and for the same reason: at 100% the pool has no
      // depth at all, every swap reverts, and the venue stops existing for the window. That is not
      // a thin book an agent has to size against -- it is an outage, and the regime is about the
      // former (issue #52: "how much of the gap can I actually take").
      ...(o.type === "lstSlash" || o.type === "liquidityPull"
        ? { max: 1, exclusiveMax: true }
        : {}),
    },
  );
  const windowFrac = parseRange(o.windowFrac, `${label}.windowFrac`, {
    min: 0,
    max: 1,
  });
  // A point event lands on one block, so the trapezoid fields do not apply and are optional there.
  const isPoint = isPointEvent(o.type);
  const rampBlocks = parseNonNegInt(
    isPoint ? (o.rampBlocks ?? 0) : o.rampBlocks,
    `${label}.rampBlocks`,
  );
  const holdBlocks = parseNonNegInt(
    isPoint ? (o.holdBlocks ?? 0) : o.holdBlocks,
    `${label}.holdBlocks`,
  );
  const decayBlocks = parseNonNegInt(
    isPoint ? (o.decayBlocks ?? 0) : o.decayBlocks,
    `${label}.decayBlocks`,
  );
  if (!isPoint && rampBlocks + holdBlocks + decayBlocks <= 0) {
    throw new Error(
      `${label} must have a positive total window (ramp+hold+decay)`,
    );
  }
  return {
    type: o.type,
    base: typeof o.base === "string" ? o.base : undefined,
    ...(o.side !== undefined ? { side: o.side as WhaleSide } : {}),
    ...(o.venue !== undefined
      ? { venue: o.venue as "uniswap" | "balancer" | "curve" }
      : {}),
    ...(o.alignWith !== undefined
      ? { alignWith: o.alignWith as StressEventType }
      : {}),
    magnitudeRange,
    windowFrac,
    rampBlocks,
    holdBlocks,
    decayBlocks,
  };
}

function parseRange(
  value: unknown,
  label: string,
  bounds: {
    min?: number;
    max?: number;
    exclusiveMin?: boolean;
    exclusiveMax?: boolean;
  },
): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new Error(`${label} must be a [min, max] pair of finite numbers`);
  }
  const [lo, hi] = value as [number, number];
  if (lo > hi) throw new Error(`${label} must have min <= max`);
  if (bounds.min !== undefined) {
    if (bounds.exclusiveMin ? lo <= bounds.min : lo < bounds.min)
      throw new Error(`${label} min must be >= ${bounds.min}`);
  }
  if (bounds.max !== undefined) {
    if (bounds.exclusiveMax ? hi >= bounds.max : hi > bounds.max)
      throw new Error(
        `${label} max must be ${bounds.exclusiveMax ? "<" : "<="} ${bounds.max}`,
      );
  }
  return [lo, hi];
}

function parseNonNegInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
