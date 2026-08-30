// The prelude every chain-touching CLI has to run before importing anything else.
//
// Two things have to happen before a single constants-dependent module is loaded:
//
//   1. .env.local is read, because that is where the secrets and endpoints live (RPC URLs, keys).
//   2. ERIS_LOCAL_DEPLOY is decided, because sdk/src/constants.ts overlays the local deployment's
//      addresses **at import time**. A CLI that imports the coordinator first and sets the env after
//      gets the fork's Arbitrum addresses on a chain that has never heard of them -- reads that
//      return nothing, at whatever address the mainnet contract happens to sit.
//
// So a CLI is a two-part thing: this prelude, then a dynamic import of the implementation. It was
// written once inline in sim-realtime.ts; it lives here because the ordering probe (#35) and the
// read-capacity tool (#36) need exactly the same two steps, and a second copy would drift.
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// Load repo-root .env.local (secrets: RPC URLs, agent private keys, ANTHROPIC_API_KEY/OLLAMA_API_KEY;
// see CLAUDE.md). Existing process.env values win, so a shell export still overrides the file.
export function loadEnvLocal(path = ".env.local"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export function wantsLocalDeploy(argv: string[]): boolean {
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

// Call at the top of a CLI, before any other import of this repo's modules.
export function bootstrapCliEnv(argv: string[] = process.argv): void {
  loadEnvLocal();
  if (wantsLocalDeploy(argv)) process.env.ERIS_LOCAL_DEPLOY = "1";
}
