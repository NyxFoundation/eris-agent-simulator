// agent モジュール契約（ADR 0015 §2/§3）。
// example/agents/<id>/ の agent.ts は次のいずれかを export する:
//   - decide(obs, ctx): ルール戦略。runtime/bot.ts が read→decide→send のループで駆動する
//   - run(ctx): 自走型（liquidator 等）。bot.ts はループせず ctx を渡して委譲する
// prompt.md 1 枚のプロンプト型 agent は export を持たず、bot.ts が LLM で action を出す（§4）。
import type { Address, PublicClient, WalletClient } from "viem";
import type { SimConfig } from "./config.js";
import type { AgentAction, AgentObservation } from "./types.js";

// 行動ログ 1 行（runs/<runId>/agents/<agentId>.jsonl）。戦略の判断理由・シグナル・内部状態を残す。
export type AgentLogEntry = {
  round?: number;
  action?: unknown;
  reason?: string;
  signals?: Record<string, number | undefined>;
  sizing?: unknown;
  expectedPnlUsdc?: number;
  state?: Record<string, unknown>;
};

// runtime が agent モジュールへ渡す実行文脈。read/send/log は runtime のものを使わせる
// （完全自走の run(ctx) でも署名・nonce・mempool 自己申告は runtime が一元管理する）。
export type AgentContext = {
  agentId: string;
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  config: SimConfig;
  // 最新 observation（read ループが毎ブロック更新）。まだ無ければ null。
  latestObservation(): AgentObservation | null;
  // 新しい observation ごとに呼ばれる購読（run(ctx) 型 agent 用）。解除関数を返す。
  onObservation(cb: (obs: AgentObservation) => void): () => void;
  // action を検証して mempool へ送信する（署名・nonce・自己申告ログは runtime が担う）。
  // 検証で弾かれた場合は mempool ログに rejected が残る（チェーンには出ない = fail-closed）。
  submit(action: AgentAction | Record<string, unknown>): void;
  // 行動ログ（runs/<id>/agents/<id>.jsonl）への追記。
  log(entry: AgentLogEntry): void;
};

// decide() 契約（ルール戦略）。null/undefined = 見送り。plain object も許容する
// （runtime が parse/validate してから送信する = 不正 action はチェーンに出ない）。
export type DecideFn = (
  obs: AgentObservation,
  ctx: AgentContext,
) =>
  | AgentAction
  | Record<string, unknown>
  | null
  | undefined
  | Promise<AgentAction | Record<string, unknown> | null | undefined>;

// run() 契約（自走型）。プロセスの生存期間 = run の生存期間。
export type RunFn = (ctx: AgentContext) => void | Promise<void>;

// agent.ts が任意で export する実行設定（旧 runRealtimeAgent の間隔/位相）。
// intervalMs 未指定なら「新ブロックごとに 1 回 decide」（旧 directShim + readline と同じ頻度）。
export type AgentRuntimeConfig = {
  intervalMs?: number;
  offsetMs?: number;
};

// bot.ts が動的 import した agent モジュールの形。
export type AgentModule = {
  decide?: DecideFn;
  run?: RunFn;
  config?: AgentRuntimeConfig;
};
