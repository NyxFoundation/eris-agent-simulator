// What the environment hands an agent it launches (core/src/realtime/agentView.ts): a config with the
// fields the runtime reads and nothing else, in a directory whose name says nothing about the
// scenario, plus the network posture the container wrapper will give it.
//
// The regimes fund WBTC, which only the local registry has (constants.ts reads this at import).
process.env.ERIS_LOCAL_DEPLOY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const { loadRunConfig } = await import("../core/src/runConfig.js");
const {
  AGENT_CONFIG_FIELDS,
  AGENT_VIEW_DIR,
  agentNetworkPosture,
  agentSandboxBanner,
  agentSandboxWarning,
  agentViewDir,
  prepareAgentView,
  renderAgentConfig,
} = await import("../core/src/realtime/agentView.js");
const { loadConfig } = await import("../sdk/src/config.js");
const { loadYamlConfig } = await import("../sdk/src/runConfig.js");

// Seeds nobody would write by accident, so finding them in the file text means they leaked.
const RUN_SEED = "424242";
const FLOW_SEED = "515151";

const CONFIGS = [
  "config/example.yaml",
  "config/practice.yaml",
  ...readdirSync("config/regimes")
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => `config/regimes/${f}`),
];

// Every SimConfig field an agent's config does not carry, so that a field added later has to be
// placed on one side or the other. An agent reading one of these gets its default.
const ENVIRONMENT_ONLY = new Set([
  "rpcUrl", // the agent's endpoint arrives as ERIS_RPC_URL
  "readRpcUrl",
  // Published in the manifest the coordinator writes (issue #156); the runtime dials what that manifest says.
  "publicRpcUrl",
  "treasuryPrivateKey",
  "externalRoleEthWei",
  "forkUrl",
  "forkBlockNumber",
  "stressVictimCount",
  "stressVictimHf0",
  "stressVictimSupplyWethWei",
  "stressLiquityVictimCount",
  "stressLiquityVictimIcr",
  "stressLiquityVictimCollWethWei",
  "stressLiquityRecoveryTcr",
  "stressLiquitySpSeedEusdWei",
  "vulnPoolLiquidityUsdcUnits",
  "vulnPoolFeeBps",
  "vulnLlm", // distributed as ERIS_VULN_LLM
  "agentMarketsPerBlockCap",
  "flashArbDemo",
  "runEndsAt", // converted into runBlocks, which the agent config carries
  "skipReset",
  "localSnapshotFile",
  "runMode",
  "agentSandbox",
  "resetUnit",
  "scenarioRegime",
  "prewarmBlocks",
  "ou",
  "scoreEvery",
  "segmentHours",
  "segmentName",
  "markMedianBlocks",
  "blockGasLimit",
  "agentsReadyTimeoutSec",
  "agentStateQuotaBytes", // held by the coordinator (issue #214); the runtime's own cap is ERIS_AGENT_STATE_CAP_BYTES
  "agentLogQuotaBytes",
  "agentDiskCheckEveryBlocks",
  "seed",
  "runDirRoot",
  "agentTimeoutMs",
  "agentsConfigPath",
  "registrationsFile",
  "agentsDir",
  "initialEthWei",
  "flowEthWei",
  "flowWethWei",
  "flowBaseAmounts",
  "initialWethWei",
  "initialBaseAmounts",
  "initialUsdcUnits",
  "flowUsdcUnits",
  "flowTopUpEveryBlocks",
  "uninformedFlowMaxWethWei",
  "uninformedFlowCount",
  "uninformedFlowPersistBlocks",
  "uninformedFlowTrendCorrelation",
  "informedFlowMaxWethWei",
  "aaveFlowBorrowUsdcUnits",
  "balancerFlowMaxWethWei",
  "curveFlowMaxWethWei",
  "gmxFlowMaxSizeUsd",
  "gmxFlowActivityProb",
  "gmxFlowMaxBurst",
  "aaveFlowMaxWethWei",
  "aaveFlowActivityProb",
  "aaveFlowActorCount",
  "informedArbFeeBps",
  "uninformedFlowArrivalRate",
  "uninformedFlowSizeSigma",
  "uninformedFlowSizeClampMult",
  "gmxFlowArrivalRate",
  "gmxFlowSizeSigma",
  "aaveFlowActorSizeSigma",
  "baseFlowMax",
  "baseInformedFlowMax",
  "lstApyBps",
  "lstApyRangeBps",
  "lstApyStepBlocks",
  "lstQueueThroughputWeiPerBlock",
  "lstWithdrawalDelayBlocks",
  "flowBotCommand",
  "flowBotArgs",
  "flowSeed",
  "privateKeys",
]);

test("every SimConfig field is either in the agent config or environment-only", () => {
  const agentFields = new Set<string>(AGENT_CONFIG_FIELDS);
  for (const key of Object.keys(loadConfig({}))) {
    assert.ok(
      agentFields.has(key) || ENVIRONMENT_ONLY.has(key),
      `SimConfig.${key} is new: add it to AGENT_CONFIG_FIELDS (core/src/realtime/agentView.ts) if the ` +
        "agent runtime reads it, or to ENVIRONMENT_ONLY here if it does not",
    );
    assert.ok(
      !(agentFields.has(key) && ENVIRONMENT_ONLY.has(key)),
      `${key} is on both sides`,
    );
  }
});

