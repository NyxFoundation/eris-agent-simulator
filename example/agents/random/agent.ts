// ベースライン「でたらめ売買」。識別力判定の物差しなので決定論にする:
// 市場(SEED)と agent id から乱数源を導出 → 同一 SEED = 同一物差し（before/after が再現可能）。
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
