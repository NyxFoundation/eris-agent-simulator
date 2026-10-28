// measurePredictability: whether the official regimes' fair price leaves a direction an agent can
// read off what it has already seen, net of what trading on it costs.
//
//   npx tsx scripts/measurePredictability.ts [--seeds 1000] [--regimes calm,crash]
//
// The WETH fair path is stepped exactly as the coordinator steps it (core/src/realtime/coordinator.ts,
// the block loop: nextFairPrice toward the opening fair x the schedule's anchor multiplier, with the
// schedule's OU override, then the stress overlay), for many seeds of each regime. No chain, no I/O.
//
// Four probes, each a rule an agent could run on the observed fair alone. Each one sees the fair of
// block t and fills at the fair of t + LAG (an order sent after block t lands in t+1 and the GMX
// keeper executes it in t+2), paying COST_BPS per round trip (GMX position fee, both sides). A probe
// whose mean is far above zero is a hole: its size is bounded only by the leverage on offer.
//
//   anchor    trade toward the opening fair once it is ANCHOR_ENTRY away; close when it crosses back
//   fade      after a gap (a block move over GAP_STEP), wait for the move to stall, then trade against
//             the gap and hold FADE_HOLD blocks
//   momentum  trade with a gap the block it is first seen and close MOMENTUM_HOLD blocks later
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

const LAG = 2;
const COST_BPS = 10; // 0.04-0.06% per side on GMX, rounded up
const ANCHOR_ENTRY = 0.01;
const GAP_STEP = 0.025; // above the largest OU shock (0.4%) by far, below the smallest ramp step (3%)
const STALL = 0.01;
const FADE_HOLD = 30;
const MOMENTUM_HOLD = 3;
const OPENING_FAIR = 3000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const SEEDS = Number(arg("seeds") ?? 1000);
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

function anchorProbe(p: number[]): number {
  const end = p.length - 1;
  let pnl = 0;
  let dir = 0;
  let entry = 0;
  for (let t = 0; t + LAG <= end; t++) {
    const z = p[t] / OPENING_FAIR - 1;
    if (dir === 0 && Math.abs(z) > ANCHOR_ENTRY) {
      dir = -Math.sign(z);
      entry = t + LAG;
    } else if (dir !== 0 && Math.sign(z) !== -dir) {
      pnl += dir * ret(p, entry, t + LAG) - COST_BPS / 1e4;
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

function fadeProbe(p: number[]): number {
  const end = p.length - 1;
  let pnl = 0;
  let busyUntil = -1;
  for (const { t, dir } of gapOnsets(p)) {
    if (t <= busyUntil) continue;
    let s = t + 1;
    while (s <= end && Math.abs(ret(p, s - 1, s)) > STALL) s++;
    const entry = s + LAG;
    if (entry >= end) continue;
    const exit = Math.min(end, entry + FADE_HOLD);
    pnl += -dir * ret(p, entry, exit) - COST_BPS / 1e4;
    busyUntil = exit;
  }
  return pnl;
}

function momentumProbe(p: number[]): number {
  const end = p.length - 1;
  let pnl = 0;
  for (const { t, dir } of gapOnsets(p)) {
    const entry = t + LAG;
    if (entry >= end) continue;
    pnl += dir * ret(p, entry, Math.min(end, entry + MOMENTUM_HOLD)) - COST_BPS / 1e4;
  }
  return pnl;
}

const usdcProbe = (p: number[]) => -ret(p, 0, p.length - 1);

const PROBES = { anchor: anchorProbe, fade: fadeProbe, momentum: momentumProbe, usdc: usdcProbe };
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
const mix = Object.fromEntries(names.map((k) => [k, blank()])) as Record<string, Stat>;
console.log(
  `bps of notional per epoch (mean ±se), ${SEEDS} seeds per regime, fill ${LAG} blocks after the ` +
    `observed block, ${COST_BPS} bps per round trip\n`,
);
console.log(`${"regime".padEnd(18)}${names.map((k) => k.padEnd(15)).join("")}kappa`);
for (const regime of REGIMES) {
  setScenarioRegime(regime);
  const { config } = loadRunConfig(`config/regimes/${regime}.yaml`, { SEED: 1 });
  const row = Object.fromEntries(names.map((k) => [k, blank()])) as Record<string, Stat>;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const p = fairPath(config, seed);
    for (const k of names) {
      const x = PROBES[k](p);
      add(row[k], x);
      add(mix[k], x);
    }
  }
  const kappa = (config.ou.perBase.WETH ?? config.ou.global).kappa;
  console.log(`${regime.padEnd(18)}${names.map((k) => fmt(row[k]).padEnd(15)).join("")}${kappa}`);
}
resetScenarioRegime();
console.log(`${"uniform mix".padEnd(18)}${names.map((k) => fmt(mix[k]).padEnd(15)).join("")}`);
