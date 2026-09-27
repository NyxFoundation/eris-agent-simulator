// measureSeedCorrelation: how much the outcomes of nearby run seeds move together, per seeded Rng.
//
//   npx tsx scripts/measureSeedCorrelation.ts
//
// `Rng` is an LCG, so `new Rng(seed)` starts seeds Δ apart a·Δ/2³² apart: the first draw of seeds
// 1-200 lands inside ~8% of [0, 1). XORing a constant salt in keeps nearby seeds nearby. Every
// consumer below used one or the other and now goes through `Rng.fromSeed` (murmur3's fmix32 of
// seed ^ salt). Each row shows the old construction (emulated here, since the code no longer has
// it) next to the current one. No chain, no I/O: the draws only.
//
// The stress schedule (core/src/realtime/events.ts) is not here: its legacy path is kept byte for
// byte on purpose, and a schedule using the variation keys is hashed since PR #145.
process.env.ERIS_LOCAL_DEPLOY = "1";

import { readFileSync } from "node:fs";
import { parse } from "yaml";

const { Rng, nextFairPrice, priceRngForAsset } = await import("@eris/sdk/rng.js");
const { flowRng, trendBit, trendRng, buildFlowOrders } = await import("../core/src/flow/logic.js");
const { ApySchedule, LST_SEED_SALT } = await import("../core/src/realtime/lst.js");
const { VulnSchedule, VULN_SEED_SALT } = await import("../core/src/realtime/vulnEvents.js");
type RngT = InstanceType<typeof Rng>;

const PUBLISHED = [101, 202, 303, 404, 505];
const NEAR = Array.from({ length: 200 }, (_, i) => i + 1);
const MANY = Array.from({ length: 5000 }, (_, i) => i + 1);

// ---- the old constructions, as they were on main before this change ----
function legacyAssetSalt(symbol: string): number {
  if (symbol === "WETH") return 0;
  let h = 0x9e_37_79_b9;
  for (let i = 0; i < symbol.length; i++) h = Math.imul(h ^ symbol.charCodeAt(i), 0x01_00_01_93) >>> 0;
  return h >>> 0;
}
const legacy = {
  price: (seed: number, symbol = "WETH") => new Rng((seed ^ legacyAssetSalt(symbol)) >>> 0),
  flow: (flowSeed: number) => new Rng(flowSeed),
  lst: (seed: number) => new Rng((seed ^ LST_SEED_SALT) >>> 0),
  vuln: (seed: number) => new Rng((seed ^ VULN_SEED_SALT) >>> 0),
  hashTag(tag: string): number {
    let h = 0x81_1c_9d_c5;
    for (let c = 0; c < tag.length; c++) h = Math.imul(h ^ tag.charCodeAt(c), 0x01_00_01_93) >>> 0;
    return h >>> 0;
  },
  trendBit: (seed: number, w: number, tag: string) =>
    new Rng((Math.imul(seed ^ (w + 1), 0x01_00_01_93) ^ legacy.hashTag(tag)) >>> 0).bool(),
  follow: (seed: number, w: number, protocol: string) =>
    new Rng(Math.imul(seed ^ (w + 1), 0x27_22_0a_95) ^ legacy.hashTag(`${protocol}|corr`)).next(),
};

// ---- statistics ----
function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}
const f3 = (x: number) => x.toFixed(3);
const span = (xs: number[], f = f3) => `${f(Math.min(...xs))}–${f(Math.max(...xs))}`;
// corr(x(s), x(s+Δ)) over s = 1..5000
const lagCorr = (x: (seed: number) => number, d: number) =>
  corr(MANY.map(x), MANY.map((s) => x(s + d)));
const deciles = (xs: number[]) => {
  const c = new Array(10).fill(0);
  for (const x of xs) c[Math.min(9, Math.floor(x * 10))]++;
  return c.filter((v) => v > 0).length;
};

const rows: string[][] = [];
function uniformRow(name: string, first: (seed: number) => number): void {
  rows.push([
    name,
    span(NEAR.map(first)),
    `${deciles(NEAR.map(first))}/10`,
    PUBLISHED.map((s) => f3(first(s))).join(" "),
    f3(lagCorr(first, 1)),
    f3(lagCorr(first, 101)),
  ]);
}

