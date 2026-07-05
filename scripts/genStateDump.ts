/**
 * Generate a distributable anvil state dump (ADR 0016 Phase 0).
 *
 * Take state via anvil_dumpState from a running anvil that has all venues deployed by the deployer,
 * and write out plain JSON (venues-state.json) that can be passed directly to `anvil --load-state`,
 * plus a manifest identifying the source (source commit, anvil version, genesis hash, the entire
 * deployments.json bundled + canonical fingerprint). constants.local.ts is also regenerated from the
 * same deployments so the repo and the distributable share the same fingerprint.
 *
 * The "clean snapshot" guarantee for the dump is delegated to resetFork (sdk/src/chain.ts's local mode
 * = revert to .local-snapshot -> re-snapshot -> persist). The snapshot file format and stale-ID
 * self-healing have their single owner there (not reimplemented here).
 *
 * Prerequisite: the deployer's anvil is running (cd deployer && npm run deploy -- --keep-fresh).
 *
 * Usage:
 *   npm run gen:state-dump
 *   npm run gen:state-dump -- --rpc http://127.0.0.1:8545 --out backtest/state
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  deploymentsFingerprint,
  gitHead,
  MANIFEST_FILE_NAME,
  parseFlags,
  rpc,
  STATE_DIR_DEFAULT,
  STATE_FILE_NAME,
  type StateManifest,
} from "../core/src/backtest/shared.js";
import { makeClients, resetFork } from "../sdk/src/chain.js";
import { generateLocalConstants } from "./genLocalConstants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  const rpcUrl = flags.rpc ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const outDir = resolve(ROOT, flags.out ?? STATE_DIR_DEFAULT);
  const deploymentsPath = resolve(
    ROOT,
    flags.deployments ?? "deployer/deployments/deployments.json",
  );
  const snapshotFile = resolve(
    ROOT,
    flags["snapshot-file"] ?? ".local-snapshot",
  );

  // ---- Prerequisite checks: anvil running + deployments.json + bytecode at representative addresses ----
  const anvilVersion = await rpc<string>(rpcUrl, "web3_clientVersion").catch(
    () => {
      throw new Error(
        `anvil not reachable at ${rpcUrl}. Start the deployer's anvil ` +
          `(cd deployer && npm run deploy -- --keep-fresh)`,
      );
    },
  );
  if (!existsSync(deploymentsPath))
    throw new Error(`deployments.json not found: ${deploymentsPath}`);
  const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8")) as {
    chainId: number;
    tokens: Record<string, string>;
    protocols: {
      common?: { multicall3?: string };
      aaveV3?: { pool?: string };
    };
  };
  // Only tokens/Multicall3 are required (venues may be partially deployed = missingVenues is checked on
  // the backtest side). If an aave pool exists as a representative of a present venue, verify it too.
  const mustHaveCode: Array<[string, string | undefined]> = [
    ["tokens.WETH", deployments.tokens?.WETH],
    ["common.multicall3", deployments.protocols?.common?.multicall3],
  ];
  if (deployments.protocols?.aaveV3?.pool)
    mustHaveCode.push(["aaveV3.pool", deployments.protocols.aaveV3.pool]);
  await Promise.all(
    mustHaveCode.map(async ([what, address]) => {
      if (!address) throw new Error(`deployments.json is missing ${what}`);
      const code = await rpc<string>(rpcUrl, "eth_getCode", [
        address,
        "latest",
      ]);
      if ((code ?? "0x").length <= 2)
        throw new Error(
          `${what} (${address}) has no bytecode. anvil (${rpcUrl}) may be a different ` +
            `instance than where deployments.json was deployed`,
        );
    }),
  );

  // ---- Revert to the clean snapshot (delegated to resetFork's local mode) ----
  if (!existsSync(snapshotFile))
    console.warn(
      "! No clean snapshot (.local-snapshot), so the current state is treated as pristine " +
        "and dumped. That is fine for an anvil right after deploy",
    );
  const { publicClient } = makeClients(rpcUrl, deployments.chainId);
  await resetFork(publicClient, {
    localDeploy: true,
    localSnapshotFile: snapshotFile,
  });

  // ---- dump (hex-gzip -> plain JSON. --load-state only accepts plain JSON) ----
  const hex = await rpc<string>(rpcUrl, "anvil_dumpState");
  const stateJson = gunzipSync(Buffer.from(hex.slice(2), "hex"));
  {
    // Only run the consistency check and discard the parsed result (the dump is several MB+; do not keep the tree).
    const state = JSON.parse(stateJson.toString()) as {
      accounts?: Record<string, unknown>;
    };
    const wethLower = deployments.tokens.WETH.toLowerCase();
    const hasWeth = Object.keys(state.accounts ?? {}).some(
      (a) => a.toLowerCase() === wethLower,
    );
    if (!hasWeth)
      throw new Error(
        "the dump does not contain a WETH account (dump inconsistency)",
      );
  }

  // ---- Write: state + manifest ----
  mkdirSync(outDir, { recursive: true });
  const statePath = join(outDir, STATE_FILE_NAME);
  writeFileSync(statePath, stateJson);

  const genesis = await rpc<{ hash: string }>(rpcUrl, "eth_getBlockByNumber", [
    "0x0",
    false,
  ]);
  const manifest: StateManifest = {
    schema: 1,
    createdAt: new Date().toISOString(),
    sourceCommit: gitHead(ROOT) ?? "unknown",
    anvilVersion,
    chainId: deployments.chainId,
    genesisHash: genesis.hash,
    stateFile: STATE_FILE_NAME,
    deploymentsFingerprint: deploymentsFingerprint(deployments),
    deployments: deployments as unknown as Record<string, unknown>,
  };
  const manifestPath = join(outDir, MANIFEST_FILE_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // ---- Regenerate constants.local.ts from the same deployments (align the repo and distributable fingerprints) ----
  const gen = generateLocalConstants(deploymentsPath);
  if (gen.fingerprint !== manifest.deploymentsFingerprint)
    throw new Error(
      `internal: constants fingerprint (${gen.fingerprint}) != manifest (${manifest.deploymentsFingerprint})`,
    );

  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log(`✓ state dump: ${statePath} (${mb(stateJson.length)})`);
  console.log(`✓ manifest:   ${manifestPath}`);
  console.log(
    `  commit=${manifest.sourceCommit.slice(0, 12)} chainId=${manifest.chainId} genesis=${genesis.hash.slice(0, 12)}…`,
  );
  console.log(`  fingerprint=${manifest.deploymentsFingerprint.slice(0, 20)}…`);
  console.log(`  run: npm run backtest -- --regime calm-01`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
