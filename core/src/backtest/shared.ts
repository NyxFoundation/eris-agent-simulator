// Shared helpers for participant backtest (ADR 0016): state dump manifest / fingerprint / regime resolution.
//
// The backtest CLI is evaluated before importing sdk/constants (before setting ERIS_LOCAL_DEPLOY,
// before syncing constants.local.ts), so this module depends only on node built-ins
// (it carries no transitive import into sdk).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const STATE_DIR_DEFAULT = "backtest/state";
export const STATE_FILE_NAME = "venues-state.json";
export const MANIFEST_FILE_NAME = "manifest.json";
export const REGIMES_DIR = "config/regimes";

// Lightweight parser for `--key value` / `--key=value` / `--flag`. Same semantics as parseCliFlags in
// core/src/runConfig.ts (that one transitively imports sdk/constants, so backtest tools evaluated before
// the env is set use this one).
export function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) out[body.slice(0, eq)] = body.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"))
      out[body] = argv[++i];
    else out[body] = "1";
  }
  return out;
}

// A bare JSON-RPC call (no viem: this is evaluated before the env is set).
export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (body.error)
    throw new Error(`${method} failed: ${body.error.message ?? "unknown"}`);
  return body.result as T;
}

export async function isAnvilUp(url: string): Promise<boolean> {
  try {
    await rpc(url, "web3_clientVersion");
    return true;
  } catch {
    return false;
  }
}

export async function waitUntilAnvilUp(
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isAnvilUp(url)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`anvil did not come up at ${url}`);
}

// The current git HEAD (keeps generating and checking the manifest's sourceCommit on the same implementation).
export function gitHead(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

// The state dump manifest (part of the distributed artifact. ADR 0016 §2).
// Bundling deployments in full = the participant can regenerate constants.local.ts
// (we don't require participants to run gen:local-constants).
export type StateManifest = {
  schema: 1;
  createdAt: string;
  // The generating poc commit (drift detection; a mismatch warns).
  sourceCommit: string;
  anvilVersion: string;
  chainId: number;
  // The generating anvil's genesis block hash. Checked after --load-state to fail-fast
  // on a mix-up with a different state.
  genesisHash: string;
  // Filename of the state body (relative to the manifest).
  stateFile: string;
  // Canonical fingerprint of deployments. Checked against the value stamped in constants.local.ts.
  deploymentsFingerprint: string;
  // The full deployer/deployments/deployments.json embedded.
  deployments: Record<string, unknown>;
};

// Canonical JSON independent of key order (stabilizes the fingerprint input).
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deploymentsFingerprint(deployments: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(deployments)).digest("hex")}`;
}

export function validateStateManifest(
  raw: unknown,
  source: string,
): StateManifest {
  const fail = (what: string): never => {
    throw new Error(`invalid state manifest (${source}): ${what}`);
  };
  if (!raw || typeof raw !== "object") fail("not an object");
  const m = raw as Partial<StateManifest>;
  if (m.schema !== 1) fail(`unsupported schema: ${String(m.schema)}`);
  for (const key of [
    "createdAt",
    "sourceCommit",
    "anvilVersion",
    "genesisHash",
    "stateFile",
    "deploymentsFingerprint",
  ] as const) {
    if (typeof m[key] !== "string" || m[key].length === 0)
      fail(`missing ${key}`);
  }
  if (typeof m.chainId !== "number") fail("missing chainId");
  if (!m.deployments || typeof m.deployments !== "object")
    fail("missing deployments");
  const fp = deploymentsFingerprint(m.deployments);
  if (fp !== m.deploymentsFingerprint)
    fail(
      `deploymentsFingerprint mismatch (manifest ${m.deploymentsFingerprint} != computed ${fp})`,
    );
  return m as StateManifest;
}

export function readStateManifest(stateDir: string): {
  manifest: StateManifest;
  statePath: string;
} {
  const manifestPath = join(stateDir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath))
    throw new Error(
      `state manifest not found: ${manifestPath}. First generate a state dump with ` +
        `\`npm run gen:state-dump\` (requires a running anvil already deployed by the deployer), ` +
        `or point --state at a distributed state directory (ADR 0016 §2)`,
    );
  const manifest = validateStateManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    manifestPath,
  );
  const statePath = join(stateDir, manifest.stateFile);
  if (!existsSync(statePath))
    throw new Error(
      `state file not found: ${statePath} (manifest exists but the state body is missing)`,
    );
  return { manifest, statePath };
}

// Read the fingerprint stamped in constants.local.ts as text. Reading it via import would leave
// stale constants in the module cache so the regenerated value wouldn't be reflected in-process,
// hence a regex extraction.
export function readConstantsFingerprint(
  constantsPath: string,
): string | undefined {
  if (!existsSync(constantsPath)) return undefined;
  const text = readFileSync(constantsPath, "utf8");
  const m = text.match(/^export const DEPLOYMENTS_FINGERPRINT = "([^"]+)";$/m);
  return m?.[1];
}

// Mapping from a regime's protocols to the protocols keys in deployments.json.
const VENUE_TO_DEPLOYMENT_KEY: Record<string, string> = {
  uniswap: "uniswapV3",
  balancer: "balancerV2",
  curve: "curve",
  gmx: "gmxV2",
  aave: "aaveV3",
};

// Whether the venues the regime requires are all present in the state dump (deployments bundled in
// the manifest). Returns an array of missing venue names (empty = OK). A pre-check to fail-fast before
// dying on a cryptic zero-address call error (ADR 0016 §2).
// A protocol name absent from the mapping is also treated as missing, fail-closed (prevents a missed
// update to this table when adding a new venue from turning into "check passes -> zero-address read").
export function missingVenues(
  protocols: string[],
  deployments: Record<string, unknown>,
): string[] {
  const deployed = (deployments.protocols ?? {}) as Record<string, unknown>;
  return protocols.filter((p) => {
    const key = VENUE_TO_DEPLOYMENT_KEY[p];
    return key === undefined || !deployed[key];
  });
}

// Resolve --regime: a path form (contains / or ends in .yaml/.yml) is used as-is, a name looks up
// config/regimes/<name>.yaml. If not found, fail with a list of available regimes.
export function resolveRegimePath(root: string, regime: string): string {
  const isPath =
    regime.includes("/") || regime.endsWith(".yaml") || regime.endsWith(".yml");
  const candidate = isPath
    ? resolve(root, regime)
    : resolve(root, REGIMES_DIR, `${regime}.yaml`);
  if (existsSync(candidate)) return candidate;
  const dir = resolve(root, REGIMES_DIR);
  const available = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.replace(/\.yaml$/, ""))
        .join(", ") || "(empty)"
    : "(none)";
  throw new Error(
    `regime not found: ${regime} (${candidate}). available: ${available}`,
  );
}
