// measurePredictability: whether the official regimes' fair price leaves a direction an agent can
// read off what it has already seen, net of what trading on it costs.
//
//   npx tsx scripts/measurePredictability.ts [--seeds 1000] [--regimes calm,crash] [--lags 2,1]
//                                            [--ramp 2,3]
//
// The WETH fair path is stepped exactly as the coordinator steps it (core/src/realtime/coordinator.ts,
// the block loop: nextFairPrice toward the opening fair x the schedule's anchor multiplier, with the
// schedule's OU override, then the stress overlay), for many seeds of each regime. No chain, no I/O.
//
// Five probes, each a rule an agent could run on the observed fair alone. Each one sees the fair of
// block t and fills at the fair of t + L, paying COST_BPS per round trip (GMX position fee, both
// sides). A probe whose mean is far above zero is a hole: its size is bounded only by the leverage on
// offer. L is the lag between the block whose price a rule acts on and the block whose price fills it,
// and there are two (--lags, one table each):
//
//   L = 2  an agent off chain: it reads block t once t is mined, its order lands in t+1, and the GMX
//          keeper executes it in t+2
//   L = 1  a contract the agent calls every block: the price is in storage before the block's
//          transactions run (core/src/realtime/gatedMiner.ts), so the contract reads block t's fair
//          inside block t and creates the order there; the keeper executes it in t+1
//
// (--lags 0 is a fill at the price the contract read. GMX offers none; Liquity's redemption does --
// eUSD for ETH at the PriceFeed's price inside the block -- buying only, and priced by its own fee
// curve rather than bounded by leverage, so the table is an upper bound for that one route.)
//
// An r-step linear ramp leaves nothing to a lag-L follower iff r <= 1 + L, so the official gaps ramp
// over at most two blocks (ADR 0029 Amendment 5). --ramp lo,hi replaces every crash / spike entry's
// rampBlocks to measure a shape without editing the regime (it is part of the event list, so the
// draws are not the regime's own -- the distribution is).
//
//   anchor    trade toward the opening fair once it is ANCHOR_ENTRY away; close when it crosses back
//   fade      after a gap (a block move over GAP_STEP), wait for the move to stall, then trade against
//             the gap and hold FADE_HOLD blocks
//   momentum  trade with a gap the block it is first seen and close MOMENTUM_HOLD blocks later
//   trend     when the last TREND_LOOKBACK blocks moved more than TREND_K standard deviations of the
//             run's own noise, follow that way for TREND_HOLD blocks (what found the cexDrift drift)
//   usdc      hold USDC instead of WETH for the whole epoch (the static lean of the regime mix)
//
// Results are in bps of notional per epoch, with the standard error of the mean. The last row is the
// uniform mix over the regimes given, which is what an agent faces: rules §3.3 draws each epoch's
// regime independently and uniformly (issue #186). See docs/adr/0029-predictable-fair-price.md.
process.env.ERIS_LOCAL_DEPLOY = "1";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const { loadRunConfig } = await import("../core/src/runConfig.js");
const { EventSchedule, withOuOverride } = await import("../core/src/realtime/events.js");
const { nextFairPrice, priceRngForAsset, setScenarioRegime, resetScenarioRegime } = await import(
  "@eris/sdk/rng.js"
);

const COST_BPS = 10; // 0.04-0.06% per side on GMX, rounded up
const ANCHOR_ENTRY = 0.01;
// Above the largest OU shock (0.4%) by far, below the smallest ramp step (6%: 12% over two blocks;
// 3% with --ramp 4,4).
const GAP_STEP = 0.025;
const STALL = 0.01;
const FADE_HOLD = 30;
const MOMENTUM_HOLD = 3;
const OPENING_FAIR = 3000;
const TREND_LOOKBACK = 20;
const TREND_K = 2.5;
const TREND_HOLD = 20;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const SEEDS = Number(arg("seeds") ?? 1000);
const LAGS = (arg("lags") ?? "2,1").split(",").map(Number);
const RAMP = arg("ramp")?.split(",").map(Number) as [number, number] | undefined;
if (LAGS.some((l) => !Number.isInteger(l) || l < 0)) throw new Error(`--lags takes whole blocks, got ${arg("lags")}`);
if (RAMP !== undefined && (RAMP.length !== 2 || RAMP.some((r) => !Number.isInteger(r) || r < 1)))
  throw new Error(`--ramp takes lo,hi in whole blocks, got ${arg("ramp")}`);
