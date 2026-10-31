import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Worker } from "node:worker_threads";
import type { AgentContext } from "@eris/sdk/agent.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import {
  DECIDE_TIMEOUT_MS,
  DecideTimeoutError,
  STRATEGY_BACKOFF_AFTER,
  STRATEGY_BACKOFF_MAX_BLOCKS,
  STRATEGY_STARTUP_TIMEOUT_MS,
} from "./decideTimeout.js";
import { strategyEnv } from "./strategyEnv.js";
import type {
  StrategyContext,
  StrategyInit,
  StrategyMetadata,
  StrategyRequest,
  StrategyResponse,
  StrategyResult,
  StrategySource,
  StrategyWorkerData,
} from "./strategyProtocol.js";
import { UNCAUGHT_EXIT_CODE, UNCAUGHT_MESSAGE } from "./strategyProtocol.js";

type Decision = {
  action: StrategyResult;
  submitted: Parameters<AgentContext["submit"]>[0][];
};
type Pending = {
  id: number;
  round: number;
  deadline: number;
  timer: NodeJS.Timeout;
  submitted: Decision["submitted"];
  resolve(result: Decision): void;
  reject(error: Error): void;
};
type Transport = {
  post(request: StrategyRequest): void;
  terminate(): Promise<void>;
};
type TransportEvents = {
  message(message: StrategyResponse): void;
  error(error: Error): void;
  exit(error: Error): void;
};
type Instance = {
  transport: Transport;
  source: StrategySource;
  ready: Promise<StrategyMetadata>;
  pending?: Pending;
  failure?: Error;
  fail(error: Error): void;
};

// Only computation is disposable. The parent keeps the sender, log, revision evidence and state
// store. Replacing a worker never revives a dead agent process or rolls a strategy back.
export class StrategyRunner {
  private instance?: Instance;
  private id = 0;
  private busy = false;
  private closed = false;
  // Failed decisions in a row, and the block the next attempt waits for (see decideTimeout.ts).
  private consecutiveFailures = 0;
  private backoffUntilRound = -Infinity;

  constructor(
    private source: StrategySource,
    private readonly context: StrategyContext,
    private readonly log: AgentContext["log"],
    private readonly timeoutMs = DECIDE_TIMEOUT_MS,
    private readonly startupTimeoutMs = STRATEGY_STARTUP_TIMEOUT_MS,
  ) {}

  // An in-flight decision finishes under its own version. The next one reloads the selected source.
  // Keeping the descriptor here also means a timeout cannot accidentally revert an installed version.
  setSource(source: StrategySource): void {
    this.source = source;
  }

  async start(): Promise<StrategyMetadata> {
    if (
      this.instance &&
      (this.instance.source !== this.source || this.instance.failure)
    )
      await this.discard();
    if (this.closed) throw new Error("strategy runner is closed");
    if (!this.instance) this.instance = this.spawn();
    const instance = this.instance;
    try {
      return await instance.ready;
    } catch (error) {
      if (this.instance === instance) await this.discard();
      throw error;
    }
  }

