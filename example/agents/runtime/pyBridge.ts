import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { AgentContext } from "@eris/sdk/agent.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import { findCheatcodeUsage } from "@eris/sdk/strategyStaticCheck.js";
import { DECIDE_TIMEOUT_MS, DecideTimeoutError } from "./decideTimeout.js";
import type {
  StrategyContext,
  StrategyMetadata,
  StrategyResult,
  StrategySource,
} from "./strategyProtocol.js";

type Decision = {
  action: StrategyResult;
  submitted: Parameters<AgentContext["submit"]>[0][];
};
type Pending = {
  id: number;
  deadline: number;
  timer: NodeJS.Timeout;
  submitted: Decision["submitted"];
  resolve(value: Decision): void;
  reject(error: Error): void;
  round: number;
  frames: number;
};
type Instance = {
  child: ChildProcessWithoutNullStreams;
  source: StrategySource;
  pending?: Pending;
  failure?: Error;
  exited: Promise<void>;
  kill(): void;
  onExit(): void;
  fail(error: Error): void;
};
const MAX_LINE_BYTES = 1024 * 1024;

// The parent owns the process, not a disposable Worker: Worker.terminate() cannot reap a Python
// child. The existing Sender still validates every returned/submitted action and alone holds keys.
export class PyBridge {
  private instance?: Instance;
  private busy = false;
  private closed = false;
  private id = 0;
  private revisions?: string;
  private revisionId = 0;

  constructor(
    private source: StrategySource,
    private readonly context: StrategyContext,
    private readonly log: AgentContext["log"],
    private readonly timeoutMs = DECIDE_TIMEOUT_MS,
    private readonly python = process.env.ERIS_PYTHON ?? "python3",
  ) {}

  setSource(source: StrategySource): void {
    if (source.kind !== "python")
      throw new Error("Python strategy cannot switch language");
    this.source = source;
  }

  async prepareSource(
    source: string,
  ): Promise<
    { ok: true; source: StrategySource } | { ok: false; reason: string }
  > {
    const findings = findCheatcodeUsage(source);
    if (findings.length)
      return {
        ok: false,
        reason: `cheatcode static check: ${findings[0].match}`,
      };
    this.revisions ??= mkdtempSync(join(tmpdir(), "eris-python-"));
    const path = join(this.revisions, `strategy-${++this.revisionId}.py`);
    writeFileSync(path, source, { mode: 0o600 });
    try {
      await new Promise<void>((done, reject) =>
        execFile(
          this.python,
          ["-m", "py_compile", path],
          {
            timeout: 1000,
            killSignal: "SIGKILL",
            maxBuffer: 64 * 1024,
            env: {
              ...process.env,
              PYTHONPYCACHEPREFIX: join(this.revisions!, "cache"),
            },
          },
          (error) => (error ? reject(error) : done()),
        ),
      );
      return { ok: true, source: { kind: "python", path } };
    } catch (error) {
      rmSync(path, { force: true });
      const detail = (error as { killed?: boolean }).killed
        ? "compile exceeded 1000ms"
        : error instanceof Error
          ? error.message
          : String(error);
      return { ok: false, reason: `Python compile rejected: ${detail}` };
    }
  }

  async start(): Promise<StrategyMetadata> {
    if (this.closed) throw new Error("Python bridge is closed");
    if (
      this.instance &&
      (this.instance.source !== this.source || this.instance.failure)
    )
      await this.discard();
    if (!this.instance) this.instance = this.spawn();
    return { mode: "decide" };
  }

