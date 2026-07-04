/**
 * 配布用 anvil state dump の生成（ADR 0016 Phase 0）。
 *
 * deployer で全 venue デプロイ済みの稼働中 anvil から anvil_dumpState で state を取り、
 * `anvil --load-state` に直接渡せる plain JSON（venues-state.json）と、生成元を識別する
 * manifest（生成元コミット・anvil バージョン・genesis hash・deployments.json 丸ごと同梱 +
 * canonical fingerprint）を書き出す。constants.local.ts も同じ deployments から再生成し、
 * repo と配布物の fingerprint を一致させる。
 *
 * dump は「クリーン断面」を保証するため、.local-snapshot が現 anvil のものなら revert してから
 * 取る（revert 後に snapshot を取り直して .local-snapshot を更新するので、稼働中 anvil の
 * 以後の run 運用は壊さない）。
 *
 * 前提: deployer の anvil が稼働している（cd deployer && npm run deploy -- --keep-fresh）。
 *
 * 使い方:
 *   npm run gen:state-dump
 *   npm run gen:state-dump -- --rpc http://127.0.0.1:8545 --out backtest/state
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  deploymentsFingerprint,
  MANIFEST_FILE_NAME,
  STATE_DIR_DEFAULT,
  STATE_FILE_NAME,
  type StateManifest,
} from "../core/src/backtest/shared.js";
import { generateLocalConstants } from "./genLocalConstants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function parseFlags(argv: string[]): Record<string, string> {
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

async function rpc<T = unknown>(
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

async function codeLen(url: string, address: string): Promise<number> {
  const code = await rpc<string>(url, "eth_getCode", [address, "latest"]);
  return (code ?? "0x").length;
}

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

  // ---- 前提検査: anvil 稼働 + deployments.json + 代表アドレスのバイトコード ----
  const anvilVersion = await rpc<string>(rpcUrl, "web3_clientVersion").catch(
    () => {
      throw new Error(
        `anvil not reachable at ${rpcUrl}。deployer の anvil を起動してください ` +
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
  const mustHaveCode: Array<[string, string | undefined]> = [
    ["tokens.WETH", deployments.tokens?.WETH],
    ["common.multicall3", deployments.protocols?.common?.multicall3],
    ["aaveV3.pool", deployments.protocols?.aaveV3?.pool],
  ];
  for (const [what, address] of mustHaveCode) {
    if (!address) throw new Error(`deployments.json に ${what} がありません`);
    if ((await codeLen(rpcUrl, address)) <= 2)
      throw new Error(
        `${what} (${address}) にバイトコードがありません。anvil (${rpcUrl}) は ` +
          `deployments.json のデプロイ先と別インスタンスの可能性があります`,
      );
  }

  // ---- クリーン断面へ revert（.local-snapshot が現 anvil のものなら）----
  const genesis = await rpc<{ hash: string }>(rpcUrl, "eth_getBlockByNumber", [
    "0x0",
    false,
  ]);
  let reverted = false;
  if (existsSync(snapshotFile)) {
    const [hash, id] = readFileSync(snapshotFile, "utf8").trim().split(":");
    if (hash === genesis.hash && id) {
      reverted = await rpc<boolean>(rpcUrl, "evm_revert", [id]).catch(
        () => false,
      );
    }
  }
  if (reverted) {
    console.log(
      "✓ .local-snapshot のクリーン断面へ revert してから dump します",
    );
  } else {
    console.warn(
      "! クリーン断面 snapshot が見つからない（またはこの anvil のものでない）ため、" +
        "現在の状態をそのまま dump します。デプロイ直後の anvil なら問題ありません",
    );
  }

  // ---- dump（hex-gzip → plain JSON。--load-state は plain JSON のみ受け付ける）----
  const hex = await rpc<string>(rpcUrl, "anvil_dumpState");
  const stateJson = gunzipSync(Buffer.from(hex.slice(2), "hex"));
  const state = JSON.parse(stateJson.toString()) as {
    accounts?: Record<string, unknown>;
  };
  const accounts = new Set(
    Object.keys(state.accounts ?? {}).map((a) => a.toLowerCase()),
  );
  if (!accounts.has(deployments.tokens.WETH.toLowerCase()))
    throw new Error("dump に WETH アカウントが含まれていません（dump 不整合）");

  // ---- revert で消費した snapshot を取り直し、.local-snapshot を更新（運用を壊さない）----
  if (reverted) {
    const newId = await rpc<string>(rpcUrl, "evm_snapshot");
    writeFileSync(snapshotFile, `${genesis.hash}:${newId}`);
  }

  // ---- 書き出し: state + manifest ----
  mkdirSync(outDir, { recursive: true });
  const statePath = join(outDir, STATE_FILE_NAME);
  writeFileSync(statePath, stateJson);

  const sourceCommit = (() => {
    try {
      return execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
    } catch {
      return "unknown";
    }
  })();
  const chainIdHex = await rpc<string>(rpcUrl, "eth_chainId");
  const manifest: StateManifest = {
    schema: 1,
    createdAt: new Date().toISOString(),
    sourceCommit,
    anvilVersion,
    chainId: Number(chainIdHex),
    genesisHash: genesis.hash,
    stateFile: STATE_FILE_NAME,
    deploymentsFingerprint: deploymentsFingerprint(deployments),
    deployments: deployments as unknown as Record<string, unknown>,
  };
  const manifestPath = join(outDir, MANIFEST_FILE_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // ---- constants.local.ts を同じ deployments から再生成（repo と配布物の fingerprint を揃える）----
  const gen = generateLocalConstants(deploymentsPath);
  if (gen.fingerprint !== manifest.deploymentsFingerprint)
    throw new Error(
      `internal: constants fingerprint (${gen.fingerprint}) != manifest (${manifest.deploymentsFingerprint})`,
    );

  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
  console.log(`✓ state dump: ${statePath} (${mb(stateJson.length)})`);
  console.log(`✓ manifest:   ${manifestPath}`);
  console.log(
    `  commit=${sourceCommit.slice(0, 12)} chainId=${manifest.chainId} genesis=${genesis.hash.slice(0, 12)}…`,
  );
  console.log(`  fingerprint=${manifest.deploymentsFingerprint.slice(0, 20)}…`);
  console.log(`  実行: npm run backtest -- --regime calm-01`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
