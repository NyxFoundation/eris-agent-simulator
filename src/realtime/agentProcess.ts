import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentAction, AgentObservation, AgentSpec } from "../types.js";
import { parseAction } from "../action.js";
import { safeStringify } from "../logger.js";

export type AgentActionHandler = (action: AgentAction) => void;

// 実時間モードの agent プロセス。同期 request→response の `AgentProcess` と違い、
// - coordinator → 子: 新ブロック毎に observation を push（応答は待たない）
// - 子 → coordinator: stdout の各行を「独立した行動」として逐次ハンドラへ渡す（即 mempool relay 用）
// FIFO の pending resolver は持たない。死活監視は `alive` で行い、落ちたら無視する。
export class RealtimeAgentProcess {
  private child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private alive = true;
  private handler: AgentActionHandler | null = null;

  constructor(
    readonly spec: AgentSpec,
    rpcUrl: string,
    agentAddress: string,
    runDir: string,
  ) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // 親 Claude Code セッションのマーカーを除去（ネスト検出でハングするのを防ぐ。AgentProcess と同様）。
    for (const k of Object.keys(childEnv)) {
      if (
        k.startsWith("CLAUDE_CODE_") ||
        k === "CLAUDECODE" ||
        k === "AI_AGENT"
      )
        delete childEnv[k];
    }
    Object.assign(childEnv, spec.env ?? {});
    childEnv.NODE_ENV = process.env.NODE_ENV ?? "development";
    childEnv.ERIS_AGENT_ID = spec.id;
    childEnv.ERIS_RPC_URL = rpcUrl;
    childEnv.ERIS_AGENT_ADDRESS = agentAddress;
    childEnv.REPORT_DIR = process.env.REPORT_DIR ?? "./runs";
    childEnv.ERIS_RUN_DIR = runDir;
    // 実時間モードであることを子に伝える（自前ループの agent が分岐できるように）。
    childEnv.ERIS_REALTIME = "1";

    this.child = spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      if (!this.handler) return;
      const trimmed = line.trim();
      if (trimmed === "") return;
      let action: AgentAction;
      try {
        action = parseAction(JSON.parse(trimmed));
      } catch (error) {
        this.stderr += `bad action line: ${
          error instanceof Error ? error.message : String(error)
        }\n`;
        return;
      }
      this.handler(action);
    });
    this.child.stderr.on("data", (data) => {
      this.stderr += data.toString();
      if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
    });
    this.child.on("error", () => {
      this.alive = false;
    });
    this.child.on("exit", () => {
      this.alive = false;
    });
    this.child.stdin.on("error", () => {
      this.alive = false;
    });
  }

  // 子が action 行を出すたびに呼ばれるハンドラを登録する。
  onAction(handler: AgentActionHandler): void {
    this.handler = handler;
  }

  // 最新の observation を子へ push する（fire-and-forget）。
  pushObservation(observation: AgentObservation): void {
    if (!this.alive || this.child.killed) return;
    try {
      this.child.stdin.write(`${safeStringify(observation)}\n`);
    } catch {
      this.alive = false;
    }
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
