// Baseline "random trading". Kept deterministic since it serves as a yardstick for discrimination:
// the RNG source is derived from the market (SEED) and agent id -> same SEED = same yardstick (before/after is reproducible).
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { Rng } from "@eris/sdk/rng.js";
import { limitFor } from "../lib/affordable.js";
import { marketViews } from "../lib/markets.js";

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const seed = Number(process.env.SEED ?? process.env.ERIS_FLOW_SEED ?? 1);
const agentId = process.env.ERIS_AGENT_ID ?? "random";
const rng = new Rng((seed ^ hashStr(agentId)) >>> 0);

export function decide(obs: AgentObservation): AgentAction | null {
  if (rng.next() < 0.35) {
    return { type: "noop", reason: "random skip" };
  }
  // Draw the market too, not just the direction. A yardstick that only ever touches WETH is not a
  // yardstick for a multi-asset field: it would score as "did nothing" on every WBTC dislocation
  // the real strategies were busy trading (ADR 0013).
  const views = marketViews(obs).filter((v) => v.venues.length > 0);
  if (views.length === 0) return { type: "noop", reason: "no venue" };
  const view = views[rng.int(0, views.length - 1)];
  const tokenIn = rng.next() < 0.5 ? view.base : "USDC";
  const max = limitFor(obs, tokenIn);
  const amountIn = (max * BigInt(1 + rng.int(0, 50))) / 100n;
  const action: Record<string, unknown> = {
    type: "swap",
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 75,
  };
  // `base` only belongs on a non-WETH swap (ADR 0013): the WETH market is the untagged default.
  if (view.base !== "WETH") action.base = view.base;
  return action as unknown as AgentAction;
}
