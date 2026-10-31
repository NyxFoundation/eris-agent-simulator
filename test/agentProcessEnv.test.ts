// The environment handed to a spawned agent is an access boundary, not a convenience. Participants
// submit code that the operator executes (competition rules §2.5, §5), and the operator's own
// environment holds every other participant's wallet key, TREASURY_PRIVATE_KEY, the fork RPC URL,
// and one inference API key per participant. Spreading process.env into the child handed all of it
// to every submitted agent, and no sandbox escape was needed to read it.
//
// These tests spawn a real child through the same class the coordinator uses and read back what it
// actually received, because the leak this guards against is a property of the spawn, not of a
// helper that could be tested in isolation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { RealtimeAgentProcess } from "../core/src/realtime/agentProcess.js";
import type { AgentSpec } from "../sdk/src/types.js";

// Dump the child's environment to stderr, which is the stream the class captures.
const DUMP = "console.error(JSON.stringify(process.env)); process.exit(0);";

async function envOfChild(
  parentEnv: Record<string, string>,
  spec: Partial<AgentSpec> = {},
  extraEnv?: Record<string, string>,
  options: ConstructorParameters<typeof RealtimeAgentProcess>[8] = {},
): Promise<Record<string, string>> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(parentEnv)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    const proc = new RealtimeAgentProcess(
      {
        id: "probe",
        wallet: "AGENT0_PRIVATE_KEY",
        command: process.execPath,
        args: ["-e", DUMP],
        ...spec,
      } as AgentSpec,
      "http://127.0.0.1:8545",
      "0x0000000000000000000000000000000000000001",
      "/tmp/eris-probe-run",
      {
        privateKey: "0xagentkey",
        priceFeedAddress: "0x0000000000000000000000000000000000000002",
        runId: "probe-run",
      },
      "example/agents",
      0,
      extraEnv,
      options,
    );
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.onExit = done;
      setTimeout(done, 10_000);
    });
    // Give the stderr 'data' handler a turn to flush before reading it.
    await new Promise((r) => setTimeout(r, 50));
    return JSON.parse(proc.getStderr().trim());
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("another participant's wallet key never reaches a submitted agent", async () => {
  const env = await envOfChild({
    AGENT3_PRIVATE_KEY: "0xsomeoneelse",
    TREASURY_PRIVATE_KEY: "0xtreasury",
    ARB_RPC_URL: "https://fork.example/secret-key",
  });
  assert.equal(env.AGENT3_PRIVATE_KEY, undefined);
  assert.equal(env.TREASURY_PRIVATE_KEY, undefined);
  assert.equal(env.ARB_RPC_URL, undefined);
  // Its own key is still injected: an agent that cannot sign cannot compete.
  assert.equal(env.ERIS_AGENT_PRIVATE_KEY, "0xagentkey");
});

test("the parent's ERIS_AGENT_PRIVATE_KEY is not inherited over the injected one", async () => {
  const env = await envOfChild({ ERIS_AGENT_PRIVATE_KEY: "0xparentkey" });
  assert.equal(env.ERIS_AGENT_PRIVATE_KEY, "0xagentkey");
});

test("the runtime's own ERIS_* namespace still passes through", async () => {
  const env = await envOfChild({ ERIS_AGENT_NET: "host", ERIS_LOCAL_DEPLOY: "1" });
  assert.equal(env.ERIS_AGENT_NET, "host");
  assert.equal(env.ERIS_LOCAL_DEPLOY, "1");
  assert.equal(env.ERIS_RPC_URL, "http://127.0.0.1:8545");
  assert.equal(env.ERIS_AGENT_ID, "probe");
  assert.equal(env.ERIS_RUN_ID, "probe-run");
  // PATH has to survive or nothing spawns at all.
  assert.ok(env.PATH && env.PATH.length > 0);
});

test("a roster's per-agent inference key overrides the operator's default", async () => {
  const env = await envOfChild(
    { ANTHROPIC_API_KEY: "operator-default" },
    { env: { ANTHROPIC_API_KEY: "this-participants-key" } },
  );
  assert.equal(env.ANTHROPIC_API_KEY, "this-participants-key");
});

test("the operator's inference key is forwarded when the roster names none", async () => {
  // A single-operator local run keeps working with one key in .env.local.
  const env = await envOfChild({ ANTHROPIC_API_KEY: "operator-default" });
  assert.equal(env.ANTHROPIC_API_KEY, "operator-default");
});

test("Claude Code session markers are dropped, so `claude -p` does not hang on nesting detection", async () => {
  const env = await envOfChild({
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    AI_AGENT: "1",
  });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.AI_AGENT, undefined);
});

