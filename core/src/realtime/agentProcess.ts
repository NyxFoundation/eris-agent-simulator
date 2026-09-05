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

// Names the child needs to run at all -- node, tsx, and the subscription CLIs the self-improving
// runtime shells out to (`codex exec` / `claude -p` read their login from HOME). Deliberately short:
// anything else is either the runtime's own ERIS_* namespace or a secret belonging to the operator
// or to another participant.
const OS_PASSTHROUGH = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  // Windows cannot spawn a process without these.
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "windir",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
]);

// Inference credentials and endpoints (example/agents/runtime/llm.ts). Not secrets belonging to
// other participants -- these are the operator's own defaults, overridable per agent by the roster.
const INFERENCE_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OLLAMA_API_KEY",
];

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
    // `docker` launches through infra/docker-agent/run-agent.sh (rules §2.3 caps; ADR 0022 task M5);
    // `process` (default) spawns bot.ts directly. A roster `command` override is used as given
    // either way -- it is the participant's own launcher.
    options: { sandbox?: "process" | "docker" } = {},
  ) {
    // The child is participant code that the operator executes, so its environment is BUILT rather
    // than inherited. `{ ...process.env }` handed every submitted agent the operator's whole
    // environment: every other agent's wallet key, TREASURY_PRIVATE_KEY, the fork RPC URL, and --
    // now that participants supply their own inference credentials -- one API key per participant.
    // Nothing the runtime reads needs any of that (example/agents/runtime/*.ts reads ERIS_* plus the
    // inference names below), and the child does not load .env.local: that is bootstrapEnv.ts, on
    // this side of the spawn. The allowlist also drops CLAUDE_CODE_* / CLAUDECODE / AI_AGENT, which
    // used to be deleted by name here to stop `claude -p` hanging on nesting detection.
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      // ERIS_* is the runtime's own namespace. The private key is excluded because it is per-agent
      // and injected below -- inheriting the parent's would be the leak this list exists to stop.
      if (k.startsWith("ERIS_") && k !== "ERIS_AGENT_PRIVATE_KEY")
        childEnv[k] = v;
      else if (OS_PASSTHROUGH.has(k)) childEnv[k] = v;
    }
    // Inference credentials are forwarded as a DEFAULT, so a single-operator local run keeps working
    // with one key in .env.local. A roster entry's `env` is applied after this and overrides them,
    // which is how each participant gets its own; an agent never sees another agent's, because
    // another agent's key only ever exists in that other agent's spec.
    for (const k of INFERENCE_ENV) {
      const v = process.env[k];
      if (v !== undefined) childEnv[k] = v;
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
      if (options.sandbox === "docker") {
        // The wrapper reads everything it needs from env (ERIS_AGENT_ID / ERIS_AGENT_DIR / ...) and
        // remaps host paths into the image itself. The repo root is two levels above agentsDir
        // (<root>/example/agents); ERIS_REPO tells the script so, in case it was symlinked.
        const repoRoot = resolve(agentsDir, "..", "..");
        childEnv.ERIS_REPO = repoRoot;
        command = "bash";
        args = [join(repoRoot, "infra", "docker-agent", "run-agent.sh")];
      } else {
        command = "node";
        args = ["--import", "tsx", join(agentsDir, "runtime", "bot.ts")];
      }
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

  close(): void {
    this.stopped = true;
    this.child.kill();
  }

  getStderr(): string {
    return this.stderr;
  }
}
