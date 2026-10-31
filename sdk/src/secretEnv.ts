// Which environment variable names are credentials (issue #215).
//
// Two sides read this one list. The agent runtime keeps these names out of every strategy process
// it starts (example/agents/runtime/strategyEnv.ts). The coordinator keeps the credentials among
// them out of the agent process's own environment and writes them to its stdin instead
// (core/src/realtime/agentProcess.ts): on Linux a process's environment at exec stays readable at
// /proc/<pid>/environ for its whole life, by any process of the same uid -- the strategy process
// the runtime forks among them -- and dropping a name from process.env later does not change it.
//
// A denylist rather than an allowlist, because strategy parameters are the participant's to name:
// the roster's `env` carries `ERIS_ARB_SAFETY_BPS`, `STAT_ARB_Z_ENTER`, `SEED`, ... and all of
// them must reach decide. What is dropped is, by name, a credential.
//
// Kept on purpose: the read transport's own credentials. `makeClients` (sdk/src/chain.ts) puts
// `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` and `ERIS_RPC_HEADERS` on every RPC request,
// and the strategy makes its own reads with its own client, so without them a self-hosted agent
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

// A credential by name: what the coordinator moves from an agent's environment to its stdin. Not
// the families: an endpoint or a model name (ERIS_INFERENCE_BASE_URL, ERIS_INFERENCE_HUB,
// ERIS_LLM_MODEL) is no secret, and the docker wrapper reads some of them to set up the network.
export function isCredentialEnvName(name: string): boolean {
  if (KEEP.has(name)) return false;
  if (DROP.has(name)) return true;
  return DROP_SUFFIX.test(name);
}

// What a strategy process does not get: the credentials, and the revision backends' whole families
// besides, since a strategy has no call to make.
export function isSecretEnvName(name: string): boolean {
  if (isCredentialEnvName(name)) return true;
  if (KEEP.has(name)) return false;
  return DROP_PREFIX.some((prefix) => name.startsWith(prefix));
}
