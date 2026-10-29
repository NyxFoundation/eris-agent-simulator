// The pure helpers behind infra/live-week/cutover.sh (scripts/liveWeek.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { mergeStoredResults, rosterFingerprint } from "../core/src/backtest/resume.js";
import {
  ACCEPTED_HEADER,
  buildFieldYaml,
  fieldFingerprint,
  fieldImages,
  keysMissing,
  parseAccepted,
  poolCapacity,
  restampPlan,
  voidEpoch,
} from "../scripts/liveWeek.js";

const SHA = "a".repeat(64);
const IMG = `sha256:${"b".repeat(64)}`;
const row = (unit: string): string =>
  [unit, `/zips/${unit}.zip`, SHA, IMG, "2026-10-31T15:30:00Z"].join("\t");

test("parseAccepted reads the rows and skips the header and blank lines", () => {
  const rows = parseAccepted(`${ACCEPTED_HEADER}\n${row("team-b")}\n\n${row("team-a")}\n`);
  assert.deepEqual(
    rows.map((r) => r.unit),
    ["team-b", "team-a"],
  );
  assert.equal(rows[0].imageId, IMG);
});

test("parseAccepted refuses duplicates, reserved names, bad ids and malformed digests", () => {
  assert.throws(() => parseAccepted(`${row("a")}\n${row("a")}`), /appears twice/);
  assert.throws(() => parseAccepted(row("noop")), /reserved/);
  assert.throws(() => parseAccepted(row("lib")), /reserved/);
  assert.throws(() => parseAccepted(row("-x")), /invalid unit id/);
  assert.throws(() => parseAccepted("a\tb\tc"), /5 tab-separated/);
  assert.throws(
    () => parseAccepted(["a", "z", "xyz", IMG, "t"].join("\t")),
    /zipSha256/,
  );
  assert.throws(() => parseAccepted(["a", "z", SHA, "abc", "t"].join("\t")), /imageId/);
});

test("buildFieldYaml: the baseline plus every unit on AUTO, sorted", () => {
  const text = buildFieldYaml(parseAccepted(`${row("zeta")}\n${row("alpha")}`));
  const doc = parseYaml(text) as { agents: Array<Record<string, unknown>> };
  assert.deepEqual(doc.agents, [
    { id: "noop", wallet: "AUTO", baseline: true },
    { id: "alpha", wallet: "AUTO" },
    { id: "zeta", wallet: "AUTO" },
  ]);
});

test("fieldFingerprint is the runner's rosterFingerprint over the agents array", () => {
  const text = buildFieldYaml(parseAccepted(row("alpha")));
  const agents = (parseYaml(text) as { agents: unknown[] }).agents;
  assert.equal(fieldFingerprint(text), rosterFingerprint(agents));
  // Independent of acceptance order.
  assert.equal(
    fieldFingerprint(buildFieldYaml(parseAccepted(`${row("b")}\n${row("a")}`))),
    fieldFingerprint(buildFieldYaml(parseAccepted(`${row("a")}\n${row("b")}`))),
  );
});

test("fieldImages follows run-agent.sh: eris-agent:<basename of dir, else id>", () => {
  const yaml = [
    "agents:",
    "  - { id: noop, wallet: AUTO, baseline: true }",
    "  - { id: wide, dir: clean-arb, wallet: AUTO }",
    "  - { id: ext, external: true, address: '0x0000000000000000000000000000000000000001' }",
  ].join("\n");
  assert.deepEqual(fieldImages(yaml), [
    { id: "noop", dir: "noop", tag: "eris-agent:noop" },
    { id: "wide", dir: "clean-arb", tag: "eris-agent:clean-arb" },
  ]);
});

test("keysMissing lists non-baseline ids with no participants entry", () => {
  const field = buildFieldYaml(parseAccepted(`${row("a")}\n${row("b")}`));
  assert.deepEqual(keysMissing(field, "participants:\n  a: { ollama: k }\n"), ["b"]);
  assert.deepEqual(keysMissing(field, "participants: {}\n"), ["a", "b"]);
});

