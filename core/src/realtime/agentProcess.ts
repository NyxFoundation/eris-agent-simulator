import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSpec } from "@eris/sdk/types.js";

// direct モード（ADR 0006 §2 / ADR 0015）で agent 子プロセスへ渡す資格情報・接続先。
export type DirectAccess = {
  privateKey: string;
  priceFeedAddress: string;
  runId: string;
};

// 実時間モードの agent プロセス（ADR 0015 §5）。
// spawn は一律 `node --import tsx <agentsDir>/runtime/bot.ts`（agent ディレクトリは env
// ERIS_AGENT_DIR で渡す）。stdin/stdout プロトコルは廃止済みで、子は自分でチェーンを読み
// （runtime/read.ts）、自分で署名・送信する（runtime/send.ts）。coordinator との契約は
// env 変数とオンチェーン状態と runs/<id>/agents/<id>.jsonl のみ。
// ロスターの明示 command/args は完全自前 agent（他言語等）の override として残す（ADR 0015 §8）。
export class RealtimeAgentProcess {
  private child: ChildProcess;
  private stderr = "";
  private alive = true;

  constructor(
    readonly spec: AgentSpec,
    rpcUrl: string,
    agentAddress: string,
    runDir: string,
    direct: DirectAccess,
    agentsDir: string,
    // 環境が全 agent に注入する追加 env（例: ADR 0009 の stress victim アドレス）。
    // spec.env が明示すればそちらが優先される（extraEnv は既定値の位置づけ）。
    extraEnv?: Record<string, string>,
  ) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // 親 Claude Code セッションのマーカーを除去（ネスト検出でハングするのを防ぐ）。
    for (const k of Object.keys(childEnv)) {
      if (
        k.startsWith("CLAUDE_CODE_") ||
        k === "CLAUDECODE" ||
        k === "AI_AGENT"
      )
        delete childEnv[k];
    }
    Object.assign(childEnv, extraEnv ?? {});
    Object.assign(childEnv, spec.env ?? {});
    childEnv.NODE_ENV = process.env.NODE_ENV ?? "development";
    childEnv.ERIS_AGENT_ID = spec.id;
    childEnv.ERIS_RPC_URL = rpcUrl;
    childEnv.ERIS_AGENT_ADDRESS = agentAddress;
    childEnv.REPORT_DIR = process.env.REPORT_DIR ?? "./runs";
    childEnv.ERIS_RUN_DIR = runDir;
    // 実時間モードであることを子に伝える（自前ループの agent が分岐できるように）。
    childEnv.ERIS_REALTIME = "1";
    childEnv.ERIS_AGENT_PRIVATE_KEY = direct.privateKey;
    childEnv.ERIS_PRICE_FEED_ADDRESS = direct.priceFeedAddress;
    childEnv.ERIS_RUN_ID = direct.runId;

    let command: string;
    let args: string[];
    if (spec.command !== undefined) {
      // override: 完全自前 agent。read/send/validate 全部自前（サポート外の上級者向け）。
      command = spec.command;
      args = spec.args ?? [];
    } else {
      // 規約解決（ADR 0015 §6）: id（または dir override）が <agentsDir>/<dir>/ を指し、
      // bot.ts がその中身（agent.ts の decide/run、または prompt.md）を駆動する。
      const agentDir = resolve(agentsDir, spec.dir ?? spec.id);
      if (!existsSync(agentDir)) {
        throw new Error(
          `agent directory not found for id "${spec.id}": ${agentDir} ` +
            `(ロスターの id は ${agentsDir}/ 直下のディレクトリ名。別名は dir、別実装は command/args で明示する)`,
        );
      }
      childEnv.ERIS_AGENT_DIR = agentDir;
      command = "node";
      args = ["--import", "tsx", join(agentsDir, "runtime", "bot.ts")];
    }

    this.child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: childEnv,
    });

    this.child.stderr?.on("data", (data) => {
      this.stderr += data.toString();
      if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
    });
    this.child.on("error", () => {
      this.alive = false;
    });
    this.child.on("exit", () => {
      this.alive = false;
    });
  }

  isAlive(): boolean {
    return this.alive && !this.child.killed;
  }

  close(): void {
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}
