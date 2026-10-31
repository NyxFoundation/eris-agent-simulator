import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { AgentContext, AgentModule, DecideFn } from "@eris/sdk/agent.js";
import { makeClients } from "@eris/sdk/chain.js";
import { setLendingSingleton } from "@eris/sdk/protocols/lending.js";
import { DecideTimeoutError } from "./decideTimeout.js";
import { compileExecutor, hostErrorText } from "./improve.js";
import { readOnlyClient } from "./readOnlyClient.js";
import type {
  StrategyInit,
  StrategyMetadata,
  StrategyRequest,
  StrategyResponse,
  StrategyWorkerData,
} from "./strategyProtocol.js";
import { UNCAUGHT_EXIT_CODE, UNCAUGHT_MESSAGE } from "./strategyProtocol.js";

// Two transports, one body. A hand-written module runs in a worker thread of the agent process; a
// generated executor runs in a child process forked for it (strategyRunner.ts), so that code which
// escapes the vm finds a process that never held the wallet key.
type Channel = {
  post(message: StrategyResponse): void;
  onRequest(listener: (request: StrategyRequest) => void): void;
};
let channel: Channel;
let data: StrategyWorkerData;
if (parentPort) {
  const port = parentPort;
  channel = {
    post: (message) => port.postMessage(message),
    onRequest: (listener) => port.on("message", listener),
  };
  data = workerData as StrategyWorkerData;
} else if (process.send) {
  const send = process.send.bind(process);
  // The parent going away is the end of this process, whatever the strategy left scheduled.
  process.on("disconnect", () => process.exit(0));
  data = await new Promise<StrategyWorkerData>((resolve) => {
    const onInit = (message: StrategyInit) => {
      if (message?.type !== "init") return;
      process.off("message", onInit);
      resolve(message.data);
    };
    process.on("message", onInit);
    send({ type: "hello" } satisfies StrategyResponse);
  });
  channel = {
    post: (message) => send(message),
    onRequest: (listener) => process.on("message", listener),
  };
} else
  throw new Error("strategyWorker must run in a Worker or a forked child process");
const post = channel.post;
setLendingSingleton(data.context.lending);
const { publicClient } = makeClients(
  data.context.rpcUrl,
  data.context.config.chainId,
  { batch: true },
);
const reads = readOnlyClient(publicClient);
let decide: DecideFn | undefined;
let metadata: StrategyMetadata;
if (data.source.kind === "module") {
  const module = (await import(
    pathToFileURL(data.source.path).href
  )) as AgentModule;
  if (typeof module.run === "function")
    metadata = { mode: "run", config: module.config };
  else if (typeof module.decide === "function") {
    decide = module.decide;
    metadata = { mode: "decide", config: module.config };
  } else
    throw new Error(`${data.source.path} must export decide() or run(ctx)`);
} else if (data.source.kind === "executor") {
  const compiled = compileExecutor(data.source.source);
  if (!compiled.ok) throw new Error(compiled.reason);
  decide = compiled.executor;
  metadata = { mode: "decide" };
} else throw new Error("Python sources must run through PyBridge");

// The latest request, for what is reported outside one (below).
let lastRequest = { id: 0, round: undefined as number | undefined };

// Generated code runs in this process, and two things it can do end with Node handling a value of
// its realm by itself: a promise it rejects and never handles, and a throw from a callback the
// engine runs later (a FinalizationRegistry cleanup). Node's default for both serializes the value
// with util.inspect, which calls the value's custom inspect function with the host's `inspect` as
// an argument -- this realm's Function one `.constructor` away, and with it this process. So for a
// generated strategy the value is never touched here: not inspected, not stringified, no property
// read (the lockdown in improve.ts also leaves generated code no way to make the custom-inspect
// symbol; this does not rely on it).
//
// An unhandled rejection is logged, once per decision, and the process keeps running. The decision
// it came from has answered or answers by itself, nothing was left half-done, and failing the
// process would throw away the strategy's state and cost a spawn every block for a strategy that
// leaves one rejection behind each time (an idle failure does not count towards the back-off). An
// uncaught exception still fails it, as any strategy failure does, with a fixed message instead of
// the value: a child process exits with UNCAUGHT_EXIT_CODE and the parent says UNCAUGHT_MESSAGE; a
// worker's handler throws, and Node reports what the handler threw.
//
// Only for generated code: a hand-written strategy is the participant's own code with this thread's
// full privileges, so Node's default handling, and its message, stay.
if (data.source.kind === "executor") {
  let noticed = -1;
  process.on("unhandledRejection", () => {
    if (noticed === lastRequest.id) return;
    noticed = lastRequest.id;
    post({
      type: "notice",
      round: lastRequest.round,
      reason:
        "the generated strategy left a rejected promise unhandled; the value is not read, " +
        "and the strategy keeps running",
    });
  });
  process.on("uncaughtException", () => {
    if (!parentPort) process.exit(UNCAUGHT_EXIT_CODE);
    throw new Error(UNCAUGHT_MESSAGE);
  });
}

channel.onRequest(async ({ id, observation }: StrategyRequest) => {
  lastRequest = { id, round: observation.round };
  // Each context has its own lifetime. A timer/async continuation from a completed call must not
  // acquire the next call's id and submit a stale action in that block.
  let active = true;
  const ctx: AgentContext = {
    agentId: data.context.agentId,
    address: data.context.address,
    config: data.context.config,
    publicClient: reads,
    latestObservation: () => observation,
    onObservation() {
      throw new Error(
        "onObservation is for run(ctx) agents; decide receives its observation as an argument",
      );
    },
    submit(action) {
      if (active) post({ type: "submit", id, action });
    },
    log(entry) {
      if (active) post({ type: "log", id, entry });
    },
  };
  try {
    if (!decide)
      throw new Error("run(ctx) modules do not expose a worker decision");
    const action = await decide(observation, ctx);
    post({ type: "result", id, action });
  } catch (error) {
    // What a generated strategy threw reaches here as an error of this realm (compileExecutor), but a
    // stray value is still not stringified: a throw out of this catch is an unhandled rejection.
    let timeout = false;
    try {
      timeout = error instanceof DecideTimeoutError;
    } catch {
      // Not this realm's.
    }
    post({
      type: "error",
      id,
      message: hostErrorText(error, "the strategy threw a value that is not an Error"),
      timeout,
    });
  } finally {
    active = false;
  }
});
post({ type: "ready", metadata });
