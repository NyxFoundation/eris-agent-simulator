// Nearby run seeds must not produce related runs. `Rng` is an LCG, so `new Rng(seed)` starts seeds
// Δ apart a·Δ/2³² apart (seeds 1-200 all opened inside [0.236, 0.314)), and XORing a constant salt
// in keeps nearby seeds nearby. Every consumer that turns the run seed into draws now goes through
// `Rng.fromSeed`; these tests fail on the old constructions (numbers in
// scripts/measureSeedCorrelation.ts). The stress schedule is covered by test/events.test.ts and
// deliberately keeps its legacy path.
import test from "node:test";
import assert from "node:assert/strict";
import { fnv1a32, mix32, priceRngForAsset, Rng } from "@eris/sdk/rng.js";
import { flowRng, trendBit, trendRng } from "../core/src/flow/logic.js";
import { ApySchedule, LST_SEED_SALT } from "../core/src/realtime/lst.js";
import { VulnSchedule, VULN_SEED_SALT, type VulnEventConfig } from "../core/src/realtime/vulnEvents.js";

const NEAR = Array.from({ length: 200 }, (_, i) => i + 1);
const MANY = Array.from({ length: 2000 }, (_, i) => i + 1);
const PUBLISHED = [101, 202, 303, 404, 505];

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

// A consumer's first draw spreads over [0, 1) across seeds 1-200 and is unrelated between seeds 1
// and 101 apart. Old constructions: 2 deciles hit, corr 0.99 / 0.56-0.77.
function assertSpread(name: string, first: (seed: number) => number): void {
  const deciles = new Set(NEAR.map((s) => Math.min(9, Math.floor(first(s) * 10))));
  assert.ok(deciles.size >= 8, `${name}: seeds 1-200 hit only ${deciles.size} deciles`);
  for (const d of [1, 101]) {
    const c = corr(MANY.map(first), MANY.map((s) => first(s + d)));
    assert.ok(Math.abs(c) < 0.1, `${name}: corr(seed, seed+${d}) = ${c.toFixed(3)}`);
  }
}

test("mix32 is murmur3's fmix32 and fnv1a32 is FNV-1a (known vectors)", () => {
  assert.equal(mix32(0), 0);
  assert.equal(mix32(1), 0x514e28b7);
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
});

test("Rng.fromSeed is mix32(seed ^ salt), with a string salt hashed by FNV-1a", () => {
  // Pinned: the practice period and every official scenario's realization is a function of this.
  assert.equal(Rng.fromSeed(7, 0x1234).next(), new Rng(mix32(7 ^ 0x1234)).next());
  assert.equal(Rng.fromSeed(7, "x").next(), new Rng(mix32(7 ^ fnv1a32("x"))).next());
  assert.equal(priceRngForAsset(101, "WETH").next(), 0.34036932955496013);
});

test("the price path's first shock is not decided by how small the seed is", () => {
  for (const base of ["WETH", "WBTC"]) assertSpread(`price ${base}`, (s) => priceRngForAsset(s, base).next());
  // Old: the WETH shock was negative on 200 of 200 seeds, WBTC's positive on 200 of 200.
  const negative = NEAR.filter((s) => priceRngForAsset(s, "WETH").next() < 0.5).length;
  assert.ok(negative > 70 && negative < 130, `WETH first shock negative on ${negative}/200`);
});

test("the price path's later draws are unrelated between nearby seeds, not just the first", () => {
  // Old, Δ = 1: 0.998 0.505 -0.295 0.786 -0.334 -0.132 on draws 1-6.
  for (const d of [1, 101]) {
    const a = MANY.map((s) => priceRngForAsset(s, "WETH"));
    const b = MANY.map((s) => priceRngForAsset(s + d, "WETH"));
    for (let step = 1; step <= 6; step++) {
      const c = corr(a.map((r) => r.next()), b.map((r) => r.next()));
      assert.ok(Math.abs(c) < 0.1, `Δ=${d} draw ${step}: corr ${c.toFixed(3)}`);
    }
  }
});

