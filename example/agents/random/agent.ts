// Baseline "random trading". Kept deterministic since it serves as a yardstick for discrimination:
// the RNG source is derived from the market (SEED) and agent id -> same SEED = same yardstick (before/after is reproducible).
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { Rng } from "@eris/sdk/rng.js";

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
  const tokenIn = rng.next() < 0.5 ? "WETH" : "USDC";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );
  const amountIn = (max * BigInt(1 + rng.int(0, 50))) / 100n;
  return {
    type: "swap",
    tokenIn,
    amountIn: amountIn.toString(),
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    slippageBps: 75,
  };
}