for (const path of CONFIGS) {
  test(`the agent config for ${path} carries no seed and the fields the runtime reads`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "eris-agent-config-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // The practice period ends on a date; pin it to blocks so the test does not expire with it.
    const length: Record<string, string> =
      path === "config/practice.yaml" ? { ERIS_RUN_ENDS_AT: "", ERIS_RUN_BLOCKS: "600" } : {};
    const full = loadRunConfig(path, { SEED: RUN_SEED, FLOW_SEED, ...length }).config;
    assert.equal(
      full.seed,
      Number(RUN_SEED),
      "the override reached the coordinator's config",
    );

    const text = renderAgentConfig(full);
    assert.ok(!text.includes(RUN_SEED), "the run seed is in the agent config");
    assert.ok(
      !text.includes(FLOW_SEED),
      "the flow seed is in the agent config",
    );
    assert.doesNotMatch(text, /seed/i);
    const doc = parseYaml(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(doc).sort(), [
      "agentMarkets",
      "fees",
      "lst",
      "run",
    ]);

    const file = join(dir, "config.yaml");
    writeFileSync(file, text);
    const agent = loadYamlConfig(file).config;
    for (const field of AGENT_CONFIG_FIELDS)
      assert.deepEqual(
        agent[field],
        full[field],
        `${path}: ${field} differs in the agent's view`,
      );
    assert.notEqual(agent.seed, full.seed);
    assert.notEqual(agent.flowSeed, full.flowSeed);
    assert.deepEqual(agent.stressVictimCount, 0);
  });
}

test("the agent config carries the coordinator's one-off overrides", () => {
  const full = loadRunConfig("config/regimes/calm.yaml", {
    SEED: "7",
    ERIS_RUN_BLOCKS: "12",
    ENABLED_PROTOCOLS: "uniswap,balancer",
  }).config;
  const doc = parseYaml(renderAgentConfig(full)) as {
    run: Record<string, unknown>;
  };
  assert.equal(doc.run.blocks, 12);
  assert.deepEqual(doc.run.protocols, ["uniswap", "balancer"]);
});

test("the view directory is named by the agent only, and refuses ids that are not one path segment", (t) => {
  const runDir = mkdtempSync(join(tmpdir(), "eris-agent-view-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  assert.equal(
    agentViewDir(runDir, "venue-arb"),
    resolve(runDir, AGENT_VIEW_DIR, "venue-arb"),
  );
  for (const id of ["", ".", "..", "../other", "a/b", "a\\b", "a:b", "a,b"])
    assert.throws(
      () => agentViewDir(runDir, id),
      /cannot be used/,
      JSON.stringify(id),
    );

  const view = prepareAgentView(runDir, "venue-arb", "run:\n  blocks: 1\n");
  assert.equal(view.dir, resolve(runDir, AGENT_VIEW_DIR, "venue-arb"));
  assert.equal(view.configPath, join(view.dir, "config.yaml"));
  assert.equal(readFileSync(view.configPath, "utf8"), "run:\n  blocks: 1\n");
});

test("network posture follows run-agent.sh's defaults", () => {
  assert.deepEqual(agentNetworkPosture({}, "linux"), {
    network: "host",
    isolated: false,
    egress: "open",
    bindMount: false,
  });
  assert.equal(agentNetworkPosture({}, "darwin").network, "bridge");
  assert.equal(
    agentNetworkPosture({ ERIS_AGENT_NET: "custom" }, "linux").network,
    "custom",
  );
  assert.deepEqual(
    agentNetworkPosture(
      { ERIS_AGENT_ISOLATE: "1", ERIS_AGENT_INTERNAL: "1" },
      "linux",
    ),
    {
      network: "per-agent",
      isolated: true,
      egress: "closed",
      bindMount: false,
    },
  );
  // --internal only means anything on a per-agent network.
  assert.equal(
    agentNetworkPosture({ ERIS_AGENT_INTERNAL: "1" }, "linux").egress,
    "open",
  );
});

test("the sandbox warning names every agent without the live week's isolation", () => {
  const live = { ERIS_AGENT_ISOLATE: "1", ERIS_AGENT_INTERNAL: "1" };
  assert.equal(
    agentSandboxWarning([{ id: "a", env: live }], { platform: "linux" }),
    null,
  );
  const warning = agentSandboxWarning(
    [
      { id: "shared", env: {} },
      { id: "egress", env: { ERIS_AGENT_ISOLATE: "1" } },
      { id: "bind", env: { ...live, ERIS_AGENT_BINDMOUNT: "1" } },
      { id: "sealed", env: live },
    ],
    { platform: "linux" },
  );
  assert.deepEqual(warning, {
    sharedNetwork: [{ id: "shared", network: "host" }],
    openEgress: ["egress"],
    bindMount: ["bind"],
    periodDirectory: [],
  });
  const banner = agentSandboxBanner(warning!);
  assert.match(banner, /WARNING/);
  assert.match(banner, /reach services on this host directly/);
  assert.match(banner, /ERIS_AGENT_ISOLATE=1 ERIS_AGENT_INTERNAL=1/);
  assert.match(banner, /Not fatal/);

  // A segmented period mounts the period directory into an image-mode container.
  assert.deepEqual(
    agentSandboxWarning([{ id: "a", env: live }], {
      segmented: true,
      platform: "linux",
    })?.periodDirectory,
    ["a"],
  );
});
