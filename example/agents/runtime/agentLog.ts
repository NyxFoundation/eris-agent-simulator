/**
 * agentLog: エージェントが「自分の行動ログ」を残すための共有ヘルパー（ADR 0015 runtime）。
 *
 * coordinator が渡す環境変数から出力先を決め、各ラウンドの判断を
 * runs/<runId>/agents/<agentId>.jsonl に 1 行ずつ追記する。run 後の診断・戦略改善は
 * このログを一次情報として読む（判断理由・シグナル・内部状態）。
 *
 * 使い方: bot.ts が ctx.log として agent へ渡す。直接使う場合は
 *   import { createAgentLog } from "../runtime/agentLog.js";
 *   const log = createAgentLog();
 *   log({ round, action, reason, signals, state });
 *
 * 環境変数:
 *   ERIS_RUN_DIR   出力先 run ディレクトリ（coordinator が渡す）
 *   ERIS_AGENT_ID  エージェント識別子
 *
 * 注: coordinator 配下でない（ERIS_RUN_DIR 未設定の）場合はログは no-op。
 *     ログ書込の失敗は戦略実行を止めない（握りつぶす）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeStringify } from "@eris/sdk/logger.js";
import type { AgentLogEntry } from "@eris/sdk/agent.js";

export type { AgentLogEntry };

export type AgentLog = (entry: AgentLogEntry) => void;

// runs/<runDir>/agents/<agentId>.jsonl への低レベル追記。
// 行動ログ（createAgentLog）と mempool 自己申告（send.ts）が同じファイルに書くための共用実装。
export function createJsonlAppender(
  runDir: string | undefined,
  agentId: string,
): (record: Record<string, unknown>) => void {
  if (!runDir) return () => {}; // coordinator 配下でなければ何もしない
  const dir = join(runDir, "agents");
  const path = join(dir, `${agentId}.jsonl`);
  let ready = false;
  return (record) => {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const line = safeStringify({
        ts: new Date().toISOString(),
        agentId,
        ...record,
      });
      appendFileSync(path, `${line}\n`);
    } catch {
      // ログ失敗は戦略実行に影響させない
    }
  };
}

export function createAgentLog(): AgentLog {
  const append = createJsonlAppender(
    process.env.ERIS_RUN_DIR,
    process.env.ERIS_AGENT_ID ?? "unknown",
  );
  return (entry: AgentLogEntry): void => append({ ...entry });
}
