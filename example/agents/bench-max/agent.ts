// 計測用エージェント（本番のロスターには入れないこと）
//
// 規約 §2.6 の「1ブロックあたり3本」を毎ブロック使い切る。負荷の上限を測るためだけのもので、
// 収益は狙っていない。USDC→WETH→USDC→WETH と往復させ、残高がなるべく減らないようにしている。
import type { AgentAction, AgentObservation } from "@eris/sdk";

const SIZE_BPS = 20; // 残高の 0.2%。小さくして残高切れと大きな価格インパクトを避ける（サイズ上限は規約に無い＝自分でサイズする）

export function decide(obs: AgentObservation): AgentAction | null {
  const usdc = BigInt(obs.balances?.usdcUnits ?? "0");
  const weth = BigInt(obs.balances?.wethWei ?? "0");
  const usdcIn = (usdc * BigInt(SIZE_BPS)) / 10_000n;
  const wethIn = (weth * BigInt(SIZE_BPS)) / 10_000n;
  if (usdcIn === 0n || wethIn === 0n) {
    return { type: "noop", reason: "size floor" };
  }
  return {
    type: "bundle",
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
    actions: [
      { type: "swap", tokenIn: "USDC", amountIn: usdcIn.toString(), slippageBps: 300 },
      { type: "swap", tokenIn: "WETH", amountIn: wethIn.toString(), slippageBps: 300 },
      { type: "swap", tokenIn: "USDC", amountIn: usdcIn.toString(), slippageBps: 300 },
    ],
  };
}
