import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSpec } from "@eris/sdk/types.js";

// How long a stopped agent gets to exit before it is killed outright. Short: by the time close() is
// called the run is over and scored, and every extra second is one the environment spends waiting
// for a process whose output nobody will read.
const CLOSE_GRACE_MS = 2_000;

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
    // The run's block budget as the environment resolved it. Passed explicitly because the child
    // rebuilds its config from the YAML and would otherwise miss a CLI --blocks override: an agent
    // that thinks the run is longer than it is will start exits it cannot finish (issue #38's
    // withdrawal queue makes that a scoring loss, not just a missed trade).
    runBlocks: number,
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
    childEnv.ERIS_AGENT_PRIVATE_KEY = direct.privateKey;
    childEnv.ERIS_PRICE_FEED_ADDRESS = direct.priceFeedAddress;
    childEnv.ERIS_RUN_ID = direct.runId;
    if (runBlocks > 0) childEnv.ERIS_RUN_BLOCKS = String(runBlocks);

    let command: string;
    let args: string[];
    if (spec.command !== undefined) {
      // override: fully self-contained agent. read/send/validate are all its own (unsupported, for advanced users).
      command = spec.command;
      args = spec.args ?? [];
    } else {
      // Convention resolution (ADR 0015 §6): id (or the dir override) points to <agentsDir>/<dir>/, and
      // bot.ts drives its contents (agent.ts decide/run, plus prompt.md when self-improving).
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
    this.child.on("error", (error) => {
      this.alive = false;
      this.onExit?.({ reason: `spawn error: ${error.message}` });
    });
    this.child.on("exit", (code, signal) => {
      const wasAlive = this.alive;
      this.alive = false;
      // Only interesting if it went on its own. close() kills every agent at the end of the run,
      // and that is not news.
      if (wasAlive && !this.stopped) {
        this.onExit?.({
          code: code ?? undefined,
          signal: signal ?? undefined,
          reason: "exited before the run ended",
        });
      }
    });
  }

  /// Notified when the process dies on its own. Without this an agent that crashes mid-run just
  /// stops trading, and the run looks like one where it chose not to act -- indistinguishable in
  /// summary.json, and the difference is the whole result.
  onExit?: (info: { code?: number; signal?: string; reason: string }) => void;

  private stopped = false;

  isAlive(): boolean {
    return this.alive && !this.child.killed;
  }

  /// Stop the agent, and stop *waiting* on it.
  ///
  /// The environment's own exit must not depend on a participant's teardown. Measured 2026-09-05: a
  /// run with containerised agents printed `realtime simulation completed`, wrote summary.json, and
  /// then never exited — the coordinator sat at 0% CPU holding a pipe to a child that would not
  /// die. The mechanism is that the agent's node process is **PID 1** inside its container, and
  /// Linux does not deliver a signal with its default disposition to PID 1: node installs no
  /// SIGTERM handler, so the agent ignored the stop entirely, `docker run` waited for a container
  /// that was never going to stop, and this child's stderr pipe kept the environment's event loop
  /// alive forever. `--init` on the container side fixes the ordinary case (see
  /// infra/docker-agent/run-agent.sh); this is what makes the environment robust to an agent that
  /// does not stop for any reason at all — which, in a competition where participants write the
  /// agent, is a thing to be robust to rather than a thing to trust.
  close(): void {
    this.stopped = true;
    this.child.kill();
    // unref, not destroy: late stderr is still captured into the buffer that summary.json's
    // stderrTail reads, it just stops being a reason for the environment to stay alive. The stream
    // is a net.Socket at runtime; `Readable` is the declared type and has no unref.
    (this.child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    this.child.unref();
    const escalation = setTimeout(() => {
      if (this.alive) this.child.kill("SIGKILL");
    }, CLOSE_GRACE_MS);
    // The escalation itself must not be the thing that holds the loop open.
    escalation.unref();
  }

  getStderr(): string {
    return this.stderr;
  }
}
