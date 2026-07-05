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

export type StressEventType = "spike" | "crash";

// Event spec given via env (ERIS_STRESS_EVENTS). Ranges are given, not values.
export type StressEventConfig = {
  type: StressEventType;
  // ADR 0013: the base the event targets (default WETH). Lets crash/spike apply to WBTC etc.
  base?: TokenSymbol;
  // Deviation width of the price multiplier. spike acts as +, crash as −. The seed picks from [min,max].
  magnitudeRange: [number, number];
  // Fraction of run length for the event start position [min,max]. The seed picks.
  windowFrac: [number, number];
  // Length of each trapezoid segment (block count; fixed).
  rampBlocks: number;
  holdBlocks: number;
  decayBlocks: number;
};

// Event resolved by the seed (blockIndex is 0-based from runStart).
export type ResolvedStressEvent = {
  type: StressEventType;
  base: string; // target base (default WETH)
  magnitude: number;
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
      const span = c.rampBlocks + c.holdBlocks + c.decayBlocks;
      // Clamp startBlock so the window fits inside the run window (scoring history depth; event window ⊂ run window).
      const maxStart = Math.max(0, runBlocks - span);
      const startBlock = Math.max(
        0,
        Math.min(Math.round(startFrac * runBlocks), maxStart),
      );
      return {
        type: c.type,
        base: c.base ?? "WETH",
        magnitude,
        startBlock,
        rampBlocks: c.rampBlocks,
        holdBlocks: c.holdBlocks,
        decayBlocks: c.decayBlocks,
        endBlock: startBlock + span,
      };
    });
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  // The in-window event at this blockIndex (if several overlap, the first one). For visualization/logging.
  activeEventAt(blockIndex: number): ResolvedStressEvent | null {
    for (const ev of this.events) {
      if (blockIndex >= ev.startBlock && blockIndex < ev.endBlock) return ev;
    }
    return null;
  }

  // The overlay at this blockIndex. Overlapping events compose their multipliers multiplicatively
  // (if non-overlapping, each event appears as-is).
  at(blockIndex: number): OverlayState {
    const baseMults: Record<string, number> = {};
    for (const ev of this.events) {
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
  if (o.type !== "spike" && o.type !== "crash") {
    throw new Error(`${label}.type must be "spike" or "crash"`);
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
    },
  );
  const windowFrac = parseRange(o.windowFrac, `${label}.windowFrac`, {
    min: 0,
    max: 1,
  });
  const rampBlocks = parseNonNegInt(o.rampBlocks, `${label}.rampBlocks`);
  const holdBlocks = parseNonNegInt(o.holdBlocks, `${label}.holdBlocks`);
  const decayBlocks = parseNonNegInt(o.decayBlocks, `${label}.decayBlocks`);
  if (rampBlocks + holdBlocks + decayBlocks <= 0) {
    throw new Error(
      `${label} must have a positive total window (ramp+hold+decay)`,
    );
  }
  return {
    type: o.type,
    base: typeof o.base === "string" ? o.base : undefined,
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
  bounds: { min?: number; max?: number; exclusiveMin?: boolean },
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
  if (bounds.max !== undefined && hi > bounds.max)
    throw new Error(`${label} max must be <= ${bounds.max}`);
  return [lo, hi];
}

function parseNonNegInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}
