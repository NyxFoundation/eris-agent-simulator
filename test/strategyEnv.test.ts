// The environment a strategy process gets (issue #215): the parent's, less every credential. A
// decide() strategy signs nothing and calls no model, so the wallet key, the inference token and
// the API keys are not its to see -- and a generated strategy that escapes the vm realm must find
// nothing in process.env worth taking.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isStrategySecretEnv,
  strategyEnv,
} from "../example/agents/runtime/strategyEnv.js";

test("strategyEnv: the wallet key, the inference token and every API key are dropped", () => {
  const env = strategyEnv({
    // What the coordinator hands the agent process (core/src/realtime/agentProcess.ts).
    ERIS_AGENT_PRIVATE_KEY: "0xdead",
    ERIS_INFERENCE_TOKEN: "hmac",
    ERIS_INFERENCE_BASE_URL: "http://proxy:8790",
    ERIS_INFERENCE_SECRET: "never here, but if it were",
    ERIS_LLM_MODEL: "gpt-x",
    ERIS_LLM_CALL_TIMEOUT_MS: "1000",
    ERIS_OLLAMA_API_KEY: "ok",
    ERIS_CODEX_BIN: "/usr/bin/codex",
    OPENAI_API_KEY: "sk-1",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    ANTHROPIC_API_KEY: "sk-2",
    OLLAMA_API_KEY: "sk-3",
    // What a self-hosted participant's shell might hold.
    AWS_SECRET_ACCESS_KEY: "aws",
    AWS_ACCESS_KEY_ID: "aws",
    GITHUB_TOKEN: "gh",
    GH_TOKEN: "gh",
    HOMEBREW_GITHUB_API_TOKEN: "gh",
    NPM_TOKEN: "npm",
    DATABASE_PASSWORD: "pw",
    TREASURY_PRIVATE_KEY: "0x1",
    AGENT2_PRIVATE_KEY: "0x2",
    DEPLOYER_PRIVATE_KEY: "0x3",
    MNEMONIC: "test test",
    SOME_SERVICE_AUTH: "basic",
    MY_APP_CREDENTIALS: "json",
    UNSET: undefined,
  });
  assert.deepEqual(env, {}, "nothing of that reaches a strategy");
});

test("strategyEnv: strategy parameters, the runtime's own names and the read transport's credentials stay", () => {
  const kept = {
    // Roster `env`: parameters are the participant's to name, so none of these can be allowlisted.
    ERIS_ARB_SAFETY_BPS: "150",
    ERIS_LAUNCH_TOKEN_BPS: "500",
    ERIS_TROVE_TARGET_ICR: "2.0",
    STAT_ARB_Z_ENTER: "1.5",
    PROFIT_MAX_CEIL_FRACTION: "0.2",
    SEED: "7",
    // The runtime's.
    ERIS_AGENT_ID: "alice",
    ERIS_AGENT_DIR: "/agents/alice",
    ERIS_AGENT_ADDRESS: "0xabc",
    ERIS_RPC_URL: "http://127.0.0.1:8545",
    ERIS_RUN_DIR: "/runs/1",
    ERIS_RUN_BLOCKS: "360",
    ERIS_CONFIG: "/cfg.yaml",
    ERIS_MANIFEST: "/m.json",
    ERIS_LOCAL_DEPLOY: "1",
    ERIS_LIQUIDATION_VICTIMS: "0x1,0x2",
    ERIS_AGENT_FROZEN: "1",
    CHAIN_ID: "31337",
    // The read transport's (sdk/src/chain.ts makeClients): the worker's own reads carry them.
    CF_ACCESS_CLIENT_ID: "id",
    CF_ACCESS_CLIENT_SECRET: "secret",
    ERIS_RPC_HEADERS: '{"x-token":"t"}',
    // The process's.
    PATH: "/usr/bin",
    HOME: "/home/alice",
    NODE_ENV: "development",
    PYTHONPATH: "/sdk-py",
  };
  assert.deepEqual(strategyEnv(kept), kept);
});

test("isStrategySecretEnv: the shapes, by example", () => {
  for (const name of ["ERIS_AGENT_PRIVATE_KEY", "X_API_KEY", "X_APIKEY", "X_TOKEN", "X_SECRET", "X_PASSWORD", "ERIS_LLM_AUTH", "AWS_REGION"])
    assert.equal(isStrategySecretEnv(name), true, name);
  for (const name of ["ERIS_TOKEN_LAUNCH_WINDOW", "ERIS_SECRET_SAUCE_BPS", "TOKENIZER", "ERIS_PRICE_FEED_ADDRESS", "CF_ACCESS_CLIENT_SECRET"])
    assert.equal(isStrategySecretEnv(name), false, name);
});
