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
// The chain's own history is held too, as far as it is a pure function of the config. The setup
// blocks before the first scored block are readable through the gateway, and their senders and
// amounts used to differ by regime: a whale wallet and its deposit only in `whale`, one launch
// wallet pair per drawn token holding exactly its draw only in `launch`, and the deployer's
// approvals only where a depeg or a liquidity pull would trade. Every run now creates and funds the
// same environment wallets and grants the same approvals (core/src/realtime/standingApprovals.ts).
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
const { EventSchedule } = await import("../core/src/realtime/events.js");
const { WHALE_ENDOWMENT, whaleEndowment, whaleFundingCeiling } = await import(
  "../core/src/realtime/whale.js"
);
const {
  LAUNCH_WALLET_SLOTS,
  LAUNCH_WALLET_USDC_UNITS,
  LAUNCH_WAVE_USDC_UNITS,
  launchWalletFunding,
  tokenLaunchCeiling,
} = await import("../core/src/realtime/tokenLaunch.js");

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

// The opening fair the coordinator funds the whale against: the deploy's anchors. The USDC floor
// leaves a third on top, so this is not a knife edge.
const OPENING_FAIR = { WETH: 3000, WBTC: 60_000 };

test("no official regime can draw a whale or a launch beyond the fixed endowments", () => {
  for (const regime of OFFICIAL) {
    const { stressEvents } = load(regime);
    const whale = whaleFundingCeiling(stressEvents, OPENING_FAIR);
    for (const [base, wei] of Object.entries(whale.baseWei))
      assert.ok(
        wei <= (WHALE_ENDOWMENT.baseWei[base] ?? 0n),
        `${regime}: a whale can need ${wei} ${base} wei, beyond WHALE_ENDOWMENT`,
      );
    assert.ok(
      whale.usdcUnits <= WHALE_ENDOWMENT.usdcUnits,
      `${regime}: a whale can need ${whale.usdcUnits} USDC units, beyond WHALE_ENDOWMENT`,
    );
    const launch = tokenLaunchCeiling(stressEvents);
    assert.ok(launch.tokens <= LAUNCH_WALLET_SLOTS, `${regime}: ${launch.tokens} tokens can list`);
    assert.ok(launch.liquidityUsdcUnits <= LAUNCH_WALLET_USDC_UNITS, `${regime}: launch pool too deep`);
    assert.ok(launch.waveUsdcUnits <= LAUNCH_WAVE_USDC_UNITS, `${regime}: launch wave too large`);
  }
});

test("every official regime funds the same environment wallets with the same amounts", () => {
  const plan = (regime: string, seed: number) => {
    const config = load(regime);
    const schedule = new EventSchedule(config.stressEvents, seed, config.runBlocks);
    return {
      whale: whaleEndowment(schedule.events, OPENING_FAIR),
      launch: launchWalletFunding(schedule),
      // What the flow wallets are funded with and how many Aave actors there are: the deposits and
      // the sender count of the setup blocks.
      flow: {
        enabledProtocols: config.enabledProtocols,
        aaveFlowActorCount: config.aaveFlowActorCount,
        flowEthWei: config.flowEthWei,
        flowWethWei: config.flowWethWei,
        flowUsdcUnits: config.flowUsdcUnits,
        flowBaseAmounts: config.flowBaseAmounts,
      },
    };
  };
  const reference = plan(OFFICIAL[0], 101);
  for (const regime of OFFICIAL)
    for (const seed of [101, 102, 103, 104, 105, 7_001, 7_002, 7_003])
      assert.deepEqual(plan(regime, seed), reference, `${regime}#${seed} sets up a different world`);
});
