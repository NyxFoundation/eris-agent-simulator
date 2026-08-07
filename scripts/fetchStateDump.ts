/**
 * Fetch the backtest state body that the checked-in manifest names (ADR 0016 §2).
 *
 * The state dump is tens of megabytes and is rewritten wholesale every time it is regenerated, so
 * it lives as a GitHub release asset rather than in git. What *is* in git is the manifest: the
 * fingerprint, the genesis hash and the full deployments. That manifest names exactly one release
 * (derived from the generating commit), so there is no "latest" for the repository and the asset to
 * drift apart -- checking out an older commit fetches the dump that commit was built against.
 *
 * Usage:
 *   npm run fetch:state-dump                 # into backtest/state, from the repo's origin remote
 *   npm run fetch:state-dump -- --state <dir> --repo <owner/name> --force
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  MANIFEST_FILE_NAME,
  releaseTagFor,
  validateStateManifest,
} from "../core/src/backtest/shared.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR_DEFAULT = "backtest/state";

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = "1";
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

// owner/name from the origin remote, so a fork fetches its own assets.
function repoSlug(): string {
  const url = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (!match)
    throw new Error(
      `could not read owner/name from the origin remote (${url}); pass --repo <owner/name>`,
    );
  return match[1];
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const stateDir = resolve(ROOT, flags.state ?? STATE_DIR_DEFAULT);
  const manifestPath = join(stateDir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath))
    throw new Error(
      `no manifest at ${manifestPath}. The manifest is committed to the repository; ` +
        `if it is missing, generate a dump locally with \`npm run gen:state-dump\` instead`,
    );
  const manifest = validateStateManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    manifestPath,
  );

  const statePath = join(stateDir, manifest.stateFile);
  if (existsSync(statePath) && flags.force !== "1") {
    // Only skip when the existing body is the one the manifest asks for.
    const have = createHash("sha256")
      .update(readFileSync(statePath))
      .digest("hex");
    if (!manifest.stateSha256 || have === manifest.stateSha256) {
      console.log(`already present: ${statePath} (use --force to re-download)`);
      return;
    }
    console.log(
      "existing state body does not match the manifest; re-downloading",
    );
  }

  const repo = flags.repo ?? repoSlug();
  const tag = releaseTagFor(manifest);
  const asset = `${manifest.stateFile}.gz`;
  const url = `https://github.com/${repo}/releases/download/${tag}/${asset}`;
  console.log(`fetching ${url}`);

  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `download failed (${response.status} ${response.statusText}): ${url}\n` +
        `The manifest was generated at commit ${manifest.sourceCommit.slice(0, 12)}, so it expects ` +
        `release "${tag}". If that release does not exist yet, publish it from a machine that ran ` +
        `\`npm run gen:state-dump\` (the command is printed there).`,
    );

  const gz = Buffer.from(await response.arrayBuffer());
  const state = gunzipSync(gz);

  // Verify before writing: a truncated or wrong-release download would otherwise surface much later
  // as a confusing genesis-hash mismatch inside the backtest.
  if (manifest.stateSha256) {
    const got = createHash("sha256").update(state).digest("hex");
    if (got !== manifest.stateSha256)
      throw new Error(
        `checksum mismatch: manifest ${manifest.stateSha256}, downloaded ${got}`,
      );
  }
  if (manifest.stateBytes !== undefined && state.length !== manifest.stateBytes)
    throw new Error(
      `size mismatch: manifest ${manifest.stateBytes} bytes, downloaded ${state.length}`,
    );

  writeFileSync(statePath, state);
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log(
    `✓ ${statePath} (${mb(state.length)}, ${mb(gz.length)} compressed)` +
      `${manifest.stateSha256 ? " — checksum ok" : " — manifest has no checksum, not verified"}`,
  );
  console.log("  run: npm run backtest -- --regime calm-01");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