  private spawn(): Instance {
    if (this.source.kind !== "python")
      throw new Error("expected a Python source");
    const path = resolve(this.source.path);
    const here = dirname(fileURLToPath(import.meta.url));
    // Both the repository and standalone bundle put sdk-py next to the agents tree's root.
    const sdk = [resolve(here, "../../sdk-py"), resolve(here, "../../../sdk-py")]
      .find(path => existsSync(join(path, "eris", "__init__.py")));
    const child = spawn(this.python, ["-u", path], {
      cwd: this.context.agentDir ?? dirname(path),
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
        // No key in the reference Python API. This is an API boundary, not a hostile-code sandbox.
        ERIS_AGENT_PRIVATE_KEY: "",
        PYTHONPATH: [
          sdk,
          this.context.agentDir ?? dirname(path),
          process.env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(delimiter),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let killed = false;
    let finish!: () => void;
    const instance: Instance = {
      child,
      source: this.source,
      exited: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      kill: () => {
        if (killed) return;
        killed = true;
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      },
      onExit: () => instance.kill(),
      fail: (error) => {
        if (instance.failure) return;
        instance.failure = error;
        if (instance.pending) {
          clearTimeout(instance.pending.timer);
          instance.pending.reject(error);
          instance.pending = undefined;
        } else if (this.instance === instance)
          this.log({ reason: error.message });
        instance.kill();
      },
    };
    process.once("exit", instance.onExit);
    child.on("error", (error) => instance.fail(error));
    child.stdin.on("error", (error) => instance.fail(error));
    child.on("close", (code, signal) => {
      process.removeListener("exit", instance.onExit);
      instance.fail(
        new Error(
          `Python strategy exited (${signal ?? code}): ${stderr.trim()}`,
        ),
      );
      finish();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (instance.failure) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        instance.fail(new Error("Python protocol output exceeded 1 MiB"));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const pending = instance.pending;
        if (!pending) continue;
        if (performance.now() >= pending.deadline) {
          instance.fail(new DecideTimeoutError(pending.round));
          return;
        }
        if (++pending.frames > 1000) {
          instance.fail(
            new Error("Python protocol exceeded 1000 frames per decision"),
          );
          return;
        }
        try {
          const value: unknown = JSON.parse(line);
          if (performance.now() >= pending.deadline) {
            instance.fail(new DecideTimeoutError(pending.round));
            return;
          }
          const message =
            value !== null && typeof value === "object" && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : null;
          // IDs let a resident strategy reject late callbacks. Bare actions/null remain supported
          // for small hand-written JSONL bridges; the SDK always sends correlated envelopes.
          if (
            message &&
            typeof message === "object" &&
            "id" in message &&
            message.id !== pending.id
          )
            continue;
          if (message && "log" in message)
            this.log(message.log as Parameters<AgentContext["log"]>[0]);
          else if (message && "submit" in message)
            pending.submitted.push(
              message.submit as Decision["submitted"][number],
            );
          else {
            clearTimeout(pending.timer);
            instance.pending = undefined;
            const action =
              message && "action" in message ? message.action : value;
            pending.resolve({
              action: action as StrategyResult,
              submitted: pending.submitted,
            });
          }
        } catch (error) {
          instance.fail(
            new Error(
              `Python protocol error: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          return;
        }
      }
    });
    return instance;
  }

  async decide(observation: AgentObservation): Promise<Decision> {
    if (this.busy) throw new Error("strategy decision already in progress");
    this.busy = true;
    try {
      const deadline = performance.now() + this.timeoutMs;
      await this.start();
      const instance = this.instance!;
      if (instance.failure) throw instance.failure;
      return await new Promise<Decision>((resolve, reject) => {
        const id = ++this.id;
        const timer = setTimeout(
          () => instance.fail(new DecideTimeoutError(observation.round)),
          Math.max(0, deadline - performance.now()),
        );
        instance.pending = {
          id,
          deadline,
          timer,
          submitted: [],
          resolve,
          reject,
          round: observation.round,
          frames: 0,
        };
        instance.child.stdin.write(
          JSON.stringify({
            id,
            obs: observation,
            agentId: this.context.agentId,
            address: this.context.address,
          }) + "\n",
        );
      });
    } catch (error) {
      await this.discard();
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private async discard(): Promise<void> {
    const instance = this.instance;
    if (!instance) return;
    this.instance = undefined;
    instance.fail(new Error("Python strategy disposed"));
    instance.kill();
    await instance.exited;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.discard();
    if (this.revisions)
      rmSync(this.revisions, { recursive: true, force: true });
  }
}
