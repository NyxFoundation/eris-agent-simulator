export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
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

// Global default (backward compatible: same behavior as the old nextFairPrice).
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

// Salt that separates the price RNG per asset (ADR 0013). WETH is salt 0 = Rng(seed) itself
// (byte-identical to the existing run's WETH price path). Other bases get an independent path from a
// deterministic symbol-derived salt. An independent Rng per asset = 0 inter-asset correlation (v1). To
// add correlation you would consolidate onto a shared Rng, but that changes WETH's consumption
// sequence (breaking backward compatibility), so it is not done by default.
function assetPriceSalt(symbol: string): number {
  if (symbol === "WETH") return 0;
  let h = 0x9e_37_79_b9;
  for (let i = 0; i < symbol.length; i++) {
    h = (Math.imul(h ^ symbol.charCodeAt(i), 0x01_00_01_93) >>> 0) >>> 0;
  }
  return h >>> 0;
}

// Price-only Rng for a base symbol. WETH is Rng(seed) (same as before). Other bases are independent via a derived seed.
export function priceRngForAsset(seed: number, symbol: string): Rng {
  return new Rng((seed ^ assetPriceSalt(symbol)) >>> 0);
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
