import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { AgentContext, AgentModule, DecideFn } from "@eris/sdk/agent.js";
import { makeClients } from "@eris/sdk/chain.js";
import { setLendingSingleton } from "@eris/sdk/protocols/lending.js";
import { DecideTimeoutError } from "./decideTimeout.js";
import { compileExecutor } from "./improve.js";
import { readOnlyClient } from "./readOnlyClient.js";
import type {
  StrategyMetadata,
  StrategyRequest,
  StrategyResponse,
  StrategyWorkerData,
} from "./strategyProtocol.js";

if (!parentPort) throw new Error("strategyWorker must run in a Worker");
const port = parentPort;
const data = workerData as StrategyWorkerData;
const post = (message: StrategyResponse) => port.postMessage(message);
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

port.on("message", async ({ id, observation }: StrategyRequest) => {
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
    post({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
      timeout: error instanceof DecideTimeoutError,
    });
  } finally {
    active = false;
  }
});
post({ type: "ready", metadata });