test("poolCapacity counts the subnets of every pool; 0 without the key", () => {
  assert.equal(poolCapacity("{}"), 0);
  assert.equal(
    poolCapacity(JSON.stringify({ "default-address-pools": [{ base: "10.64.0.0/10", size: 24 }] })),
    2 ** 14,
  );
  assert.equal(
    poolCapacity(
      JSON.stringify({
        "default-address-pools": [
          { base: "172.80.0.0/16", size: 24 },
          { base: "10.10.0.0/16", size: 20 },
        ],
      }),
    ),
    256 + 16,
  );
  assert.throws(
    () => poolCapacity(JSON.stringify({ "default-address-pools": [{ base: "10.0.0.0/24", size: 16 }] })),
    /size must be/,
  );
});

test("restampPlan rewrites only startsAt lines, minutes apart", () => {
  const plan = [
    "hiddenSetCommitment: sha256:abc",
    "epochs:",
    "  - s: 1",
    "    regime: calm",
    "    startsAt: 2026-01-01T00:00:00.000Z",
    "  - s: 2",
    "    regime: crash",
    "    startsAt: 2026-01-01T03:00:00.000Z",
    "",
  ].join("\n");
  const out = restampPlan(plan, "2026-10-20T06:00:00Z", 20);
  assert.match(out, /s: 1\n {4}regime: calm\n {4}startsAt: 2026-10-20T06:00:00\.000Z/);
  assert.match(out, /startsAt: 2026-10-20T06:20:00\.000Z/);
  assert.equal(
    out.replace(/startsAt: \S+/g, ""),
    plan.replace(/startsAt: \S+/g, ""),
  );
  assert.throws(() => restampPlan("epochs: []\n", "2026-10-20T06:00:00Z", 20), /no startsAt/);
  assert.throws(() => restampPlan(plan, "not a time", 20), /ISO 8601/);
});

test("voidEpoch drops a completed epoch's result so --resume re-runs it, keeping the run dir", () => {
  const matrix = JSON.stringify({
    schema: 2,
    scenarios: [
      { s: 1, regime: "calm", seed: 7, agents: [{ id: "a" }], runDir: "runs/x" },
      { s: 2, regime: "crash", seed: 9, agents: [{ id: "a" }], flags: ["f"] },
    ],
  });
  const out = JSON.parse(voidEpoch(matrix, 2, " anvil died ", "2026-11-02T00:00:00Z"));
  assert.deepEqual(out.scenarios[0].agents, [{ id: "a" }]);
  assert.equal(out.scenarios[1].agents, undefined);
  assert.equal(out.scenarios[1].flags, undefined);
  assert.equal(out.scenarios[1].error, "voided (rules §4.4.2): anvil died");
  assert.equal(out.scenarios[1].voidedAt, "2026-11-02T00:00:00Z");
  assert.equal(out.scenarios[1].seed, 9);
  // The runner's own merge re-runs exactly the voided ordinal.
  const merged = mergeStoredResults(
    [
      { s: 1, regime: "calm", seed: 7 },
      { s: 2, regime: "crash", seed: 9 },
    ],
    out.scenarios,
  );
  assert.deepEqual(merged.rerun, [2]);
  const voided = JSON.stringify(out);
  assert.throws(() => voidEpoch(voided, 2, "again"), /no result/);
  assert.throws(() => voidEpoch(matrix, 3, "x"), /no s=3/);
  assert.throws(() => voidEpoch(matrix, 1, " "), /needs a reason/);
  assert.throws(() => voidEpoch(JSON.stringify({ schema: 1 }), 1, "x"), /schema-2/);
});

test("sealed-senders lists the four role keys' addresses, and refuses a missing one", async () => {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { sealedSenders } = await import("../scripts/liveWeek.js");
  const env = {
    ADMIN_PRIVATE_KEY: generatePrivateKey(),
    KEEPER_PRIVATE_KEY: generatePrivateKey(),
    SETUP_PRIVATE_KEY: generatePrivateKey(),
    DEPLOYER_PRIVATE_KEY: generatePrivateKey(),
  };
  const listed = sealedSenders(env).split(",");
  assert.deepEqual(
    new Set(listed),
    new Set(Object.values(env).map((k) => privateKeyToAccount(k).address.toLowerCase())),
  );
  assert.throws(() => sealedSenders({ ...env, DEPLOYER_PRIVATE_KEY: "" }), /DEPLOYER_PRIVATE_KEY/);
});
