// How the agent process receives its credentials (example/agents/runtime/agentSecrets.ts), and what
// it says at start about what the generated strategy's process could still read.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isolationWarnings,
  loadAgentSecrets,
} from "../example/agents/runtime/agentSecrets.js";
import { isCredentialEnvName, isSecretEnvName } from "../sdk/src/secretEnv.js";

const reader = (files: Record<string | number, string>) => (p: string | number) => {
  if (!(p in files)) throw new Error(`ENOENT ${p}`);
  return files[p];
};

test("stdin's credentials land in the env the runtime reads", () => {
  const env: NodeJS.ProcessEnv = { ERIS_AGENT_SECRETS: "stdin" };
  const source = loadAgentSecrets(
    env,
    reader({ 0: JSON.stringify({ ERIS_AGENT_PRIVATE_KEY: "0xk", ERIS_INFERENCE_TOKEN: "t" }) }),
  );
  assert.equal(source, "stdin");
  assert.equal(env.ERIS_AGENT_PRIVATE_KEY, "0xk");
  assert.equal(env.ERIS_INFERENCE_TOKEN, "t");
});

test("a broken hand-off stops the agent rather than starting it without a key", () => {
  for (const stdin of ["", "not json", "[]", JSON.stringify({ ERIS_AGENT_PRIVATE_KEY: 1 })])
    assert.throws(() =>
      loadAgentSecrets({ ERIS_AGENT_SECRETS: "stdin" }, reader({ 0: stdin })),
    );
  assert.throws(() => loadAgentSecrets({ ERIS_AGENT_SECRETS: "fd:3" }, reader({})), /must be "stdin"/);
});

test("a self-hosted agent can name a key file instead of putting the key in its environment", () => {
  const env: NodeJS.ProcessEnv = { ERIS_AGENT_PRIVATE_KEY_FILE: "/k" };
  assert.equal(loadAgentSecrets(env, reader({ "/k": "0xfromfile\n" })), "file");
  assert.equal(env.ERIS_AGENT_PRIVATE_KEY, "0xfromfile");
  assert.throws(
    () =>
      loadAgentSecrets(
        { ERIS_AGENT_PRIVATE_KEY: "0xa", ERIS_AGENT_PRIVATE_KEY_FILE: "/k" },
        reader({ "/k": "0xb" }),
      ),
    /set one/,
  );
  // The key in the environment still works; isolationWarnings says what that leaves open.
  assert.equal(loadAgentSecrets({ ERIS_AGENT_PRIVATE_KEY: "0xa" }, reader({})), "env");
});

test("isolation warnings: the key in the environment, and a ptrace_scope that lets a child read memory", () => {
  const scope = (v: string) => () => v;
  const none = () => {
    throw new Error("ENOENT");
  };
  assert.deepEqual(isolationWarnings("linux", "stdin", scope("1\n")), []);
  assert.deepEqual(isolationWarnings("linux", "file", scope("2")), []);
  assert.match(isolationWarnings("linux", "env", scope("1")).join(), /ERIS_AGENT_PRIVATE_KEY_FILE/);
  assert.match(isolationWarnings("linux", "stdin", scope("0")).join(), /ptrace_scope is 0/);
  assert.match(isolationWarnings("linux", "stdin", none).join(), /no Yama/);
  // No /proc elsewhere: nothing to say.
  assert.deepEqual(isolationWarnings("darwin", "env", none), []);
});

test("what moves to stdin is the credentials, not the endpoints the docker wrapper reads", () => {
  for (const name of ["ERIS_AGENT_PRIVATE_KEY", "ERIS_INFERENCE_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN"])
    assert.ok(isCredentialEnvName(name), name);
  for (const name of ["ERIS_INFERENCE_BASE_URL", "ERIS_INFERENCE_HUB", "ERIS_LLM_MODEL", "CF_ACCESS_CLIENT_SECRET", "ERIS_ARB_SAFETY_BPS"])
    assert.ok(!isCredentialEnvName(name), name);
  // A strategy still sees none of the revision backends' settings.
  for (const name of ["ERIS_INFERENCE_BASE_URL", "ERIS_LLM_MODEL"])
    assert.ok(isSecretEnvName(name), name);
});