test("environment injected for every agent still arrives (stress victims, ADR 0009)", async () => {
  const env = await envOfChild(
    {},
    {},
    { ERIS_LIQUIDATION_VICTIMS: "0xvictim" },
  );
  assert.equal(env.ERIS_LIQUIDATION_VICTIMS, "0xvictim");
});

// The coordinator's config file carries the run seed (and a backtest names it after its regime and
// seed). An agent reads its own config instead (core/src/realtime/agentView.ts).
test("an agent gets its own config, never the coordinator's", async () => {
  const coordinatorConfig = "backtest/state/.effective-crash-101.yaml";
  const inherited = await envOfChild({ ERIS_CONFIG: coordinatorConfig });
  assert.equal(inherited.ERIS_CONFIG, undefined);

  const own = await envOfChild(
    { ERIS_CONFIG: coordinatorConfig },
    // A roster entry cannot point it elsewhere either.
    { env: { ERIS_CONFIG: "somewhere-else.yaml" } },
    undefined,
    { configPath: "/runs/r/agent-view/probe/config.yaml", viewDir: "/runs/r/agent-view/probe" },
  );
  assert.equal(own.ERIS_CONFIG, "/runs/r/agent-view/probe/config.yaml");
  assert.equal(own.ERIS_AGENT_VIEW_DIR, "/runs/r/agent-view/probe");
});

test("seeds in the operator's environment are not handed to an agent", async () => {
  const env = await envOfChild({
    ERIS_PRACTICE_SEED: "123456",
    ERIS_FLOW_SEED: "654321",
    ERIS_SOMETHING_SEED: "1",
    // Not a seed: a strategy parameter that happens to contain the word.
    ERIS_LAUNCHER_SEED_BPS: "3000",
  });
  assert.equal(env.ERIS_PRACTICE_SEED, undefined);
  assert.equal(env.ERIS_FLOW_SEED, undefined);
  assert.equal(env.ERIS_SOMETHING_SEED, undefined);
  assert.equal(env.ERIS_LAUNCHER_SEED_BPS, "3000");
});

test("the inference proxy's stats token is not handed to an agent (issue #218)", async () => {
  const env = await envOfChild({
    ERIS_INFERENCE_SECRET: "the operator's",
    ERIS_INFERENCE_STATS_TOKEN: "opens /admin/recording",
    // Not a credential: the endpoint every agent is told to call.
    ERIS_INFERENCE_BASE_URL: "http://ascon-inference-proxy:8790",
  });
  assert.equal(env.ERIS_INFERENCE_SECRET, undefined);
  // The proxy joins every agent's network, so this token is what keeps one participant from reading
  // how often the rest of the field revises.
  assert.equal(env.ERIS_INFERENCE_STATS_TOKEN, undefined);
  assert.equal(env.ERIS_INFERENCE_BASE_URL, "http://ascon-inference-proxy:8790");
  // Its own token, derived from the secret, still arrives.
  assert.equal(typeof env.ERIS_INFERENCE_TOKEN, "string");
});

test("the scenario key's file and commitment are not handed to an agent (ADR 0027)", async () => {
  const env = await envOfChild({
    ERIS_SCENARIO_KEY_FILE: "/secrets/practice-scenario-key.yaml",
    ERIS_SCENARIO_KEY_COMMITMENT: "sha256:00",
  });
  assert.equal(env.ERIS_SCENARIO_KEY_FILE, undefined);
  assert.equal(env.ERIS_SCENARIO_KEY_COMMITMENT, undefined);
});

test("the wallet secret's file is not handed to an agent (issue #189)", async () => {
  const env = await envOfChild({
    ERIS_WALLET_SECRET_FILE: "/secrets/practice-wallet-secret.yaml",
  });
  assert.equal(env.ERIS_WALLET_SECRET_FILE, undefined);
});

// Issue #167: which epoch of the schedule a run is, handed to every agent of a scenario matrix.
test("the epoch ordinal reaches the agent, and only the environment sets it", async () => {
  const env = await envOfChild(
    // A stale ordinal in the operator's shell, and a roster entry naming its own: neither wins.
    { ERIS_EPOCH_INDEX: "9", ERIS_EPOCH_COUNT: "9" },
    { env: { ERIS_EPOCH_INDEX: "1" } },
    undefined,
    { epoch: { index: 3, count: 40 } },
  );
  assert.equal(env.ERIS_EPOCH_INDEX, "3");
  assert.equal(env.ERIS_EPOCH_COUNT, "40");
});

test("a run that is not an epoch of a matrix hands no ordinal on, even one left in the operator's shell", async () => {
  const env = await envOfChild({ ERIS_EPOCH_INDEX: "9", ERIS_EPOCH_COUNT: "9" });
  assert.equal(env.ERIS_EPOCH_INDEX, undefined);
  assert.equal(env.ERIS_EPOCH_COUNT, undefined);
});

