import type {
  AgentContext,
  AgentLogEntry,
  AgentRuntimeConfig,
  DecideFn,
} from "@eris/sdk/agent.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import type { Address } from "viem";

export type StrategySource =
  | { kind: "module"; path: string }
  | { kind: "executor"; source: string };
export type StrategyContext = Pick<
  AgentContext,
  "agentId" | "address" | "config"
> & {
  rpcUrl: string;
  lending?: Address;
};
export type StrategyMetadata = {
  mode: "run" | "decide";
  config?: AgentRuntimeConfig;
};
export type StrategyResult = Awaited<ReturnType<DecideFn>>;
export type StrategyRequest = { id: number; observation: AgentObservation };
export type StrategyResponse =
  | { type: "ready"; metadata: StrategyMetadata }
  | { type: "result"; id: number; action: StrategyResult }
  | { type: "error"; id: number; message: string; timeout: boolean }
  | {
      type: "submit";
      id: number;
      action: Parameters<AgentContext["submit"]>[0];
    }
  | { type: "log"; id: number; entry: AgentLogEntry };
export type StrategyWorkerData = {
  source: StrategySource;
  context: StrategyContext;
};
