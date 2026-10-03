// What an agent is handed at the start of an epoch must not say which regime it is in.
//
// The regime of an epoch is secret (rules §3.3), and an agent reads its config and env before the
// first price moves. Four of the twelve official regimes used to be identifiable that way: `launch`
// by the registry address, `vuln` by the vuln factory, `lending-incident` and `cdp-incident` by the
// victim lists -- and the last two say a crash is coming, so the right move was to sell at block 0.
// The vuln pools were worse: deployed at setup, readable from block 0, and created through a
// selector that named the answer (createRiggedPool / createSimplePool).
//
// This holds the start equal across the official regimes, with the victim lists as the one
// documented exception (core/src/realtime/agentEnv.ts says why).
//
// The regimes fund WBTC, which only the local registry has (constants.ts reads this at import).
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const { loadRunConfig } = await import("../core/src/runConfig.js");
const { renderAgentConfig } = await import("../core/src/realtime/agentView.js");
const { agentExtraEnvKeys, REGIME_REVEALING_AGENT_ENV } = await import(
  "../core/src/realtime/agentEnv.js"
);
const { vulnFactoryAbi } = await import("../core/src/realtime/vulnPools.js");

const ROOT = resolve(import.meta.dirname, "..");
const OFFICIAL: string[] = (
  parseYaml(readFileSync(resolve(ROOT, "config/scenarios/public.yaml"), "utf8")) as {
    regimes: string[];
  }
).regimes;

const load = (regime: string) =>
  loadRunConfig(`config/regimes/${regime}.yaml`, { SEED: 101 }).config;

test("the official set is the twelve regimes this test is about", () => {
  assert.equal(OFFICIAL.length, 12);
});

test("every official regime hands its agents the same config file", () => {
  const rendered = OFFICIAL.map((r) => [r, renderAgentConfig(load(r))] as const);
  const [first, firstText] = rendered[0];
  for (const [regime, text] of rendered)
    assert.equal(text, firstText, `${regime}'s agent config differs from ${first}'s`);
});

test("every official regime hands its agents the same env keys, but the documented victim lists", () => {
  const exceptions = new Set(Object.keys(REGIME_REVEALING_AGENT_ENV));
  const byRegime = OFFICIAL.map(
    (r) => [r, agentExtraEnvKeys(load(r), { segmented: false })] as const,
  );
  const common = byRegime[0][1].filter((k) => !exceptions.has(k));
  for (const [regime, keys] of byRegime)
    assert.deepEqual(
      keys.filter((k) => !exceptions.has(k)),
      common,
      `${regime} hands a different set of env keys`,
    );
  // The registry and the vuln factory are among them: their absence is what named launch and vuln.
  for (const key of ["ERIS_MARKET_REGISTRY_ADDRESS", "ERIS_VULN_FACTORY"])
    assert.ok(common.includes(key), `${key} is not handed out in every regime`);
});

test("the documented exceptions are exactly the victim regimes, and no more", () => {
  const carrying = (key: string) =>
    OFFICIAL.filter((r) =>
      agentExtraEnvKeys(load(r), { segmented: false }).includes(key),
    ).sort();
  assert.deepEqual(carrying("ERIS_LIQUIDATION_VICTIMS"), ["lending-incident"]);
  assert.deepEqual(carrying("ERIS_LIQUITY_VICTIMS"), ["cdp-incident"]);
});

test("vuln pools are created through one selector that does not name the kind", () => {
  const writes = vulnFactoryAbi.filter((e) => e.type === "function");
  assert.deepEqual(
    writes.map((e) => e.name),
    ["createPool"],
  );
  const artifact = resolve(ROOT, "out/VulnPoolFactory.sol/VulnPoolFactory.json");
  if (!existsSync(artifact)) return; // `npm run build:contracts` not run; the ABI above still holds
  const abi = (JSON.parse(readFileSync(artifact, "utf8")) as {
    abi: { type: string; name?: string; stateMutability?: string }[];
  }).abi;
  const mutating = abi
    .filter(
      (e) =>
        e.type === "function" &&
        e.stateMutability !== "view" &&
        e.stateMutability !== "pure",
    )
    .map((e) => e.name);
  assert.deepEqual(mutating, ["createPool"]);
});
