// The epoch schedule of rules §3.3 (ADR 0023): a pure function of (hidden set, lottery seed, k).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  buildPlan,
  canonicalJson,
  commitmentOf,
  deriveSchedule,
  type HiddenSet,
} from "../core/src/competition/schedule.js";

const seeds = (base: number, n: number) => [...Array(n).keys()].map((i) => base + i);
const hidden: HiddenSet = {
  regimes: {
    calm: seeds(100, 12),
    crash: seeds(200, 12),
    depeg: seeds(300, 12),
    whale: seeds(400, 12),
  },
  salt: "x",
};

test("deterministic: the same inputs give the same schedule, byte for byte", () => {
  const a = deriveSchedule(hidden, "seed-A", 12);
  const b = deriveSchedule(hidden, "seed-A", 12);
  assert.deepEqual(a, b);
});

test("ordinals run 1..k, seeds come from the drawn regime's hidden set, no (regime, seed) twice", () => {
  const plan = deriveSchedule(hidden, "seed-A", 12);
  assert.equal(plan.length, 12);
  assert.deepEqual(plan.map((e) => e.s), [...Array(12).keys()].map((i) => i + 1));
  for (const e of plan)
    assert.ok(hidden.regimes[e.regime].includes(e.seed), `${e.regime}#${e.seed}`);
  assert.equal(new Set(plan.map((e) => `${e.regime}#${e.seed}`)).size, 12);
});

test("regimes are drawn independently: counts are not forced equal (issue #186)", () => {
  // Under the old equal-count shuffle every one of these plans would be [3, 3, 3, 3]. Independent
  // draws give that exact split in about 2% of plans, so 50 lottery seeds all hitting it is not
  // something that happens by chance.
  const splits = [...Array(50).keys()].map((i) => {
    const counts = new Map<string, number>();
    for (const e of deriveSchedule(hidden, `seed-${i}`, 12))
      counts.set(e.regime, (counts.get(e.regime) ?? 0) + 1);
    return Object.keys(hidden.regimes).map((r) => counts.get(r) ?? 0).join(",");
  });
  assert.ok(splits.some((c) => c !== "3,3,3,3"), splits.join(" | "));
});

test("the draw is uniform over regimes", () => {
  // 12 regimes x 60 epochs x 200 lottery seeds = 12,000 draws, 1,000 expected per regime. A
  // chi-square over 11 degrees of freedom above 31.3 has probability 0.001 under uniformity.
  const regimes = Object.fromEntries(
    [...Array(12).keys()].map((r) => [`r${String(r).padStart(2, "0")}`, seeds(r * 1000, 60)]),
  );
  const counts = new Map<string, number>();
  for (let i = 0; i < 200; i++)
    for (const e of deriveSchedule({ regimes }, `uniform-${i}`, 60))
      counts.set(e.regime, (counts.get(e.regime) ?? 0) + 1);
  const expected = 1000;
  const chi2 = Object.keys(regimes).reduce(
    (sum, r) => sum + ((counts.get(r) ?? 0) - expected) ** 2 / expected,
    0,
  );
  assert.ok(chi2 < 31.3, `chi-square ${chi2.toFixed(1)}`);
});

test("too few seeds for k, repeated seeds and an empty lottery seed are refused; any k is allowed", () => {
  assert.throws(() => deriveSchedule(hidden, "s", 13), /needs 13/);
  assert.throws(
    () => deriveSchedule({ regimes: { calm: [1, 1] } }, "s", 2),
    /repeat/,
  );
  assert.throws(() => deriveSchedule(hidden, "", 4), /empty/);
  // No longer a multiple of the regime count.
  assert.equal(deriveSchedule(hidden, "s", 7).length, 7);
});

test("the commitment is over canonical JSON: key order and formatting do not change it", () => {
  const a = commitmentOf({ regimes: { calm: [1, 2], crash: [3] }, salt: "x" });
  const b = commitmentOf({ salt: "x", regimes: { crash: [3], calm: [1, 2] } });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  assert.notEqual(a, commitmentOf({ regimes: { calm: [1, 2], crash: [3] }, salt: "y" }));
});

test("buildPlan carries both commitments beside the epochs", () => {
  const plan = buildPlan(hidden, { lotterySeed: "seed-A", salt: "s" }, 8);
  assert.equal(plan.k, 8);
  assert.equal(plan.hiddenSetCommitment, commitmentOf(hidden));
  assert.equal(plan.lotterySeedCommitment, commitmentOf({ lotterySeed: "seed-A", salt: "s" }));
  assert.equal(plan.epochs.length, 8);
});

test("the example hidden set has the shape k = 60 needs: the twelve official regimes, 60 seeds each", () => {
  // The official set is config/scenarios/public.yaml's regime list. Each epoch draws its regime
  // independently, so every regime needs k seeds (issue #186). The committed hidden set is not in
  // the repository, so this pins the example's shape, which is what an operator copies.
  const official = (
    parseYaml(readFileSync("config/scenarios/public.yaml", "utf8")) as { regimes: string[] }
  ).regimes;
  const example = parseYaml(
    readFileSync("config/competition/hidden-set.example.yaml", "utf8"),
  ) as HiddenSet;
  assert.equal(official.length, 12);
  assert.deepEqual(Object.keys(example.regimes).sort(), [...official].sort());
  const plan = deriveSchedule(example, "example", 60);
  assert.equal(plan.length, 60);
  assert.ok(plan.every((e) => official.includes(e.regime)));
  assert.throws(() => deriveSchedule(example, "example", 61), /needs 61/);
});
