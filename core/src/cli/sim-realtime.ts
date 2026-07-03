// ローカルデプロイは `src/constants.ts` が **import 時**に `process.env.ERIS_LOCAL_DEPLOY` を
// 読んで LOCAL_DEPLOYMENT(WETH/USDC/WBTC 等のローカルアドレス)を overlay する。よって config の
// `run.localDeploy: true` / CLI `--local-deploy` を効かせるには、constants を間接 import する
// coordinator(や runConfig→markets→constants)を読み込む **前** に env を立てる必要がある。
// ここでは constants 依存のモジュールを import せず、yaml + fs だけで config/CLI を軽く覗いて
// env を立て、その後 coordinator を動的 import する。
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

function wantsLocalDeploy(argv: string[]): boolean {
  if (process.env.ERIS_LOCAL_DEPLOY === "1") return true;
  if (argv.includes("--local-deploy")) return true;
  // 設定ファイル解決順: --config > ERIS_CONFIG > config/local.yaml > config/example.yaml
  // （runConfig.ts の resolveConfigPathOrUndefined と一致させる）。
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

// env を立てた後に constants 依存のモジュールを評価させる（静的 import は hoist されるので動的に）。
const { runRealtimeSimulation } = await import("../realtime/coordinator.js");

runRealtimeSimulation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
