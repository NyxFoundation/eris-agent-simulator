import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { FlowKind } from "@eris/sdk/protocols/types.js";
import type { LeafAction, ProtocolId } from "@eris/sdk/types.js";
import type { FlowContextWire } from "./flow/logic.js";
import { safeStringify } from "./logger.js";

// Wire form of a single order returned by the bot (priorityFeeWei is a string since it goes through JSON).
export type FlowOrderWire = {
  protocol: ProtocolId;
  walletProtocol?: ProtocolId;
  // Explicit flow wallet key (e.g. "aave:actor0" for the aave borrower pool). When set, resolve by this key.
  walletKey?: string;
  kind: FlowKind;
  action: LeafAction;
  priorityFeeWei: string;
};

// Launch the orderflow bot as an independent process, pass it a FlowContext each round,
// and receive FlowOrder[] back. Same line-JSON protocol as AgentProcess.
// The bot never touches the RPC (same separation principle as agents); it only decides orders.
export class FlowProcess {
  private child: ChildProcessWithoutNullStreams;
  private pending: Array<(line: string) => void> = [];
  private stderr = "";
  private alive = true;

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
      const resolver = this.pending.shift();
      if (resolver) resolver(line);
    });
    this.child.stderr.on("data", (data) => {
      this.stderr += data.toString();
      if (this.stderr.length > 20_000) this.stderr = this.stderr.slice(-20_000);
    });
    // Don't crash the sim on spawn failure, process exit, or stdin pipe error; continue with empty orders afterward.
    this.child.on("error", (err) => {
      this.alive = false;
      this.stderr += `flow bot process error: ${err.message}\n`;
    });
    this.child.on("exit", () => {
      this.alive = false;
    });
    this.child.stdin.on("error", () => {
      this.alive = false;
    });
  }

  async requestOrders(
    context: FlowContextWire,
    timeoutMs: number,
  ): Promise<FlowOrderWire[]> {
    if (!this.alive || this.child.killed) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const linePromise = new Promise<string>((resolve) =>
        this.pending.push(resolve),
      );
      // write can throw synchronously (EPIPE, etc.), so keep it inside the try.
      this.child.stdin.write(`${safeStringify(context)}\n`);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("flow bot timeout")),
          timeoutMs,
        );
        timer.unref();
      });
      const line = await Promise.race([linePromise, timeout]);
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? (parsed as FlowOrderWire[]) : [];
    } catch {
      // When the bot misbehaves, continue safely with "no market orders" (don't stop the sim).
      return [];
    } finally {
      // Don't leave an unfired timeout on success (prevents timer buildup proportional to round count).
      if (timer) clearTimeout(timer);
    }
  }

  close(): void {
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}
