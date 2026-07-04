/**
 * 配布用 anvil state dump の生成（ADR 0016 Phase 0）。
 *
 * deployer で全 venue デプロイ済みの稼働中 anvil から anvil_dumpState で state を取り、
 * `anvil --load-state` に直接渡せる plain JSON（venues-state.json）と、生成元を識別する
 * manifest（生成元コミット・anvil バージョン・genesis hash・deployments.json 丸ごと同梱 +
 * canonical fingerprint）を書き出す。constants.local.ts も同じ deployments から再生成し、
 * repo と配布物の fingerprint を一致させる。
 *
 * dump の「クリーン断面」保証は resetFork（sdk/src/chain.ts のローカルモード = .local-snapshot
 * への revert → 再 snapshot → 永続化）に委譲する。snapshot ファイルの形式・stale ID の
 * self-healing はあちらが単一の持ち主（ここで再実装しない）。
 *
 * 前提: deployer の anvil が稼働している（cd deployer && npm run deploy -- --keep-fresh）。
 *
 * 使い方:
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
  // 必須はトークン/Multicall3 のみ（venue は部分デプロイを許す = missingVenues が backtest 側で
  // 検査する）。存在する venue の代表として aave pool があれば併せて確認する。
  const mustHaveCode: Array<[string, string | undefined]> = [
    ["tokens.WETH", deployments.tokens?.WETH],
    ["common.multicall3", deployments.protocols?.common?.multicall3],
  ];
  if (deployments.protocols?.aaveV3?.pool)
    mustHaveCode.push(["aaveV3.pool", deployments.protocols.aaveV3.pool]);
  await Promise.all(
    mustHaveCode.map(async ([what, address]) => {
      if (!address) throw new Error(`deployments.json に ${what} がありません`);
      const code = await rpc<string>(rpcUrl, "eth_getCode", [
        address,
        "latest",
      ]);
      if ((code ?? "0x").length <= 2)
        throw new Error(
          `${what} (${address}) にバイトコードがありません。anvil (${rpcUrl}) は ` +
            `deployments.json のデプロイ先と別インスタンスの可能性があります`,
        );
    }),
  );

  // ---- クリーン断面へ revert（resetFork のローカルモードに委譲）----
  if (!existsSync(snapshotFile))
    console.warn(
      "! クリーン断面 snapshot（.local-snapshot）が無いため、現在の状態を pristine と" +
        "みなして dump します。デプロイ直後の anvil なら問題ありません",
    );
  const { publicClient } = makeClients(rpcUrl, deployments.chainId);
  await resetFork(publicClient, {
    localDeploy: true,
    localSnapshotFile: snapshotFile,
  });

  // ---- dump（hex-gzip → plain JSON。--load-state は plain JSON のみ受け付ける）----
  const hex = await rpc<string>(rpcUrl, "anvil_dumpState");
  const stateJson = gunzipSync(Buffer.from(hex.slice(2), "hex"));
  {
    // 整合検査だけしてパース結果は破棄する（dump は数 MB〜。木を保持しない）。
    const state = JSON.parse(stateJson.toString()) as {
      accounts?: Record<string, unknown>;
    };
    const wethLower = deployments.tokens.WETH.toLowerCase();
    const hasWeth = Object.keys(state.accounts ?? {}).some(
      (a) => a.toLowerCase() === wethLower,
    );
    if (!hasWeth)
      throw new Error(
        "dump に WETH アカウントが含まれていません（dump 不整合）",
      );
  }

  // ---- 書き出し: state + manifest ----
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
    `  commit=${manifest.sourceCommit.slice(0, 12)} chainId=${manifest.chainId} genesis=${genesis.hash.slice(0, 12)}…`,
  );
  console.log(`  fingerprint=${manifest.deploymentsFingerprint.slice(0, 20)}…`);
  console.log(`  実行: npm run backtest -- --regime calm-01`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
