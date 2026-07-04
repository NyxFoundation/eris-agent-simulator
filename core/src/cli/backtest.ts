// participant backtest CLI（ADR 0016。B1 実時間再生）。
//
//   npm run backtest -- --regime <name|path> [--agents <roster>] [--repeat N]
//                       [--port 8547] [--state backtest/state] [--keep-anvil]
//                       [--seed N] [--blocks N] [--seconds N] [--protocols a,b]
//
// 配布された state dump（gen:state-dump 生成）をロードした専用 anvil を起動し、公式 regime
// （config/regimes/*.yaml + seed）を既存 coordinator で再生する。--repeat N は同一プロセスで
// coordinator を反復呼び出しし、resetFork の evm_snapshot/evm_revert が run 間のクリーン断面を
// 保証する（採点再構成は各 run 末尾 = 次の revert の前に完了する）。
//
// sim-realtime.ts と同じ理由で dependency-light: sdk/constants を import する前に
// ERIS_LOCAL_DEPLOY=1 を立て、constants.local.ts の fingerprint 同期を済ませる必要がある。
// coordinator は最後に動的 import する。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  gitHead,
  isAnvilUp,
  missingVenues,
  parseFlags,
  readConstantsFingerprint,
  readStateManifest,
  resolveRegimePath,
  rpc,
  STATE_DIR_DEFAULT,
  waitUntilAnvilUp,
} from "../backtest/shared.js";

const ROOT = process.cwd(); // npm scripts は repo root で走る

const USAGE = `usage: npm run backtest -- --regime <name|path> [options]
  --regime <name|path>   config/regimes/<name>.yaml（または YAML パス）。必須
  --agents <roster>      ロスターファイル（YAML/JSON）で regime 既定の agents を差し替え
  --repeat <N>           同一 regime を N 回反復（snapshot/revert。既定 1）
  --port <N>             backtest 専用 anvil のポート（既定 8547）
  --state <dir>          state dump ディレクトリ（既定 ${STATE_DIR_DEFAULT}）
  --keep-anvil           終了後も anvil を残す（デバッグ用）
  --seed/--blocks/--seconds/--protocols/--economic-gas
                         regime 値の一回限り上書き（スモーク用。成績を読む run は regime 既定で）`;

type AgentSummary = { id: string; alphaUsdc?: number; netPnlUsdc?: number };
type RunSummary = {
  runDir: string;
  blocksProcessed?: number;
  agents: AgentSummary[];
};

function readRunSummary(runDir: string): RunSummary | undefined {
  const path = join(runDir, "summary.json");
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    blocksProcessed?: number;
    agents?: AgentSummary[];
  };
  return {
    runDir,
    blocksProcessed: parsed.blocksProcessed,
    agents: parsed.agents ?? [],
  };
}

