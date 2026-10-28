// What an agent is handed at the start of an epoch must not say which regime it is in.
//
// The regime of an epoch is secret (rules §3.3), and an agent reads its config and env before the
// first price moves. Four of the twelve official regimes used to be identifiable that way: `launch`
// by the registry address, `vuln` by the vuln factory, `lending-incident` and `cdp-incident` by the
// victim lists -- and the last two say a crash is coming, so the right move was to sell at block 0.
// The vuln pools were worse: deployed at setup, readable from block 0, and created through a
// selector that named the answer (createRiggedPool / createSimplePool).
//
// This holds the start equal across the official regimes. The victim lists were the last
// exception: they are on-chain from block 0 whatever the env says, so both cohorts are now staged in
// every official regime, as decoys where nothing breaches them (ADR 0029 Amendment 2).
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
const { agentExtraEnvKeys, AGENT_ENV_VICTIMS } = await import(
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

test("every official regime hands its agents the same env keys", () => {
  const byRegime = OFFICIAL.map(
    (r) => [r, agentExtraEnvKeys(load(r), { segmented: false })] as const,
  );
  const common = byRegime[0][1];
  for (const [regime, keys] of byRegime)
    assert.deepEqual(keys, common, `${regime} hands a different set of env keys`);
  // Among them the four whose absence used to name a regime: the registry (launch), the vuln
  // factory (vuln) and the two victim lists (lending-incident, cdp-incident -- a crash is coming).
  for (const key of [
    "ERIS_MARKET_REGISTRY_ADDRESS",
    "ERIS_VULN_FACTORY",
    ...Object.keys(AGENT_ENV_VICTIMS),
  ])
    assert.ok(common.includes(key), `${key} is not handed out in every regime`);
});

test("every official regime stages the same victims", () => {
  // The env is the half of it an agent is handed; the other half is the chain. The cohorts are
  // opened before block 0, so their count, size and starting HF / ICR are readable by anyone, and a
  // cohort that differed by regime would name it as surely as the env did.
  const cohorts = (regime: string) => {
    const c = load(regime);
    return {
      aave: [c.stressVictimCount, c.stressVictimHf0, c.stressVictimSupplyWethWei],
      liquity: [c.stressLiquityVictimCount, c.stressLiquityVictimIcr, c.stressLiquityVictimCollWethWei],
      liquityRecoveryTcr: c.stressLiquityRecoveryTcr,
    };
  };
  const reference = cohorts(OFFICIAL[0]);
  assert.ok(reference.aave[0] > 0 && reference.liquity[0] > 0, "the official cohorts are staged");
  for (const regime of OFFICIAL)
    assert.deepEqual(cohorts(regime), reference, `${regime} stages different victims`);
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
