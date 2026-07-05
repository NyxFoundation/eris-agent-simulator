// Schedule of vulnerability-appearance events (malicious pools) (ADR 0014 §2).
//
// Same philosophy as ADR 0009's EventSchedule: config is given **ranges** rather than fixed values, and the
// appearance window, pool count, rigged fraction, bait strength (bait), skim fraction (rug), and dry-run
// evasion threshold are **deterministically derived from SEED** (prevents memorizing constants and measures
// generalization; ADR 0004). It uses an independent Rng (VULN_SEED_SALT) that does not collide with the price
// main path, flow, or stress, so it does not break the consumption sequence of existing runs and reproducibility
// is maintained via SEED. A pure-function class that never touches the chain or I/O (target of test/vulnEvents.test.ts).
//
// Design:
//   - Pools "spring up" at the event's startBlock (= determined by SEED as a fraction of run length). The
//     coordinator funds the pool at this blockIndex, making a gap from fair (opportunity) appear (the discovery
//     bait of §3).
//   - Each event generates a mix of N pools. The riggedFrac share are RiggedAMM (traps), the rest are SimpleAMM
//     (safe genuine arb). This generalizes the "66 fake pools" as a SEED-derived mix of N pools.
//   - The trap is on the pool contract side, not the token (they trade real tokens WETH/WBTC/USDC). So trading
//     only known tokens cannot avoid it; the only recourse is to audit the contract (ADR 0014 §1).
import { Rng } from "@eris/sdk/rng.js";

export type VulnEventType = "rigged-pool";

// One event spec given via config (ERIS_VULN_EVENTS). Ranges are given, not values.
export type VulnEventConfig = {
  type: VulnEventType;
  // Fraction of run length for the appearance position [min,max]. The seed picks.
  windowFrac: [number, number];
  // Number of new pools to emit at once [min,max] (generalizes "66"). Integer.
  poolCount: [number, number];
  // Of those, the rigged fraction [min,max] (the rest are safe genuine arb).
  riggedFrac: [number, number];
  // How many bps more attractive to make it look vs fair (the lure) [min,max].
  baitBps: [number, number];
  // The fraction the rigged pool skims, in bps [min,max].
  rugBps: [number, number];
  // Dry-run evasion threshold (per-round cap ratio [min,max]). It skims only amountIn exceeding
  // this ratio × the per-round cap (small probes pass through).
  rugThresholdFrac: [number, number];
};

// One pool resolved by the seed (poolIndex unique in deploy order; blockIndex is 0-based relative to runStart).
export type ResolvedVulnPool = {
  poolIndex: number; // globally unique (corresponds to deploy order / address issuance order)
  eventIndex: number;
  base: string; // trading base (WETH / WBTC etc.). The quote is USDC-equivalent.
  rigged: boolean; // ground-truth (for scoring; not exposed on-chain / to agents)
  baitBps: number; // discount width vs fair (makes base look this much cheaper)
  rugBps: number; // skim fraction (bps; integer)
  rugThresholdFrac: number; // skim threshold as a per-round cap ratio
  startBlock: number; // funding (appearance) block index
};

export type ResolvedVulnEvent = {
  type: VulnEventType;
  eventIndex: number;
  startBlock: number;
  poolCount: number;
  riggedCount: number;
  pools: ResolvedVulnPool[];
};

// Salt for a derived seed that does not collide with the price main-path Rng(seed) / flow Rng / stress Rng(0x53545253).
const VULN_SEED_SALT = 0x56_55_4c_4e; // "VULN"

// Pure-function deterministic schedule (config + seed + runBlocks + baseSymbols → resolved pools).
export class VulnSchedule {
  readonly events: ResolvedVulnEvent[];

