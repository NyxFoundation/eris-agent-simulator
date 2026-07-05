// Agent module contract (ADR 0015 §2/§3).
// The agent.ts in example/agents/<id>/ exports one of:
//   - decide(obs, ctx): rule strategy. runtime/bot.ts drives it in a read→decide→send loop
//   - run(ctx): self-driven (liquidator etc.). bot.ts does not loop and delegates by passing ctx
// A prompt agent that is a single prompt.md has no export; bot.ts produces the action via the LLM (§4).
import type { Address, PublicClient, WalletClient } from "viem";
import type { SimConfig } from "./config.js";
import type { AgentAction, AgentObservation } from "./types.js";

// One action-log line (runs/<runId>/agents/<agentId>.jsonl). Records the strategy's rationale, signals, and internal state.
export type AgentLogEntry = {
  round?: number;
  action?: unknown;
  reason?: string;
  signals?: Record<string, number | undefined>;
  sizing?: unknown;
  expectedPnlUsdc?: number;
  state?: Record<string, unknown>;
};

// Execution context the runtime passes to the agent module. It makes the agent use the runtime's
// read/send/log (even a fully self-driven run(ctx) has the runtime centrally manage signing, nonce,
// and mempool self-reporting).
export type AgentContext = {
  agentId: string;
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  config: SimConfig;
  // Latest observation (the read loop updates it every block). null if none yet.
  latestObservation(): AgentObservation | null;
  // Subscription called on every new observation (for run(ctx)-style agents). Returns an unsubscribe function.
  onObservation(cb: (obs: AgentObservation) => void): () => void;
  // Validate the action and send it to the mempool (the runtime handles signing, nonce, and self-reported logging).
  // If validation rejects it, a rejected entry is left in the mempool log (it never hits the chain = fail-closed).
  submit(action: AgentAction | Record<string, unknown>): void;
  // Append to the action log (runs/<id>/agents/<id>.jsonl).
  log(entry: AgentLogEntry): void;
};

// decide() contract (rule strategy). null/undefined = pass. A plain object is also allowed
// (the runtime parses/validates before sending = invalid actions never hit the chain).
export type DecideFn = (
  obs: AgentObservation,
  ctx: AgentContext,
) =>
  | AgentAction
  | Record<string, unknown>
  | null
  | undefined
  | Promise<AgentAction | Record<string, unknown> | null | undefined>;

// run() contract (self-driven). Process lifetime = run lifetime.
export type RunFn = (ctx: AgentContext) => void | Promise<void>;

// Runtime config that agent.ts may optionally export (the interval/phase of the old runRealtimeAgent).
// If intervalMs is unset, decide runs "once per new block" (same cadence as the old directShim + readline).
export type AgentRuntimeConfig = {
  intervalMs?: number;
  offsetMs?: number;
};

// Shape of the agent module that bot.ts dynamically imports.
export type AgentModule = {
  decide?: DecideFn;
  run?: RunFn;
  config?: AgentRuntimeConfig;
};
