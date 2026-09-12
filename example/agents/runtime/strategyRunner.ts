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
import type {
  StrategyContext,
  StrategyMetadata,
  StrategyResponse,
  StrategyResult,
  StrategySource,
} from "./strategyProtocol.js";

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
type Instance = {
  worker: Worker;
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
    const worker = new Worker(
      new URL("./strategyWorker.mjs", import.meta.url),
      {
        workerData: { source: this.source, context: this.context },
      },
    );
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
      worker,
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
    worker.on("message", (message: StrategyResponse) => {
      if (this.instance !== instance) return;
      if (message.type === "ready") {
        initialized = true;
        clearTimeout(startup);
        resolveReady(message.metadata);
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
    });
    worker.on("error", (error) => instance.fail(error));
    worker.on("exit", (code) =>
      instance.fail(new Error(`strategy worker exited with code ${code}`)),
    );
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
          instance.worker.postMessage({ id, observation });
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
    await instance.worker.terminate();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.discard();
  }
}
