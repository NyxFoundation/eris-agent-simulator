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
import { RealtimeAgentProcess } from "../core/src/realtime/agentProcess.js";
import type { AgentSpec } from "../sdk/src/types.js";

// Dump the child's environment to stderr, which is the stream the class captures.
const DUMP = "console.error(JSON.stringify(process.env)); process.exit(0);";

async function envOfChild(
  parentEnv: Record<string, string>,
  spec: Partial<AgentSpec> = {},
  extraEnv?: Record<string, string>,
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
  const env = await envOfChild({ ERIS_CONFIG: "config/local.yaml" });
  assert.equal(env.ERIS_CONFIG, "config/local.yaml");
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