const ROOT = resolve(import.meta.dirname, "..");
const REGIMES: string[] =
  arg("regimes")?.split(",") ??
  (parseYaml(readFileSync(resolve(ROOT, "config/scenarios/public.yaml"), "utf8")) as {
    regimes: string[];
  }).regimes;

/** The WETH fair the PriceFeed carries at blockIndex 0..runBlocks, as the coordinator derives it. */
function fairPath(
  config: ReturnType<typeof loadRunConfig>["config"],
  seed: number,
): number[] {
  const schedule = new EventSchedule(config.stressEvents, seed, config.runBlocks);
  const rng = priceRngForAsset(seed, "WETH");
  const params = config.ou.perBase.WETH ?? config.ou.global;
  let base = OPENING_FAIR;
  const path = [OPENING_FAIR];
  for (let i = 1; i <= config.runBlocks; i++) {
    base = nextFairPrice(
      base,
      rng,
      OPENING_FAIR * schedule.anchorMultiplierAt(i, "WETH"),
      withOuOverride(params, schedule.ouOverrideAt(i, "WETH")),
    );
    path.push(base * schedule.at(i).wethMult);
  }
  return path;
}

const ret = (p: number[], from: number, to: number) => p[to] / p[from] - 1;

function anchorProbe(p: number[], lag: number): number {
  const end = p.length - 1;
  let pnl = 0;
  let dir = 0;
  let entry = 0;
  for (let t = 0; t + lag <= end; t++) {
    const z = p[t] / OPENING_FAIR - 1;
    if (dir === 0 && Math.abs(z) > ANCHOR_ENTRY) {
      dir = -Math.sign(z);
      entry = t + lag;
    } else if (dir !== 0 && Math.sign(z) !== -dir) {
      pnl += dir * ret(p, entry, t + lag) - COST_BPS / 1e4;
      dir = 0;
    }
  }
  if (dir !== 0) pnl += dir * ret(p, entry, end) - COST_BPS / 1e4;
  return pnl;
}

/** Blocks where a gap is first seen: a block move over GAP_STEP after a block that had none. */
function gapOnsets(p: number[]): { t: number; dir: number }[] {
  const out: { t: number; dir: number }[] = [];
  for (let t = 2; t < p.length; t++) {
    const step = ret(p, t - 1, t);
    if (Math.abs(step) > GAP_STEP && Math.abs(ret(p, t - 2, t - 1)) <= GAP_STEP)
      out.push({ t, dir: Math.sign(step) });
  }
  return out;
}

function fadeProbe(p: number[], lag: number): number {
  const end = p.length - 1;
  let pnl = 0;
  let busyUntil = -1;
  for (const { t, dir } of gapOnsets(p)) {
    if (t <= busyUntil) continue;
    let s = t + 1;
    while (s <= end && Math.abs(ret(p, s - 1, s)) > STALL) s++;
    const entry = s + lag;
    if (entry >= end) continue;
    const exit = Math.min(end, entry + FADE_HOLD);
    pnl += -dir * ret(p, entry, exit) - COST_BPS / 1e4;
    busyUntil = exit;
  }
  return pnl;
}

function momentumProbe(p: number[], lag: number): number {
  const end = p.length - 1;
  let pnl = 0;
  for (const { t, dir } of gapOnsets(p)) {
    const entry = t + lag;
    if (entry >= end) continue;
    pnl += dir * ret(p, entry, Math.min(end, entry + MOMENTUM_HOLD)) - COST_BPS / 1e4;
  }
  return pnl;
}