  constructor(
    configs: VulnEventConfig[],
    seed: number,
    runBlocks: number,
    // Candidate trading bases (the coordinator passes the active bases; tests default to ["WETH"]).
    baseSymbols: string[] = ["WETH"],
  ) {
    if (configs.length > 0 && runBlocks <= 0) {
      // The window is determined by a fraction of run length, so a fixed-length run (run.blocks>0) is required.
      throw new Error(
        "ERIS_VULN_EVENTS requires a fixed-length run: set run.blocks > 0 (ADR 0014)",
      );
    }
    const bases = baseSymbols.length > 0 ? baseSymbols : ["WETH"];
    // An Rng independent of the price main path, flow, and stress. The same SEED deterministically yields the same schedule.
    const rng = new Rng((seed ^ VULN_SEED_SALT) >>> 0);
    let poolIndex = 0;
    this.events = configs.map((c, eventIndex) => {
      // Consumption order (the crux of determinism): poolCount → startFrac → riggedFrac → (per pool) base →
      //   baitBps → rugBps → rugThresholdFrac.
      const poolCount = Math.max(
        1,
        Math.round(lerp(c.poolCount[0], c.poolCount[1], rng.next())),
      );
      const startFrac = lerp(c.windowFrac[0], c.windowFrac[1], rng.next());
      // Keep startBlock inside the run window (scoring history depth; window ⊂ run window). Clamp at runBlocks-1
      // because funding may not take effect on the final block.
      const maxStart = Math.max(0, runBlocks - 1);
      const startBlock = Math.max(
        0,
        Math.min(Math.round(startFrac * runBlocks), maxStart),
      );
      const riggedFracVal = lerp(c.riggedFrac[0], c.riggedFrac[1], rng.next());
      const riggedCount = Math.max(
        0,
        Math.min(poolCount, Math.round(poolCount * riggedFracVal)),
      );
      // To make rigged/safe **position-independent**, Fisher–Yates shuffle riggedCount true values and assign
      // them to each slot (kills the side-channel that could infer classification from deploy order / allPools
      // order; determinism is maintained via seed).
      const riggedFlags = Array.from(
        { length: poolCount },
        (_, i) => i < riggedCount,
      );
      for (let i = poolCount - 1; i > 0; i--) {
        const j = rng.int(0, i + 1);
        const tmp = riggedFlags[i];
        riggedFlags[i] = riggedFlags[j];
        riggedFlags[j] = tmp;
      }
      const pools: ResolvedVulnPool[] = [];
      for (let p = 0; p < poolCount; p++) {
        const base = bases[rng.int(0, bases.length)];
        const baitBps = Math.round(
          lerp(c.baitBps[0], c.baitBps[1], rng.next()),
        );
        const rugBps = Math.round(lerp(c.rugBps[0], c.rugBps[1], rng.next()));
        const rugThresholdFrac = lerp(
          c.rugThresholdFrac[0],
          c.rugThresholdFrac[1],
          rng.next(),
        );
        pools.push({
          poolIndex: poolIndex++,
          eventIndex,
          base,
          rigged: riggedFlags[p],
          baitBps,
          rugBps,
          rugThresholdFrac,
          startBlock,
        });
      }
      return {
        type: c.type,
        eventIndex,
        startBlock,
        poolCount,
        riggedCount,
        pools,
      };
    });
  }

  hasEvents(): boolean {
    return this.events.length > 0;
  }

  // Returns all pools flattened in deploy order (ascending poolIndex).
  pools(): ResolvedVulnPool[] {
    return this.events.flatMap((e) => e.pools);
  }

  // The pools that "spring up" (get funded) at this blockIndex. The coordinator calls this every block.
  poolsStartingAt(blockIndex: number): ResolvedVulnPool[] {
    return this.pools().filter((p) => p.startBlock === blockIndex);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Parse and validate ERIS_VULN_EVENTS (a JSON array). Empty/unset yields [].
// Strictly checks the range spec, and misconfiguration fails fast before the run starts (same shape as parseStressEvents).
export function parseVulnEvents(json: string | undefined): VulnEventConfig[] {
  if (json === undefined || json.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `ERIS_VULN_EVENTS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ERIS_VULN_EVENTS must be a JSON array");
  }
  return parsed.map((raw, i) => parseOne(raw, i));
}

function parseOne(raw: unknown, i: number): VulnEventConfig {
  const label = `ERIS_VULN_EVENTS[${i}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  if (o.type !== "rigged-pool") {
    throw new Error(`${label}.type must be "rigged-pool"`);
  }
  const windowFrac = parseRange(o.windowFrac, `${label}.windowFrac`, {
    min: 0,
    max: 1,
  });
  const poolCount = parseRange(o.poolCount, `${label}.poolCount`, {
    min: 1,
    max: 64, // fail-fast because too large a value silently hangs setup's sequential deploy
    integer: true,
  });
  const riggedFrac = parseRange(o.riggedFrac, `${label}.riggedFrac`, {
    min: 0,
    max: 1,
  });
  // baitBps is the discount width vs fair. At >=10000, poolPrice=fair·(1−bait)<=0 breaks the reserve
  // computation (negative bigint → funding crash), so cap it.
  const baitBps = parseRange(o.baitBps, `${label}.baitBps`, {
    min: 0,
    max: 9_000,
  });
  const rugBps = parseRange(o.rugBps, `${label}.rugBps`, {
    min: 0,
    exclusiveMin: true,
    max: 10_000,
  });
  // rugThresholdFrac is the skim threshold (per-round cap ratio). At 0 the threshold is 0 = unconditional rig,
  // which breaks the design intent of a conditional rig where "small probes pass through" (the rationale that
  // makes LLM auditing load-bearing), so require greater than 0.
  const rugThresholdFrac = parseRange(
    o.rugThresholdFrac,
    `${label}.rugThresholdFrac`,
    { min: 0, exclusiveMin: true, max: 1 },
  );
  return {
    type: "rigged-pool",
    windowFrac,
    poolCount,
    riggedFrac,
    baitBps,
    rugBps,
    rugThresholdFrac,
  };
}

function parseRange(
  value: unknown,
  label: string,
  bounds: {
    min?: number;
    max?: number;
    exclusiveMin?: boolean;
    integer?: boolean;
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
  if (bounds.integer && (!Number.isInteger(lo) || !Number.isInteger(hi))) {
    throw new Error(`${label} must be a pair of integers`);
  }
  if (bounds.min !== undefined) {
    if (bounds.exclusiveMin ? lo <= bounds.min : lo < bounds.min)
      throw new Error(
        `${label} min must be ${bounds.exclusiveMin ? ">" : ">="} ${bounds.min}`,
      );
  }
  if (bounds.max !== undefined && hi > bounds.max)
    throw new Error(`${label} max must be <= ${bounds.max}`);
  return [lo, hi];
}