  private spawn(): Instance {
    const data: StrategyWorkerData = { source: this.source, context: this.context };
    const events: TransportEvents = {
      message: (message) => onMessage(message),
      error: (error) => instance.fail(error),
      exit: (error) => instance.fail(error),
    };
    // Generated code runs in a process of its own; hand-written code in a worker thread.
    const transport =
      this.source.kind === "executor"
        ? childTransport(data, events)
        : workerTransport(data, events);
    let resolveReady!: (metadata: StrategyMetadata) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<StrategyMetadata>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Loading a module can itself spin. Bound startup as well as decide, on the parent event loop
    // -- with its own bound: a compile on a loaded host is slow, not stuck (issue #100).
    let initialized = false;
    const startup = setTimeout(
      () =>
        instance.fail(
          new Error(
            `strategy worker startup exceeded ${this.startupTimeoutMs}ms`,
          ),
        ),
      this.startupTimeoutMs,
    );
    const instance: Instance = {
      transport,
      source: this.source,
      ready,
      fail: (error) => {
        if (instance.failure) return;
        instance.failure = error;
        clearTimeout(startup);
        rejectReady(error);
        if (instance.pending) {
          clearTimeout(instance.pending.timer);
          instance.pending.reject(error);
          instance.pending = undefined;
        } else if (initialized && this.instance === instance) {
          this.log({ reason: `strategy worker failed: ${error.message}` });
        }
      },
    };
    const onMessage = (message: StrategyResponse) => {
      if (this.instance !== instance) return;
      if (message.type === "hello") return;
      if (message.type === "ready") {
        initialized = true;
        clearTimeout(startup);
        resolveReady(message.metadata);
        return;
      }
      if (message.type === "notice") {
        this.log(
          message.round === undefined
            ? { reason: message.reason }
            : { round: message.round, reason: message.reason },
        );
        return;
      }
      const pending = instance.pending;
      if (!pending || pending.id !== message.id) return;
      if (performance.now() >= pending.deadline) {
        clearTimeout(pending.timer);
        instance.pending = undefined;
        pending.reject(new DecideTimeoutError(pending.round));
        return;
      }
      if (message.type === "log") this.log(message.entry);
      else if (message.type === "submit")
        pending.submitted.push(message.action);
      else {
        clearTimeout(pending.timer);
        instance.pending = undefined;
        if (message.type === "error")
          pending.reject(
            message.timeout
              ? new DecideTimeoutError(pending.round)
              : new Error(message.message),
          );
        else
          pending.resolve({
            action: message.action,
            submitted: pending.submitted,
          });
      }
    };
    return instance;
  }