// ---- 1. first draws, old vs new ----
const u1 = (make: (seed: number) => RngT) => (seed: number) => make(seed).next();
uniformRow("price WETH, old Rng(seed)", u1((s) => legacy.price(s)));
uniformRow("price WETH, new", u1((s) => priceRngForAsset(s, "WETH")));
uniformRow("price WBTC, old Rng(seed ^ salt)", u1((s) => legacy.price(s, "WBTC")));
uniformRow("price WBTC, new", u1((s) => priceRngForAsset(s, "WBTC")));
uniformRow("flow, old Rng(flowSeed)", u1(legacy.flow));
uniformRow("flow, new", u1(flowRng));
uniformRow("lst APY, old Rng(seed ^ LSTY)", u1(legacy.lst));
uniformRow("lst APY, new", u1((s) => Rng.fromSeed(s, LST_SEED_SALT)));
uniformRow("vuln, old Rng(seed ^ VULN)", u1(legacy.vuln));
uniformRow("vuln, new", u1((s) => Rng.fromSeed(s, VULN_SEED_SALT)));
uniformRow("trend follow (w=0, uniswap), old", (s) => legacy.follow(s, 0, "uniswap"));
uniformRow("trend follow (w=0, uniswap), new", (s) => trendRng(s, 0, "uniswap|corr").next());
console.log("## First draw per consumer\n");
console.log("| consumer | seeds 1–200 | deciles hit (1–200) | published 101–505 | corr(s, s+1) | corr(s, s+101) |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.join(" | ")} |`);
// The new constructions over a wide range: every decile should hold ~500 of 5,000 seeds.
const decileSpread = (first: (seed: number) => number) => {
  const c = new Array(10).fill(0);
  for (const s of MANY) c[Math.min(9, Math.floor(first(s) * 10))]++;
  return `${Math.min(...c)}–${Math.max(...c)}`;
};
console.log(`\nNew constructions, decile counts over seeds 1–5000 (500 each if flat): price WETH ${decileSpread(u1((s) => priceRngForAsset(s, "WETH")))}, price WBTC ${decileSpread(u1((s) => priceRngForAsset(s, "WBTC")))}, flow ${decileSpread(u1(flowRng))}, lst ${decileSpread(u1((s) => Rng.fromSeed(s, LST_SEED_SALT)))}, vuln ${decileSpread(u1((s) => Rng.fromSeed(s, VULN_SEED_SALT)))}`);

// ---- 2. what the first draw decides ----
const shockBps = (u: number) => (u - 0.5) * 2 * 0.004 * 10_000;
const firstShock = (make: (s: number) => RngT) => NEAR.map((s) => shockBps(make(s).next()));
const neg = (xs: number[]) => xs.filter((x) => x < 0).length;
const f1 = (x: number) => x.toFixed(1);
const wethOld = firstShock((s) => legacy.price(s));
const wethNew = firstShock((s) => priceRngForAsset(s, "WETH"));
const wbtcOld = firstShock((s) => legacy.price(s, "WBTC"));
const wbtcNew = firstShock((s) => priceRngForAsset(s, "WBTC"));
console.log("\n## What the first draw decides (seeds 1–200)\n");
console.log(`- WETH first-block shock (volatility 0.004): old ${span(wethOld, f1)} bps, negative on ${neg(wethOld)}/200; new ${span(wethNew, f1)} bps, negative on ${neg(wethNew)}/200`);
console.log(`- WBTC first-block shock: old ${span(wbtcOld, f1)} bps, negative on ${neg(wbtcOld)}/200; new ${span(wbtcNew, f1)} bps, negative on ${neg(wbtcNew)}/200`);
const zeroArrivals = (make: (s: number) => RngT) => NEAR.filter((s) => make(s).poisson(0.45) === 0).length;
console.log(`- flow, first round's uniswap WETH arrival count Poisson(0.45) = 0: old ${zeroArrivals(legacy.flow)}/200, new ${zeroArrivals(flowRng)}/200 (expected ${f1(200 * Math.exp(-0.45))})`);
const apyOld = NEAR.map((s) => Math.round(100 + 800 * legacy.lst(s).next()));
const apyNew = NEAR.map((s) => new ApySchedule(s, [100, 900], 10, 300).nextAt(0) ?? 300);
console.log(`- lst, first APY of [100, 900] bps: old ${span(apyOld, String)}, new ${span(apyNew, String)}`);
const vulnYaml = parse(readFileSync("config/regimes/vuln.yaml", "utf8")) as { vuln: { events: never[] } };
const countOf = (xs: number[]) => [4, 5, 6].map((k) => `${k}:${xs.filter((x) => x === k).length}`).join(" ");
const poolsOld = NEAR.map((s) => Math.max(1, Math.round(4 + 2 * legacy.vuln(s).next())));
const poolsNew = NEAR.map((s) => new VulnSchedule(vulnYaml.vuln.events, s, 360, ["WETH", "WBTC"]).events[0].pools.length);
console.log(`- vuln regime, first event's poolCount [4, 6]: old ${countOf(poolsOld)}; new ${countOf(poolsNew)}; published old ${PUBLISHED.map((s) => Math.max(1, Math.round(4 + 2 * legacy.vuln(s).next()))).join(" ")}, new ${PUBLISHED.map((s) => new VulnSchedule(vulnYaml.vuln.events, s, 360, ["WETH", "WBTC"]).events[0].pools.length).join(" ")}`);

// ---- 3. beyond the first draw: the lattice ----
// For a fixed Δ, draw n of seed s+Δ is draw n of seed s shifted by a constant mod 1, so every step
// of the two paths is deterministically related. The first step is the extreme case.
const stepCorr = (make: (s: number) => RngT, d: number, steps = 6) => {
  const a = MANY.map((s) => make(s));
  const b = MANY.map((s) => make(s + d));
  return Array.from({ length: steps }, () => f3(corr(a.map((r) => r.next()), b.map((r) => r.next())))).join(" ");
};
console.log("\n## Draw-by-draw correlation, seed s vs s+Δ (s = 1..5000), draws 1–6\n");
for (const d of [1, 101]) {
  console.log(`- price WETH Δ=${d}: old ${stepCorr((s) => legacy.price(s), d)}; new ${stepCorr((s) => priceRngForAsset(s, "WETH"), d)}`);
}
const path = (rng: RngT) => {
  let p = 3000, sum = 0;
  for (let t = 0; t < 360; t++) {
    p = nextFairPrice(p, rng, 3000, { volatility: 0.004, kappa: 0.02, drift: 0 });
    sum += Math.log(p / 3000);
  }
  return { final: Math.log(p / 3000), mean: sum / 360 };
};
console.log("\n## 360-block WETH path (default OU), seed s vs s+Δ (s = 1..5000; noise ±0.014)\n");
for (const d of [1, 101, 202]) {
  const row = (make: (s: number) => RngT) => {
    const a = MANY.map((s) => path(make(s)));
    const b = MANY.map((s) => path(make(s + d)));
    return `corr(final) ${f3(corr(a.map((x) => x.final), b.map((x) => x.final)))}, corr(mean) ${f3(corr(a.map((x) => x.mean), b.map((x) => x.mean)))}`;
  };
  console.log(`- Δ=${d}: old ${row((s) => legacy.price(s))}; new ${row((s) => priceRngForAsset(s, "WETH"))}`);
}

// ---- 4. streams that were the same stream ----
const sameDraws = (a: RngT, b: RngT, n = 360) => {
  let k = 0;
  for (let i = 0; i < n; i++) if (a.next() === b.next()) k++;
  return k;
};
console.log("\n## Shared streams (seed 101, first 360 draws equal)\n");
console.log(`- flow bot vs WETH price path (flow.seed defaults to the run seed): old ${sameDraws(legacy.flow(101), legacy.price(101))}/360, new ${sameDraws(flowRng(101), priceRngForAsset(101, "WETH"))}/360`);
console.log(`- prewarm walk vs WETH price path: old ${sameDraws(new Rng(101), legacy.price(101))}/360, new ${sameDraws(Rng.fromSeed(101, "prewarm"), priceRngForAsset(101, "WETH"))}/360`);
console.log(`- agent runtime ctx.rng vs WETH price path: old ${sameDraws(new Rng(101), legacy.price(101))}/360, new ${sameDraws(Rng.fromSeed(101, "agent-runtime"), priceRngForAsset(101, "WETH"))}/360`);
// How fast the flow bot ate the price path's shocks: draws per round on the calm regime's AMM + GMX
// flow (Aave's actors add more, so this is a lower bound).
{
  const { loadConfig } = await import("@eris/sdk/config.js");
  const { buildSource } = await import("@eris/sdk/runConfig.js");
  const { buildFlowContext } = await import("../core/src/coordinator.js");
  const { setActiveBases } = await import("@eris/sdk/chain.js");
  const { baseTokens } = await import("@eris/sdk/markets.js");
  setActiveBases(baseTokens().map((t) => t.address));
  const config = loadConfig(buildSource(parse(readFileSync("config/regimes/calm.yaml", "utf8"))));
  const ctx = {
    config,
    fairPrices: { WBTC: 60000 },
    publicClient: { getBalance: async () => 10n ** 22n, readContract: async () => 10n ** 22n },
    flowWallet: () => ({ address: "0x0000000000000000000000000000000000000001" }),
  } as never;
  const venues = ["uniswap", "balancer", "curve", "gmx"] as const;
  const state = new Map(venues.map((id) => [id, { priceUsdcPerWeth: 3001, markets: [{ market: { base: "WBTC" }, priceUsdcPerWeth: 60030 }] }]));
  class Counting extends Rng {
    n = 0;
    override next(): number {
      this.n++;
      return super.next();
    }
  }
  const rng = new Counting(101);
  let rounds = 0;
  while (rng.n < 360) {
    rounds++;
    buildFlowOrders(rng, await buildFlowContext(ctx, [...venues], state as never, 3000, rounds));
  }
  console.log(`- calm's AMM + GMX flow draws ${f1(rng.n / rounds)} uniforms per round: the old flow bot had drawn all 360 of the run's WETH price shocks by round ${rounds}`);
}

// ---- 5. the persisted trend's direction bits ----
const TAGS = ["uniswap", "balancer", "curve", "market"];
const agree = (bit: (s: number, w: number, t: string) => boolean, d: number) => {
  let same = 0, n = 0;
  for (const s of MANY.slice(0, 2000)) for (let w = 0; w < 30; w++) for (const t of TAGS) {
    if (bit(s, w, t) === bit(s + d, w, t)) same++;
    n++;
  }
  return f3(same / n);
};
const newBit = (s: number, w: number, t: string) => trendBit(s, w, t);
console.log("\n## Persisted trend direction bits (informed-flow: persistBlocks 12 = 30 windows)\n");
console.log(`- agreement of seed s and s+Δ over 30 windows × 4 tags (0.5 = unrelated): Δ=1 old ${agree(legacy.trendBit, 1)} new ${agree(newBit, 1)}; Δ=101 old ${agree(legacy.trendBit, 101)} new ${agree(newBit, 101)}`);
// The old key hashed seed ^ (window + 1), so 100 ^ (w + 1) = 101 ^ ((w + 1) ^ 1): seed 101's
// window ((w + 1) ^ 1) - 1 is seed 100's window w.
let alias = 0, aliasNew = 0, aliasN = 0;
for (let w = 0; w < 30; w++) for (const t of TAGS) {
  const w2 = ((w + 1) ^ 1) - 1;
  if (w2 < 0) continue;
  aliasN++;
  if (legacy.trendBit(100, w, t) === legacy.trendBit(101, w2, t)) alias++;
  if (trendBit(100, w, t) === trendBit(101, w2, t)) aliasNew++;
}
console.log(`- seed 100 window w vs seed 101 window ((w+1)^1)-1, same bit: old ${alias}/${aliasN}, new ${aliasNew}/${aliasN}`);
let ones = 0, flips = 0, cells = 0, pairs = 0;
for (const s of NEAR) for (const t of TAGS) {
  let prev: boolean | null = null;
  for (let w = 0; w < 50; w++) {
    const b = trendBit(s, w, t);
    if (b) ones++;
    cells++;
    if (prev !== null) { if (b !== prev) flips++; pairs++; }
    prev = b;
  }
}
console.log(`- new, within a seed (200 seeds × 50 windows × 4 tags): p(1) = ${f3(ones / cells)}, flip rate ${f3(flips / pairs)}`);