// The docker sandbox (infra/docker-agent/run-agent.sh) forwards the ERIS_* names the coordinator set
// into the container. Driven end to end with a stub `docker` on PATH that records what `docker run`
// was given, so no daemon is needed.
test("the epoch ordinal reaches a containerised agent too", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eris-epoch-docker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const capture = join(dir, "docker-run.json");
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nconst a = process.argv.slice(2);\n` +
      `if (a[0] === "run") require("node:fs").writeFileSync(process.env.ERIS_TEST_CAPTURE, JSON.stringify({ args: a, ` +
      `index: process.env.ERIS_EPOCH_INDEX, count: process.env.ERIS_EPOCH_COUNT }));\n`,
  );
  chmodSync(join(bin, "docker"), 0o700);
  const runDir = join(dir, "runs", "2026-09-28T00-00-00-000Z");
  const viewDir = join(runDir, "agent-view", "noop");
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(join(viewDir, "config.yaml"), "run:\n  blocks: 12\n");

  const saved = { PATH: process.env.PATH, ERIS_TEST_CAPTURE: process.env.ERIS_TEST_CAPTURE, ERIS_AGENT_IMAGE: process.env.ERIS_AGENT_IMAGE };
  process.env.PATH = bin + delimiter + (process.env.PATH ?? "");
  process.env.ERIS_TEST_CAPTURE = capture;
  process.env.ERIS_AGENT_IMAGE = "eris-agent:probe";
  try {
    const proc = new RealtimeAgentProcess(
      { id: "noop", wallet: "AGENT0_PRIVATE_KEY" } as AgentSpec,
      "http://127.0.0.1:8545",
      "0x0000000000000000000000000000000000000001",
      runDir,
      {
        privateKey: "0xagentkey",
        priceFeedAddress: "0x0000000000000000000000000000000000000002",
        runId: "probe-run",
      },
      resolve("example/agents"),
      0,
      undefined,
      {
        sandbox: "docker",
        configPath: join(viewDir, "config.yaml"),
        viewDir,
        epoch: { index: 7, count: 40 },
      },
    );
    await new Promise<void>((done) => {
      proc.onExit = () => done();
      setTimeout(done, 10_000);
    });
    assert.ok(existsSync(capture), `docker run was never reached: ${proc.getStderr()}`);
    const { args, index, count } = JSON.parse(readFileSync(capture, "utf8")) as {
      args: string[];
      index?: string;
      count?: string;
    };
    const forwarded = args.filter((_, i) => args[i - 1] === "-e");
    assert.ok(forwarded.includes("ERIS_EPOCH_INDEX"), JSON.stringify(forwarded));
    assert.ok(forwarded.includes("ERIS_EPOCH_COUNT"));
    // `-e NAME` takes the value from the wrapper's environment, which is the one the class built.
    assert.equal(index, "7");
    assert.equal(count, "40");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// The runtime's credentials travel on stdin, not in its environment: on Linux the environment a
// process started with stays readable at /proc/<pid>/environ by every process of its uid, the
// child a generated strategy runs in among them (example/agents/runtime/agentSecrets.ts).
async function spawnConvention(
  t: test.TestContext,
  bot: string,
  spec: Partial<AgentSpec> = {},
  parentEnv: Record<string, string> = {},
  options: ConstructorParameters<typeof RealtimeAgentProcess>[8] = {},
): Promise<RealtimeAgentProcess> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(parentEnv)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const dir = mkdtempSync(join(tmpdir(), "eris-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentsDir = join(dir, "agents");
  mkdirSync(join(agentsDir, "runtime"), { recursive: true });
  mkdirSync(join(agentsDir, "probe"));
  writeFileSync(join(agentsDir, "runtime", "bot.ts"), bot);
  const proc = new RealtimeAgentProcess(
    { id: "probe", wallet: "AGENT0_PRIVATE_KEY", ...spec } as AgentSpec,
    "http://127.0.0.1:8545",
    "0x0000000000000000000000000000000000000001",
    join(dir, "run"),
    {
      privateKey: "0xagentkey",
      priceFeedAddress: "0x0000000000000000000000000000000000000002",
      runId: "probe-run",
    },
    agentsDir,
    0,
    undefined,
    options,
  );
  await new Promise<void>((done) => {
    proc.onExit = () => done();
    setTimeout(done, 10_000);
  });
  await new Promise((r) => setTimeout(r, 50));
  return proc;
}

test("the runtime gets its key and token on stdin, and neither in its environment", async (t) => {
  const proc = await spawnConvention(
    t,
    `import { readFileSync } from "node:fs";
     console.error(JSON.stringify({ env: process.env, stdin: readFileSync(0, "utf8") }));
     process.exit(0);`,
    { env: { ERIS_ARB_SAFETY_BPS: "150", OPENAI_API_KEY: "sk-participant" } },
    { ERIS_INFERENCE_SECRET: "the operator's" },
  );
  const { env, stdin } = JSON.parse(proc.getStderr().trim()) as {
    env: Record<string, string>;
    stdin: string;
  };
  for (const name of ["ERIS_AGENT_PRIVATE_KEY", "ERIS_INFERENCE_TOKEN", "OPENAI_API_KEY"])
    assert.equal(env[name], undefined, name);
  assert.equal(env.ERIS_AGENT_SECRETS, "stdin");
  // A strategy parameter is not a credential, and stays where strategies read it.
  assert.equal(env.ERIS_ARB_SAFETY_BPS, "150");
  const secrets = JSON.parse(stdin) as Record<string, string>;
  assert.equal(secrets.ERIS_AGENT_PRIVATE_KEY, "0xagentkey");
  assert.equal(typeof secrets.ERIS_INFERENCE_TOKEN, "string");
  assert.equal(secrets.OPENAI_API_KEY, "sk-participant");
});

test("the real prelude puts what stdin carried back into process.env", async (t) => {
  const proc = await spawnConvention(
    t,
    `import { loadAgentSecrets } from ${JSON.stringify(resolve("example/agents/runtime/agentSecrets.ts"))};
     const source = loadAgentSecrets();
     console.error(JSON.stringify({ source, key: process.env.ERIS_AGENT_PRIVATE_KEY }));
     process.exit(0);`,
  );
  assert.deepEqual(JSON.parse(proc.getStderr().trim()), {
    source: "stdin",
    key: "0xagentkey",
  });
});

test("a containerised agent gets its credentials through docker run -i, not -e", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eris-secrets-docker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const capture = join(dir, "docker-run.json");
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nconst fs = require("node:fs"); const a = process.argv.slice(2);\n` +
      `if (a[0] === "run") fs.writeFileSync(process.env.ERIS_TEST_CAPTURE, JSON.stringify({ args: a, ` +
      `stdin: fs.readFileSync(0, "utf8"), key: process.env.ERIS_AGENT_PRIVATE_KEY ?? null }));\n`,
  );
  chmodSync(join(bin, "docker"), 0o700);
  const runDir = join(dir, "runs", "2026-10-31T00-00-00-000Z");
  const viewDir = join(runDir, "agent-view", "noop");
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(join(viewDir, "config.yaml"), "run:\n  blocks: 12\n");
  const saved = {
    PATH: process.env.PATH,
    ERIS_TEST_CAPTURE: process.env.ERIS_TEST_CAPTURE,
    ERIS_AGENT_IMAGE: process.env.ERIS_AGENT_IMAGE,
    ERIS_INFERENCE_BASE_URL: process.env.ERIS_INFERENCE_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.PATH = bin + delimiter + (process.env.PATH ?? "");
  process.env.ERIS_TEST_CAPTURE = capture;
  process.env.ERIS_AGENT_IMAGE = "eris-agent:probe";
  // With a proxy named, the operator's upstream key stays with the operator (as run-agent.sh did).
  process.env.ERIS_INFERENCE_BASE_URL = "http://ascon-inference-proxy:8790";
  process.env.ANTHROPIC_API_KEY = "operator-upstream";
  const proc = new RealtimeAgentProcess(
    { id: "noop", wallet: "AGENT0_PRIVATE_KEY" } as AgentSpec,
    "http://127.0.0.1:8545",
    "0x0000000000000000000000000000000000000001",
    runDir,
    {
      privateKey: "0xagentkey",
      priceFeedAddress: "0x0000000000000000000000000000000000000002",
      runId: "probe-run",
    },
    resolve("example/agents"),
    0,
    undefined,
    { sandbox: "docker", configPath: join(viewDir, "config.yaml"), viewDir },
  );
  await new Promise<void>((done) => {
    proc.onExit = () => done();
    setTimeout(done, 10_000);
  });
  assert.ok(existsSync(capture), `docker run was never reached: ${proc.getStderr()}`);
  const { args, stdin, key } = JSON.parse(readFileSync(capture, "utf8")) as {
    args: string[];
    stdin: string;
    key: string | null;
  };
  assert.ok(args.includes("-i"), JSON.stringify(args));
  const forwarded = args.filter((_, i) => args[i - 1] === "-e");
  assert.ok(!forwarded.includes("ERIS_AGENT_PRIVATE_KEY"), JSON.stringify(forwarded));
  assert.ok(forwarded.includes("ERIS_AGENT_SECRETS"));
  assert.equal(key, null);
  const secrets = JSON.parse(stdin) as Record<string, string>;
  assert.equal(secrets.ERIS_AGENT_PRIVATE_KEY, "0xagentkey");
  assert.equal(secrets.ANTHROPIC_API_KEY, undefined);
});
