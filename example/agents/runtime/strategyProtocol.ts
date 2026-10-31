import type {
  AgentContext,
  AgentLogEntry,
  AgentRuntimeConfig,
  DecideFn,
} from "@eris/sdk/agent.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import type { Address } from "viem";

export type StrategySource =
  | { kind: "python"; path: string }
  | { kind: "module"; path: string }
  | { kind: "executor"; source: string };
export type StrategyContext = Pick<
  AgentContext,
  "agentId" | "address" | "config"
> & {
  rpcUrl: string;
  agentDir?: string;
  lending?: Address;
};
export type StrategyMetadata = {
  mode: "run" | "decide";
  config?: AgentRuntimeConfig;
};
export type StrategyResult = Awaited<ReturnType<DecideFn>>;
export type StrategyRequest = { id: number; observation: AgentObservation };
export type StrategyResponse =
  // Child-process transport only: the child says it is listening, and the parent answers with
  // StrategyInit. A message sent to a child before its listener exists is not queued for it.
  | { type: "hello" }
  | { type: "ready"; metadata: StrategyMetadata }
  | { type: "result"; id: number; action: StrategyResult }
  | { type: "error"; id: number; message: string; timeout: boolean }
  | {
      type: "submit";
      id: number;
      action: Parameters<AgentContext["submit"]>[0];
    }
  | { type: "log"; id: number; entry: AgentLogEntry }
  // Said by the worker itself, outside any one decision (strategyWorker.ts): fixed text only.
  | { type: "notice"; round?: number; reason: string };
export type StrategyWorkerData = {
  source: StrategySource;
  context: StrategyContext;
};
export type StrategyInit = { type: "init"; data: StrategyWorkerData };

// A generated executor's child process ends with this code on an uncaught exception, and the parent
// reports the fixed text below. In a worker the handler throws instead and Node reports what it
// threw; a child process whose handler throws prints the value and exits 7.
export const UNCAUGHT_EXIT_CODE = 70;
export const UNCAUGHT_MESSAGE =
  "uncaught exception in the generated strategy (the value is not read)";