test("the flow bot's stream is its own: not the price path's, and spread across seeds", () => {
  assertSpread("flow", (s) => flowRng(s).next());
  // flow.seed defaults to the run seed; the old bot drew exactly the price path's shocks.
  for (const seed of PUBLISHED) {
    const flow = flowRng(seed);
    const price = priceRngForAsset(seed, "WETH");
    let shared = 0;
    for (let i = 0; i < 360; i++) if (flow.next() === price.next()) shared++;
    assert.equal(shared, 0, `seed ${seed}: ${shared} of 360 draws shared with the price path`);
  }
});

test("persisted trend bits: nearby seeds unrelated, and a window never stands in for a seed", () => {
  const tags = ["uniswap", "balancer", "curve", "market"];
  let same = 0, n = 0;
  for (const s of MANY) for (let w = 0; w < 30; w++) for (const t of tags) {
    if (trendBit(s, w, t) === trendBit(s + 1, w, t)) same++;
    n++;
  }
  // Old: 0.568.
  assert.ok(Math.abs(same / n - 0.5) < 0.01, `seeds 1 apart agree on ${(same / n).toFixed(3)} of bits`);
  // Old key: seed ^ (window + 1), so seed 101's window ((w + 1) ^ 1) - 1 was seed 100's window w, on
  // 116 of 116 (window, tag) pairs.
  let alias = 0, pairs = 0;
  for (let w = 1; w < 30; w++) for (const t of tags) {
    if (trendBit(100, w, t) === trendBit(101, ((w + 1) ^ 1) - 1, t)) alias++;
    pairs++;
  }
  assert.ok(alias > pairs * 0.3 && alias < pairs * 0.7, `seed 100/101 aliased on ${alias}/${pairs}`);
  assertSpread("trend follow", (s) => trendRng(s, 0, "uniswap|corr").next());
});

test("the LST's first APY is spread over its range", () => {
  assertSpread("lst", (s) => Rng.fromSeed(s, LST_SEED_SALT).next());
  // Old: 513-592 of [100, 900] on every seed from 1 to 200.
  const first = NEAR.map((s) => new ApySchedule(s, [100, 900], 10, 300).nextAt(0) ?? 300);
  assert.ok(Math.max(...first) - Math.min(...first) > 640, `first APY spans ${Math.min(...first)}-${Math.max(...first)}`);
});

test("the vuln regime's first pool count takes every value in its range", () => {
  assertSpread("vuln", (s) => Rng.fromSeed(s, VULN_SEED_SALT).next());
  const ev: VulnEventConfig = {
    type: "rigged-pool",
    windowFrac: [0.2, 0.35],
    poolCount: [4, 6],
    riggedFrac: [0.5, 0.7],
    baitBps: [300, 600],
    rugBps: [3000, 6000],
    rugThresholdFrac: [0.04, 0.08],
  };
  const count = (s: number) => new VulnSchedule([ev], s, 360, ["WETH", "WBTC"]).events[0].poolCount;
  // Old: 4 on every seed from 1 to 200, and on all five published seeds.
  assert.deepEqual([...new Set(NEAR.map(count))].sort(), [4, 5, 6]);
  assert.ok(new Set(PUBLISHED.map(count)).size > 1, "the published seeds all drew the same pool count");
});

test("consumer salts are far apart, so no two consumers share a stream below seed 2^24", () => {
  // Rng.fromSeed(a, x) and Rng.fromSeed(b, y) are the same stream iff a ^ b = x ^ y. The inline
  // salts are the coordinator's prewarm walk and the agent runtime's ctx.rng.
  const salts: Record<string, number> = {
    "price:WETH": fnv1a32("price:WETH"),
    "price:WBTC": fnv1a32("price:WBTC"),
    flow: fnv1a32("flow"),
    prewarm: fnv1a32("prewarm"),
    "agent-runtime": fnv1a32("agent-runtime"),
    LSTY: LST_SEED_SALT,
    VULN: VULN_SEED_SALT,
  };
  const names = Object.keys(salts);
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      assert.ok(((salts[names[i]] ^ salts[names[j]]) >>> 0) >= 2 ** 24, `${names[i]} / ${names[j]}`);
});