  async decide(observation: AgentObservation): Promise<Decision> {
    if (this.busy) throw new Error("strategy decision already in progress");
    if (observation.round < this.backoffUntilRound)
      return {
        action: {
          type: "noop",
          reason:
            `backing off after ${this.consecutiveFailures} consecutive failed decisions; ` +
            `next attempt at block ${this.backoffUntilRound}`,
        },
        submitted: [],
      };
    this.busy = true;
    try {
      await this.start();
      const instance = this.instance!;
      const id = ++this.id;
      const decision = await new Promise<Decision>((resolve, reject) => {
        const timer = setTimeout(() => {
          instance.pending = undefined;
          reject(new DecideTimeoutError(observation.round));
        }, this.timeoutMs);
        instance.pending = {
          id,
          round: observation.round,
          deadline: performance.now() + this.timeoutMs,
          timer,
          submitted: [],
          resolve,
          reject,
        };
        try {
          instance.transport.post({ id, observation });
        } catch (error) {
          instance.fail(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      this.consecutiveFailures = 0;
      return decision;
    } catch (error) {
      // Also discard workers that threw or crashed: outstanding callbacks from that decision must
      // never be allowed to trade later. start() reconstructs the same selected source next block
      // -- unless this is one failure too many, in which case the next attempts wait (the spawn is
      // what a strategy that throws every block makes expensive; see decideTimeout.ts).
      await this.discard();
      this.consecutiveFailures++;
      const over = this.consecutiveFailures - STRATEGY_BACKOFF_AFTER;
      if (over >= 0) {
        const skip = Math.min(2 ** over, STRATEGY_BACKOFF_MAX_BLOCKS);
        this.backoffUntilRound = observation.round + skip + 1;
        this.log({
          round: observation.round,
          reason:
            `strategy failed ${this.consecutiveFailures} times in a row; the worker is not ` +
            `replaced for the next ${skip} block(s), and each further failure doubles that ` +
            `(up to ${STRATEGY_BACKOFF_MAX_BLOCKS})`,
        });
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private async discard(): Promise<void> {
    const instance = this.instance;
    if (!instance) return;
    this.instance = undefined;
    instance.fail(new Error("strategy worker disposed"));
    await instance.transport.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.discard();
  }
}

function workerTransport(
  data: StrategyWorkerData,
  events: TransportEvents,
): Transport {
  const worker = new Worker(new URL("./strategyWorker.mjs", import.meta.url), {
    workerData: data,
    // The strategy's environment, not the parent's: no wallet key, no inference token, no API key
    // (strategyEnv.ts, issue #215). The worker signs nothing and calls no model; what it needs --
    // the RPC URL, the agent id, its own parameters -- is in workerData or stays.
    env: strategyEnv(),
  });
  worker.on("message", events.message);
  worker.on("error", events.error);
  worker.on("exit", (code) =>
    events.exit(new Error(`strategy worker exited with code ${code}`)),
  );
  return {
    post: (request) => worker.postMessage(request),
    terminate: async () => {
      await worker.terminate();
    },
  };
}

// A generated executor runs in a child process, not in a thread of this one. This process holds the
// wallet key and the inference token; a worker thread shares its memory, so code that got out of
// the vm realm in a worker could read them from the heap (or, on Linux, from /proc/self/environ when
// they arrived in the environment). The child was never handed either: its environment is
// strategyEnv(), and the coordinator hands the agent process its secrets on stdin, not in the
// environment the child could read at /proc/<ppid>/environ (agentSecrets.ts). Reading the parent's
// memory takes ptrace access, which Yama's ptrace_scope >= 1 denies to a descendant
// (isolationWarnings in agentSecrets.ts says when it is 0).
//
// And the child runs under Node's permission model: it may read its own entry file and nothing else,
// write nothing, start no process, no worker, no addon, no WASI, no inspector. Code that escapes
// the vm (a dynamic import() rejects with an error of Node's realm, one `.constructor.constructor`
// from `process`) gets a process that can read the chain and talk to its parent, which is what the
// strategy could already do -- not the participant's files, and not a shell on their machine. Node
// does not restrict the network in this version, and says the model is not a guarantee against
// malicious code; it is one wall behind the vm, not the only one.
//
// What the child can still do is what the vm already let the strategy do: answer decisions and
// submit actions, which the parent checks (rawTxGuard.ts) and signs.
function childTransport(
  data: StrategyWorkerData,
  events: TransportEvents,
): Transport {
  const entry = childEntry();
  const env = strategyEnv();
  // A loader named here would be read from outside the entry, and refused.
  delete env.NODE_OPTIONS;
  const child = fork(
    entry,
    [],
    {
      env,
      // The parent's flags (a loader, an inspector port, a test runner's) are not the strategy's.
      execArgv: ["--permission", `--allow-fs-read=${entry}`],
      // Structured clone, as postMessage does: observations carry bigints.
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const send = (message: StrategyInit | StrategyRequest) =>
    child.send(message, (error) => {
      if (error) events.error(error);
    });
  child.on("message", (message: StrategyResponse) => {
    if (message.type === "hello") send({ type: "init", data });
    events.message(message);
  });
  child.on("error", events.error);
  child.on("exit", (code, signal) =>
    events.exit(
      new Error(
        code === UNCAUGHT_EXIT_CODE
          ? UNCAUGHT_MESSAGE
          : signal !== null
            ? `strategy process exited with signal ${signal}`
            : `strategy process exited with code ${code}`,
      ),
    ),
  );
  return {
    post: (request) => send(request),
    terminate: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
  };
}

// The child's entry: strategyWorker.ts and everything it imports, bundled into one ES module. The
// usual entry (strategyWorker.mjs) loads TypeScript through tsx, which reads the sources and the
// packages and runs esbuild as a process of its own -- three things the child may not do. So this
// process bundles it once, writes the file under the temp directory (named by its content, so
// agents on one host share it and a changed runtime gets a new one) and the child reads only that.
let entryPath: string | undefined;
function childEntry(): string {
  if (entryPath) return entryPath;
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL("./strategyWorker.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
    // Bundled CommonJS calls require(); an ES module has none of its own.
    banner: {
      js: 'import { createRequire as __erisCreateRequire } from "node:module"; const require = __erisCreateRequire(import.meta.url);',
    },
  });
  const code = result.outputFiles[0].contents;
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
  // The permission model compares real paths, and macOS's temp directory is behind a symlink.
  const path = join(realpathSync(tmpdir()), `eris-strategy-child-${hash}.mjs`);
  if (!existsSync(path)) {
    const partial = `${path}.${process.pid}.tmp`;
    writeFileSync(partial, code);
    renameSync(partial, path);
  }
  entryPath = path;
  return path;
}