// constants.local.ts を state manifest の同梱 deployments と同期する（ADR 0016 §2）。
// 不一致なら manifest から deployments を抽出して再生成し、それでも一致しない場合は
// state dump と repo バージョンの組合せ違い → fail-fast。
async function syncConstants(
  manifestFingerprint: string,
  deployments: Record<string, unknown>,
  stateDirAbs: string,
): Promise<void> {
  const constantsPath = resolve(ROOT, "sdk", "src", "constants.local.ts");
  const current = readConstantsFingerprint(constantsPath);
  if (current === manifestFingerprint) return;
  console.error(
    `[backtest] constants.local.ts の fingerprint が state manifest と不一致 ` +
      `(${current ?? "(none)"} != ${manifestFingerprint})。manifest 同梱の deployments から再生成します`,
  );
  const extracted = join(stateDirAbs, "deployments.extracted.json");
  writeFileSync(extracted, `${JSON.stringify(deployments, null, 2)}\n`);
  // genLocalConstants は node builtins + viem + backtest/shared にしか依存しない
  // （sdk/constants を評価しない）ので、coordinator より先に import してよい。
  const { generateLocalConstants } =
    await import("../../../scripts/genLocalConstants.js");
  const { fingerprint } = generateLocalConstants(extracted);
  if (fingerprint !== manifestFingerprint)
    throw new Error(
      `constants.local.ts を再生成しても fingerprint が一致しません ` +
        `(${fingerprint} != ${manifestFingerprint})。state dump と repo の ` +
        `バージョンの組合せを確認してください（ADR 0016 §2 fail-fast）`,
    );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  if (!flags.regime) {
    console.error(USAGE);
    throw new Error("--regime is required");
  }
  if (flags.config)
    throw new Error(
      "backtest では --config でなく --regime を使ってください（regime YAML が run の設定そのもの）",
    );

  const repeat = Number(flags.repeat ?? "1");
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new Error(
      `--repeat must be a positive integer (got ${flags.repeat})`,
    );
  const port = Number(flags.port ?? "8547");
  const rpcUrl = `http://127.0.0.1:${port}`;
  const stateDirAbs = resolve(ROOT, flags.state ?? STATE_DIR_DEFAULT);
  const regimePath = resolveRegimePath(ROOT, flags.regime);
  const regimeName = basename(regimePath).replace(/\.ya?ml$/, "");

  // ---- state manifest の検証 + constants 同期（coordinator import 前に済ませる）----
  const { manifest, statePath } = readStateManifest(stateDirAbs);
  const head = gitHead(ROOT);
  if (
    head &&
    manifest.sourceCommit !== "unknown" &&
    head !== manifest.sourceCommit
  )
    console.error(
      `[backtest] 注意: state dump の生成元コミット (${manifest.sourceCommit.slice(0, 12)}) と ` +
        `現在の HEAD (${head.slice(0, 12)}) が異なります。deployer/constants を変えた場合は ` +
        `npm run gen:state-dump で焼き直してください`,
    );
  await syncConstants(
    manifest.deploymentsFingerprint,
    manifest.deployments,
    stateDirAbs,
  );

  // ---- regime の軽量読取 + 一回限り override の反映（実効 regime）----
  // run の override（--protocols 等）は coordinator の cliOverrides だけでは足りない: agent
  // プロセスは ERIS_CONFIG の YAML を直接読むため、override をマージした「実効 regime YAML」を
  // 書き出して coordinator と agent が同一設定を読むようにする（そうしないと agent が state に
  // 無い venue を観測しようとしてゼロアドレス read で死ぬ）。--agents の roster も同じ理由で
  // 実効 YAML の inline agents に焼き込む（core のロスター解決に優先順位の分岐を足さない）。
  type RegimeDoc = {
    run?: Record<string, unknown> & {
      seed?: number;
      protocols?: string[];
    };
    agents?: unknown;
  } & Record<string, unknown>;
  const regimeDoc = parseYaml(readFileSync(regimePath, "utf8")) as RegimeDoc;

  const runOverrides: Record<string, unknown> = {};
  if (flags.protocols)
    runOverrides.protocols = flags.protocols.split(",").map((s) => s.trim());
  if (flags.seed !== undefined) runOverrides.seed = Number(flags.seed);
  if (flags.blocks !== undefined) runOverrides.blocks = Number(flags.blocks);
  if (flags.seconds !== undefined) runOverrides.seconds = Number(flags.seconds);
  if (flags["economic-gas"] !== undefined)
    runOverrides.economicGas =
      flags["economic-gas"] === "1" || flags["economic-gas"] === "true";

  let rosterAgents: unknown;
  if (flags.agents !== undefined) {
    const rosterPath = resolve(ROOT, flags.agents);
    if (!existsSync(rosterPath))
      throw new Error(`agents roster not found: ${rosterPath} (--agents)`);
    // JSON は YAML 1.2 のサブセットなので .json ロスターも parseYaml で読める。
    // 中身の検証は coordinator の validateAgentsFile に任せる。
    const roster = parseYaml(readFileSync(rosterPath, "utf8")) as {
      agents?: unknown;
    };
    if (!roster || !Array.isArray(roster.agents))
      throw new Error(`${rosterPath} must contain an "agents" array`);
    rosterAgents = roster.agents;
  }

  let effectiveRegimePath = regimePath;
  if (Object.keys(runOverrides).length > 0 || rosterAgents !== undefined) {
    const effective: RegimeDoc = {
      ...regimeDoc,
      run: { ...(regimeDoc.run ?? {}), ...runOverrides },
      ...(rosterAgents !== undefined ? { agents: rosterAgents } : {}),
    };
    effectiveRegimePath = join(stateDirAbs, `.effective-${regimeName}.yaml`);
    writeFileSync(
      effectiveRegimePath,
      `# AUTO-GENERATED by backtest CLI — ${regimePath} + CLI overrides。手で編集しない。\n` +
        stringifyYaml(effective),
    );
    const overridden = [
      ...Object.keys(runOverrides),
      ...(rosterAgents !== undefined ? ["agents"] : []),
    ];
    console.error(
      `[backtest] override あり（${overridden.join(", ")}）→ 実効 regime を ${effectiveRegimePath} に書き出しました。` +
        `成績を読む run は regime 既定値で回すこと（ADR 0016 §3）`,
    );
  }

  // regime が要求する venue が state dump に揃っているか。欠けたままだとゼロアドレスへの
  // eth_call で意味不明なエラーになるため先に fail-fast する。
  const effectiveProtocols =
    (runOverrides.protocols as string[] | undefined) ??
    regimeDoc?.run?.protocols ??
    [];
  const missing = missingVenues(effectiveProtocols, manifest.deployments);
  if (missing.length > 0)
    throw new Error(
      `state dump に venue が足りません: ${missing.join(", ")}。full deploy から ` +
        `npm run gen:state-dump で焼き直すか、--protocols で対象 venue を絞ってください` +
        `（例: --protocols ${effectiveProtocols.filter((p) => !missing.includes(p)).join(",")}）`,
    );

  // ---- backtest 専用 anvil（--load-state）----
  if (await isAnvilUp(rpcUrl))
    throw new Error(
      `port ${port} は使用中です（deployer anvil 等を巻き込まないため fail-fast）。` +
        `--port で別ポートを指定してください`,
    );
  console.error(
    `[backtest] anvil 起動（--load-state ${statePath} / port ${port}）`,
  );
  const anvil: ChildProcess = spawn(
    "anvil",
    [
      "--port",
      String(port),
      // deployer の anvil（deployer/src/anvil.ts startAnvil）と同じ較正
      // （code-size/base-fee/gas-limit）。あちらを変えるときはここも合わせる。
      // --order fees だけは本番 realtime と揃える意図的な追加。
      "--code-size-limit",
      "50000",
      "--base-fee",
      "0",
      "--gas-limit",
      "3000000000",
      "--accounts",
      "10",
      "--balance",
      "1000000",
      "--order",
      "fees",
      "--load-state",
      statePath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const keepAnvil = flags["keep-anvil"] === "1";
  const stopAnvil = (): void => {
    if (!anvil.killed) anvil.kill("SIGTERM");
  };
  process.on("SIGINT", () => {
    stopAnvil();
    process.exit(130);
  });

  try {
    await waitUntilAnvilUp(rpcUrl);
    // state の取り違え検出: genesis hash が manifest の生成元と一致するか（ADR 0016 §2）
    const genesis = await rpc<{ hash: string }>(
      rpcUrl,
      "eth_getBlockByNumber",
      ["0x0", false],
    );
    if (genesis.hash !== manifest.genesisHash)
      throw new Error(
        `loaded state の genesis (${genesis.hash.slice(0, 12)}…) が manifest ` +
          `(${manifest.genesisHash.slice(0, 12)}…) と一致しません。state dump が壊れているか別物です`,
      );

    // ---- coordinator の反復実行 ----
    // snapshot ファイルは backtest anvil 専用（deployer anvil の .local-snapshot を汚さない）。
    // 毎回フレッシュな anvil から始まるので前回の残骸は先に消す。
    const snapshotFile = join(stateDirAbs, `.snapshot-${port}`);
    rmSync(snapshotFile, { force: true });

    process.env.ERIS_LOCAL_DEPLOY = "1";
    // 実効 regime を coordinator と agent プロセスの両方に読ませる（agent は ERIS_CONFIG 経由）。
    process.env.ERIS_CONFIG = effectiveRegimePath;
    // constants 同期後に評価させる（静的 import は hoist されるので動的に。sim-realtime.ts と同じ）。
    const { runRealtimeSimulation } =
      await import("../realtime/coordinator.js");

    const summaries: RunSummary[] = [];
    for (let i = 0; i < repeat; i++) {
      console.error(
        `[backtest] run ${i + 1}/${repeat} (regime=${regimeName}, seed=${runOverrides.seed ?? regimeDoc?.run?.seed ?? "?"})`,
      );
      const { runDir } = await runRealtimeSimulation({
        ANVIL_RPC_URL: rpcUrl,
        // 任意の regime ファイル（run.localDeploy を書き忘れたもの）でも config.localDeploy を保証する。
        ERIS_LOCAL_DEPLOY: "1",
        ERIS_LOCAL_SNAPSHOT_FILE: snapshotFile,
        ERIS_RUN_MODE: "backtest",
      });
      const summary = readRunSummary(runDir);
      if (summary) summaries.push(summary);
      else
        console.error(
          `[backtest] 警告: run ${i + 1} の summary.json が見つかりません（${runDir}）`,
        );
    }

    // ---- 集計（複数回のときは agent ごとの平均も出す。ADR 0005: 分布で読む）----
    console.log("");
    console.log(`backtest ${regimeName}: ${summaries.length}/${repeat} runs`);
    for (const s of summaries) {
      const line = s.agents
        .map(
          (a) =>
            `${a.id} α=${a.alphaUsdc?.toFixed(2) ?? "-"} pnl=${a.netPnlUsdc?.toFixed(2) ?? "-"}`,
        )
        .join("  ");
      console.log(
        `  ${basename(s.runDir)} (${s.blocksProcessed} blocks): ${line}`,
      );
    }
    if (summaries.length > 1) {
      const byAgent = new Map<string, number[]>();
      for (const s of summaries)
        for (const a of s.agents)
          if (a.alphaUsdc !== undefined)
            byAgent.set(a.id, [...(byAgent.get(a.id) ?? []), a.alphaUsdc]);
      console.log("  mean alphaUsdc:");
      for (const [id, values] of byAgent) {
        const mean = values.reduce((x, y) => x + y, 0) / values.length;
        console.log(`    ${id}: ${mean.toFixed(2)} (n=${values.length})`);
      }
    }
  } finally {
    if (keepAnvil)
      console.error(
        `[backtest] --keep-anvil: anvil は ${rpcUrl} で稼働したままです（手動で停止してください）`,
      );
    else stopAnvil();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
