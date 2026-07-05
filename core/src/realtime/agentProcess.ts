import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSpec } from "@eris/sdk/types.js";

// Credentials and connection endpoints passed to the agent child process in direct mode (ADR 0006 §2 / ADR 0015).
export type DirectAccess = {
  privateKey: string;
  priceFeedAddress: string;
  runId: string;
};

// Agent process in realtime mode (ADR 0015 §5).
// spawn is always `node --import tsx <agentsDir>/runtime/bot.ts` (the agent directory is passed via
// env ERIS_AGENT_DIR). The stdin/stdout protocol has been retired; the child reads the chain itself
// (runtime/read.ts) and signs/sends itself (runtime/send.ts). The contract with the coordinator is
// only env variables, on-chain state, and runs/<id>/agents/<id>.jsonl.
// The roster's explicit command/args remain as an override for fully self-contained agents (other languages, etc.; ADR 0015 §8).
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
    // Extra env the environment injects into all agents (e.g. ADR 0009 stress victim addresses).
    // If spec.env specifies a value it takes precedence (extraEnv acts as the default).
    extraEnv?: Record<string, string>,
  ) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Remove the parent Claude Code session markers (prevents a hang from nesting detection).
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
    // Tell the child it is in realtime mode (so agents with their own loop can branch).
    childEnv.ERIS_REALTIME = "1";
    childEnv.ERIS_AGENT_PRIVATE_KEY = direct.privateKey;
    childEnv.ERIS_PRICE_FEED_ADDRESS = direct.priceFeedAddress;
    childEnv.ERIS_RUN_ID = direct.runId;

    let command: string;
    let args: string[];
    if (spec.command !== undefined) {
      // override: fully self-contained agent. read/send/validate are all its own (unsupported, for advanced users).
      command = spec.command;
      args = spec.args ?? [];
    } else {
      // Convention resolution (ADR 0015 §6): id (or the dir override) points to <agentsDir>/<dir>/, and
      // bot.ts drives its contents (agent.ts decide/run, or prompt.md).
      const agentDir = resolve(agentsDir, spec.dir ?? spec.id);
      if (!existsSync(agentDir)) {
        throw new Error(
          `agent directory not found for id "${spec.id}": ${agentDir} ` +
            `(the roster id is a directory name directly under ${agentsDir}/; use dir for an alias, or command/args for a different implementation)`,
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
