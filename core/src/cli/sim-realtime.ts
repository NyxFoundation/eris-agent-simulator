// Local deploy: `src/constants.ts` reads `process.env.ERIS_LOCAL_DEPLOY` **at import time**
// and overlays LOCAL_DEPLOYMENT (local addresses for WETH/USDC/WBTC, etc.). So for config
// `run.localDeploy: true` / CLI `--local-deploy` to take effect, the env must be set **before**
// loading the coordinator (or runConfig -> markets -> constants) that indirectly imports constants.
// Here we peek lightly at the config/CLI with just yaml + fs (without importing any constants-dependent
// module) to set the env, then dynamically import the coordinator.
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// Load repo-root .env.local (secrets: RPC URLs, agent private keys, ANTHROPIC_API_KEY/OLLAMA_API_KEY;
// see CLAUDE.md). Existing process.env values win, so a shell export still overrides the file.
function loadEnvLocal(path = ".env.local"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadEnvLocal();

function wantsLocalDeploy(argv: string[]): boolean {
  if (process.env.ERIS_LOCAL_DEPLOY === "1") return true;
  if (argv.includes("--local-deploy")) return true;
  // Config file resolution order: --config > ERIS_CONFIG > config/local.yaml > config/example.yaml
  // (kept consistent with resolveConfigPathOrUndefined in runConfig.ts).
  const i = argv.indexOf("--config");
  const path =
    (i >= 0 ? argv[i + 1] : undefined) ??
    process.env.ERIS_CONFIG ??
    (existsSync("config/local.yaml") ? "config/local.yaml" : undefined) ??
    (existsSync("config/example.yaml") ? "config/example.yaml" : undefined);
  if (!path || !existsSync(path)) return false;
  try {
    const doc = parseYaml(readFileSync(path, "utf8")) as {
      run?: { localDeploy?: unknown };
    };
    return doc?.run?.localDeploy === true;
  } catch {
    return false;
  }
}

if (wantsLocalDeploy(process.argv)) process.env.ERIS_LOCAL_DEPLOY = "1";

// Evaluate constants-dependent modules only after the env is set (dynamically, since static imports are hoisted).
const { runRealtimeSimulation } = await import("../realtime/coordinator.js");

runRealtimeSimulation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
