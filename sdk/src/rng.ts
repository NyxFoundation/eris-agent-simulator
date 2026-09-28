// murmur3's 32-bit finalizer: every input bit reaches every output bit, so inputs 1 apart come out
// unrelated. A bijection on 32 bits, so it never merges two seeds into one stream.
export function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// FNV-1a over a string: how a named salt becomes a number.
export function fnv1a32(text: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 0x01_00_01_93);
  return h >>> 0;
}

export class Rng {
  private state: number;

  // The raw state, used as given. A caller holding a run seed wants `Rng.fromSeed` instead: this
  // constructor is for a key that is already hashed (an FNV digest of an actor key, say).
  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  // The Rng a consumer derives from a run seed: `mix32(seed ^ salt)`, with a string salt hashed by
  // FNV-1a. Every consumer names its own salt, so no two of them share a stream.
  //
  // Why not `new Rng(seed)`: this is an LCG, so seeds Δ apart start a·Δ/2³² apart -- the whole of
  // seeds 1-200 opened inside [0.236, 0.314), and every later draw kept a fixed offset from the same
  // draw of the seed Δ away (step-by-step correlation 0.998, 0.505, -0.295, 0.786, ... for Δ = 1).
  // XORing a constant salt in does not help: it keeps nearby seeds nearby. The hash does.
  // scripts/measureSeedCorrelation.ts has the numbers per consumer.
  static fromSeed(seed: number, salt: number | string = 0): Rng {
    const s = typeof salt === "string" ? fnv1a32(salt) : salt >>> 0;
    return new Rng(mix32((seed ^ s) >>> 0));
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(minInclusive: number, maxExclusive: number): number {
    return (
      Math.floor(this.next() * (maxExclusive - minInclusive)) + minInclusive
    );
  }

  bool(): boolean {
    return this.next() >= 0.5;
  }

  // Standard normal (Box-Muller). Used for lognormal sizes and continuous noise.
  gaussian(): number {
    // next() is [0,1). Add a lower bound to avoid log(0) at u1=0.
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // Lognormal sample with mean `mean` and σ `sigma` (positive values. Used for heavy-tailed order sizes. amm-challenge retail).
  // Setting mu = ln(mean) − σ²/2 makes the expected value equal to mean.
  lognormal(mean: number, sigma: number): number {
    if (!(mean > 0)) return 0;
    const mu = Math.log(mean) - 0.5 * sigma * sigma;
    return Math.exp(mu + sigma * this.gaussian());
  }

  // Poisson sample with mean lambda (arrival count. Knuth's method. For flow use assuming small lambda).
  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0;
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }
}

function floatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Price model (ADR 0003 discrimination. sim-loop problem: removing directional β).
// The old model was a geometric random walk with drift → each seed picks up a trend, and that
// cumulative directional exposure (β) dominates PnL, making "random trading ≈ smart arbitrage" so no
// skill difference emerged. Making it mean-reverting (OU type) and pulling back to the anchor returns
// the price near its start by run end → no money from direction, leaving only the arbitrage skill (α)
// of predicting the gap between pool and fair. Tunable via env.
const PRICE_VOLATILITY = floatEnv(process.env.ERIS_PRICE_VOLATILITY, 0.004);
const PRICE_REVERT_KAPPA = floatEnv(process.env.ERIS_PRICE_REVERT_KAPPA, 0.02);
const PRICE_DRIFT = floatEnv(process.env.ERIS_PRICE_DRIFT, 0);

// OU parameters for a single asset (ADR 0013).
export type OuParams = { volatility: number; kappa: number; drift: number };

// Legacy env-driven accessors. The run's parameters now live in SimConfig (`config.ou`, from the
// YAML `market.*` section; see readOuParams in config.ts), because the YAML loader builds a source
// map rather than mutating process.env and so could never reach the constants above. The
// coordinator passes config.ou explicitly; these remain only as the default for a caller that
// passes no params, and they read process.env, which the config path deliberately does not.
//
// Prefer passing params. A caller that forgets gets the module defaults with no error -- e.g. the
// cex-drift regime's drift silently becoming 0. ERIS_PRICE_* is listed in RETIRED_CONFIG_ENV so a
// stale environment at least announces itself.
export function globalOuParams(): OuParams {
  return {
    volatility: PRICE_VOLATILITY,
    kappa: PRICE_REVERT_KAPPA,
    drift: PRICE_DRIFT,
  };
}

// Per-asset OU parameters. Set individually via env suffix (e.g. ERIS_PRICE_VOLATILITY_WBTC),
// falling back to the global value when unset. vol/kappa/drift can be split per symbol.
export function ouParamsForSymbol(symbol: string): OuParams {
  const sfx = symbol.toUpperCase();
  return {
    volatility: floatEnv(
      process.env[`ERIS_PRICE_VOLATILITY_${sfx}`],
      PRICE_VOLATILITY,
    ),
    kappa: floatEnv(
      process.env[`ERIS_PRICE_REVERT_KAPPA_${sfx}`],
      PRICE_REVERT_KAPPA,
    ),
    drift: floatEnv(process.env[`ERIS_PRICE_DRIFT_${sfx}`], PRICE_DRIFT),
  };
}

// anchor is the run's reference price (usually the initial pool price). The further current is from
// anchor, the stronger the pull back. If params is omitted, use the global default (byte-identical to the old behavior).
export function nextFairPrice(
  current: number,
  rng: Rng,
  anchor: number,
  params?: OuParams,
): number {
  const p = params ?? globalOuParams();
  const shock = (rng.next() - 0.5) * 2 * p.volatility;
  const revert = (p.kappa * (anchor - current)) / current;
  return Math.max(100, current * (1 + p.drift + revert + shock));
}

// The price path's Rng for one base (ADR 0013): its own stream per symbol, so adding a base never
// moves another's path, and inter-asset correlation is 0 (v1). To add correlation you would draw
// every base from one shared Rng. WETH goes through the same derivation as every other base; it used
// to be `Rng(seed)` itself, which at volatility 0.004 put its first shock in [-21, -15] bps on every
// seed from 1 to 200 (and WBTC's, from a symbol salt XORed in, in [+29, +37] bps).
export function priceRngForAsset(seed: number, symbol: string): Rng {
  return Rng.fromSeed(seed, `price:${symbol}`);
}

export type MultiAssetPriceState = Record<string, number>;

// Advance the OU of multiple bases with an independent Rng per asset (ADR 0013). order is the
// registration order (WETH first) and only preserves output determinism. Each asset has an
// independent Rng, so adding bases leaves WETH's price path unchanged.
export function nextFairPrices(
  current: MultiAssetPriceState,
  rngBy: Record<string, Rng>,
  anchors: MultiAssetPriceState,
  order: string[],
  paramsBy?: Record<string, OuParams>,
): MultiAssetPriceState {
  const out: MultiAssetPriceState = {};
  for (const sym of order) {
    out[sym] = nextFairPrice(
      current[sym],
      rngBy[sym],
      anchors[sym],
      paramsBy?.[sym] ?? ouParamsForSymbol(sym),
    );
  }
  return out;
}