function trendProbe(p: number[], sigma: number, lag: number): number {
  const end = p.length - 1;
  let pnl = 0;
  let busyUntil = -1;
  for (let t = TREND_LOOKBACK; t + lag < end; t++) {
    if (t <= busyUntil) continue;
    const r = Math.log(p[t] / p[t - TREND_LOOKBACK]);
    if (Math.abs(r) < TREND_K * sigma * Math.sqrt(TREND_LOOKBACK)) continue;
    const entry = t + lag;
    const exit = Math.min(end, entry + TREND_HOLD);
    pnl += Math.sign(r) * ret(p, entry, exit) - COST_BPS / 1e4;
    busyUntil = exit;
  }
  return pnl;
}

const usdcProbe = (p: number[]) => -ret(p, 0, p.length - 1);

// trend reads the run's own per-block noise (the uniform shock's sd), as an agent would estimate it.
const PROBES = {
  anchor: (p: number[], _sigma: number, lag: number) => anchorProbe(p, lag),
  fade: (p: number[], _sigma: number, lag: number) => fadeProbe(p, lag),
  momentum: (p: number[], _sigma: number, lag: number) => momentumProbe(p, lag),
  trend: (p: number[], sigma: number, lag: number) => trendProbe(p, sigma, lag),
  usdc: (p: number[]) => usdcProbe(p),
};
type Stat = { sum: number; sq: number; n: number };
const blank = (): Stat => ({ sum: 0, sq: 0, n: 0 });
const add = (s: Stat, x: number) => {
  s.sum += x;
  s.sq += x * x;
  s.n++;
};
const fmt = (s: Stat) => {
  const mean = s.sum / s.n;
  const se = Math.sqrt(Math.max(0, s.sq / s.n - mean * mean) / s.n);
  return `${(mean * 1e4).toFixed(1).padStart(7)} ±${(se * 1e4).toFixed(1).padEnd(5)}`;
};

const names = Object.keys(PROBES) as (keyof typeof PROBES)[];
type Row = Record<string, Stat>;
const blankRow = (): Row => Object.fromEntries(names.map((k) => [k, blank()]));
// One pass over the paths, every lag at once: the table for each lag is the same paths filled later.
const rows = new Map<string, Row[]>();
const mix = LAGS.map(blankRow);
const kappas = new Map<string, number>();
for (const regime of REGIMES) {
  setScenarioRegime(regime);
  const { config } = loadRunConfig(`config/regimes/${regime}.yaml`, { SEED: 1 });
  if (RAMP !== undefined)
    config.stressEvents = config.stressEvents.map((ev) =>
      ev.type === "crash" || ev.type === "spike" ? { ...ev, rampBlocks: RAMP } : ev,
    );
  const perLag = LAGS.map(blankRow);
  const sigma = (config.ou.perBase.WETH ?? config.ou.global).volatility / Math.sqrt(3);
  for (let seed = 1; seed <= SEEDS; seed++) {
    const p = fairPath(config, seed);
    LAGS.forEach((lag, i) => {
      for (const k of names) {
        const x = PROBES[k](p, sigma, lag);
        add(perLag[i][k], x);
        add(mix[i][k], x);
      }
    });
  }
  rows.set(regime, perLag);
  kappas.set(regime, (config.ou.perBase.WETH ?? config.ou.global).kappa);
}
resetScenarioRegime();
LAGS.forEach((lag, i) => {
  console.log(
    `\nbps of notional per epoch (mean ±se), ${SEEDS} seeds per regime, fill ${lag} block(s) after the ` +
      `observed block, ${COST_BPS} bps per round trip` +
      (RAMP !== undefined ? `, crash / spike rampBlocks [${RAMP.join(", ")}]` : ""),
  );
  console.log(`${"regime".padEnd(18)}${names.map((k) => k.padEnd(15)).join("")}kappa`);
  for (const regime of REGIMES)
    console.log(
      `${regime.padEnd(18)}${names.map((k) => fmt(rows.get(regime)![i][k]).padEnd(15)).join("")}${kappas.get(regime)}`,
    );
  console.log(`${"uniform mix".padEnd(18)}${names.map((k) => fmt(mix[i][k]).padEnd(15)).join("")}`);
});
