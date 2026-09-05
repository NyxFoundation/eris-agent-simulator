// The epoch schedule of rules §3.3 (ADR 0022): a pure function of (hidden set, lottery seed, k).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlan,
  canonicalJson,
  commitmentOf,
  deriveSchedule,
  type HiddenSet,
} from "../core/src/competition/schedule.js";

const hidden: HiddenSet = {
  regimes: {
    calm: [1, 2, 3],
    crash: [11, 12, 13],
    depeg: [21, 22, 23],
    whale: [31, 32, 33],
  },
  salt: "x",
};

test("deterministic: the same inputs give the same schedule, byte for byte", () => {
  const a = deriveSchedule(hidden, "seed-A", 12);
  const b = deriveSchedule(hidden, "seed-A", 12);
  assert.deepEqual(a, b);
});

test("every regime appears k / R times, ordinals run 1..k, seeds come from the hidden set", () => {
  const plan = deriveSchedule(hidden, "seed-A", 12);
  assert.equal(plan.length, 12);
  assert.deepEqual(plan.map((e) => e.s), [...Array(12).keys()].map((i) => i + 1));
  const counts = new Map<string, number>();
  for (const e of plan) {
    counts.set(e.regime, (counts.get(e.regime) ?? 0) + 1);
    assert.ok(hidden.regimes[e.regime].includes(e.seed), `${e.regime}#${e.seed}`);
  }
  assert.deepEqual([...counts.values()], [3, 3, 3, 3]);
  // No (regime, seed) twice when each regime has exactly k / R seeds.
  assert.equal(new Set(plan.map((e) => `${e.regime}#${e.seed}`)).size, 12);
});

test("the lottery seed decides the order, not the multiset (when every regime has exactly k / R seeds)", () => {
  const a = deriveSchedule(hidden, "seed-A", 12);
  const b = deriveSchedule(hidden, "seed-B", 12);
  const key = (p: typeof a) => p.map((e) => `${e.regime}#${e.seed}`).sort();
  assert.deepEqual(key(a), key(b));
  assert.notDeepEqual(
    a.map((e) => `${e.regime}#${e.seed}`),
    b.map((e) => `${e.regime}#${e.seed}`),
  );
});

test("a regime with more hidden seeds than it needs has its seeds chosen by the lottery too", () => {
  const wide: HiddenSet = { regimes: { calm: [1, 2, 3, 4, 5, 6], crash: [11, 12, 13, 14, 15, 16] } };
  const a = deriveSchedule(wide, "seed-A", 4);
  assert.equal(a.filter((e) => e.regime === "calm").length, 2);
  assert.equal(a.filter((e) => e.regime === "crash").length, 2);
});

test("k not divisible by the regime count, too few seeds, and repeated seeds are refused", () => {
  assert.throws(() => deriveSchedule(hidden, "s", 10), /not a multiple/);
  assert.throws(() => deriveSchedule(hidden, "s", 16), /needs 4/);
  assert.throws(
    () => deriveSchedule({ regimes: { calm: [1, 1] } }, "s", 2),
    /repeat/,
  );
  assert.throws(() => deriveSchedule(hidden, "", 4), /empty/);
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
