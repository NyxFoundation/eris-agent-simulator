// What a strategy's process.env holds (issue #215).
//
// A decide() strategy runs in a worker thread (strategyRunner.ts) and a Python one in a child
// process (pyBridge.ts). Neither signs anything -- the parent does, in send.ts -- and neither
// talks to a model: the revision loop is the parent's too. So the wallet key, the inference token
// and every API key are secrets those processes have no use for, and until now they inherited all
// of them with the parent's whole environment. For a generated strategy that is the difference
// between a vm escape that finds `process.env` and one that finds nothing in it; for a hand-written
// one it is the difference between an accidental `ctx.log({ state: process.env })` that leaks the
// wallet and one that does not.
//
// A denylist rather than an allowlist, because strategy parameters are the participant's to name:
// the roster's `env` carries `ERIS_ARB_SAFETY_BPS`, `STAT_ARB_Z_ENTER`, `SEED`, ... and all of
// them must reach decide. What is dropped is, by name, a credential.
//
// Kept on purpose: the read transport's own credentials. `makeClients` (sdk/src/chain.ts) puts
// `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` and `ERIS_RPC_HEADERS` on every RPC request,
// and the worker makes its own reads with its own client, so without them a self-hosted agent
// behind the operator's gateway cannot read the chain. They authorize reads the strategy can
// already make, nothing more.

// These names stay, whatever the patterns below say.
const KEEP = new Set([
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "ERIS_RPC_HEADERS",
]);

// Named: the per-agent wallet key and the inference token the coordinator hands the agent process
// (core/src/realtime/agentProcess.ts), and the secret those tokens derive from.
const DROP = new Set([
  "ERIS_AGENT_PRIVATE_KEY",
  "ERIS_INFERENCE_TOKEN",
  "ERIS_INFERENCE_SECRET",
]);

// Families: the revision backends' settings (llm.ts) -- credentials, endpoints and model names
// alike, since a strategy has no call to make -- and the usual cloud credential prefixes.
const DROP_PREFIX = [
  "ERIS_LLM_",
  "ERIS_INFERENCE_",
  "ERIS_OLLAMA_",
  "ERIS_CODEX_",
  "ERIS_CLAUDE_",
  "OPENAI_",
  "ANTHROPIC_",
  "OLLAMA_",
  "AWS_",
  "GITHUB_",
  "GH_",
];

// Shapes: anything that ends in a credential word. Anchored at the end so a parameter that merely
// mentions a token (`ERIS_LAUNCH_TOKEN_BPS`) is not a token.
const DROP_SUFFIX =
  /(^|_)(PRIVATE_KEY|SECRET|SECRET_KEY|API_KEY|APIKEY|ACCESS_KEY|TOKEN|AUTH|PASSWORD|PASSWD|CREDENTIALS?|MNEMONIC)$/i;

export function isStrategySecretEnv(name: string): boolean {
  if (KEEP.has(name)) return false;
  if (DROP.has(name)) return true;
  if (DROP_PREFIX.some((prefix) => name.startsWith(prefix))) return true;
  return DROP_SUFFIX.test(name);
}

// The environment a strategy process gets: the parent's, less the secrets above. Undefined values
// are dropped as well, so the result can be handed to a Worker or a spawn as it is.
export function strategyEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isStrategySecretEnv(name)) continue;
    out[name] = value;
  }
  return out;
}
