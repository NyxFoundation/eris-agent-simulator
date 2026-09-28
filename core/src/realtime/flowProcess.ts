import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { FlowContextWire } from "../flow/logic.js";
import { parseFlowLine, type FlowOrderWire } from "../flowProcess.js";
import type { FlowGuardNote } from "../flow/logic.js";
import { safeStringify } from "../logger.js";

export type FlowOrdersHandler = (
  orders: FlowOrderWire[],
  guards: FlowGuardNote[],
  round?: number,
) => void;

// flow-bot process in realtime mode. Same push/stream model as RealtimeAgentProcess.
// coordinator -> child: push a FlowContext on every new block. child -> coordinator: each stdout line is
// passed to the handler as FlowOrder[] (for immediate mempool relay). The bot never touches RPC.
export class RealtimeFlowProcess {
  private child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private alive = true;
  private handler: FlowOrdersHandler | null = null;

  constructor(
    command: string,
    args: string[],
    flowSeed: number,
    runDir: string,
  ) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "development",
        ERIS_FLOW_SEED: String(flowSeed),
        ERIS_RUN_DIR: runDir,
      },
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => {
      if (!this.handler) return;
      const trimmed = line.trim();
      if (trimmed === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        this.stderr += `bad flow line: ${
          error instanceof Error ? error.message : String(error)
        }\n`;
        return;
      }
      const flowLine = parseFlowLine(parsed);
      if (flowLine) this.handler(flowLine.orders, flowLine.guards, flowLine.round);
    });
    this.child.stderr.on("data", (data) => {
      this.stderr += data.toString();
      if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
    });
    this.child.on("error", (err) => {
      this.alive = false;
      this.stderr += `flow bot process error: ${err.message}\n`;
      this.onExit?.({ reason: `spawn error: ${err.message}` });
    });
    this.child.on("exit", (code, signal) => {
      const wasAlive = this.alive;
      this.alive = false;
      // close() at the end of the run is not news; the bot going on its own is.
      if (wasAlive && !this.stopped)
        this.onExit?.({
          code: code ?? undefined,
          signal: signal ?? undefined,
          reason:
            "exited before the run ended" +
            (code !== null ? ` (code ${code})` : "") +
            (signal !== null ? ` (signal ${signal})` : ""),
        });
    });
    this.child.stdin.on("error", () => {
      this.alive = false;
    });
  }

  /// Notified once when the bot dies on its own (issue #159). Without it the market simply stops
  /// moving: `pushContext` returns false from then on, nothing is written anywhere, and the only trace
  /// was the flow column of blocks.csv going to zero.
  onExit?: (info: { code?: number; signal?: string; reason: string }) => void;

  private stopped = false;

  onOrders(handler: FlowOrdersHandler): void {
    this.handler = handler;
  }

  pushContext(context: FlowContextWire): boolean {
    if (!this.alive || this.child.killed) return false;
    try {
      this.child.stdin.write(`${safeStringify(context)}\n`);
      return true;
    } catch {
      this.alive = false;
      return false;
    }
  }

  isAlive(): boolean {
    return this.alive && !this.child.killed;
  }

  close(): void {
    this.stopped = true;
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}
