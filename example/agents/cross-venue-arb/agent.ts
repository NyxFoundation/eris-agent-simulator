// cross-venue-arb (GitHub #4): uniswap/balancer/curve のうち最安 venue で買い・最高 venue で
// 売る 2-leg 裁定。cv-bal-arb.ts(bal↔curve 限定)を 3 venue の最大乖離ペアへ一般化したもの。
// 注: 別 fee-tier / Uniswap v2 は観測に含まれないため対象外(uni 0.05% + balancer + curve のみ)。
// RPC 不要・semantic action のみ。
//
// env:
//   CROSS_VENUE_SPREAD_BPS  発注する最小スプレッド(bps, default 10)
import type { AgentAction, AgentObservation } from "@eris/sdk";

const SPREAD_BPS = intEnv("CROSS_VENUE_SPREAD_BPS", 10);
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;
const SLIPPAGE_BPS = 75;

export function decide(
  obs: AgentObservation,
): AgentAction | Record<string, unknown> | null {
  try {
    const p = obs.protocols ?? {};
    const fee = obs.limits.defaultPriorityFeePerGasWei;
    const venues: Array<{ swapType: string; price: number }> = [];
    const uni = p.uniswap?.pool?.priceUsdcPerWeth;
    if (typeof uni === "number" && uni > 0)
      venues.push({ swapType: "swap", price: uni });
    const bal = p.balancer?.priceUsdcPerWeth;
    if (typeof bal === "number" && bal > 0)
      venues.push({ swapType: "balancerSwap", price: bal });
    const cv = p.curve?.priceUsdcPerWeth;
    if (typeof cv === "number" && cv > 0)
      venues.push({ swapType: "curveSwap", price: cv });
    if (venues.length < 2) {
      return { type: "noop", reason: "need >=2 venues" };
    }
    let lo = venues[0];
    let hi = venues[0];
    for (const v of venues) {
      if (v.price < lo.price) lo = v;
      if (v.price > hi.price) hi = v;
    }
    const spread = hi.price / lo.price - 1;
    if (spread < SPREAD_BPS / 10_000 || lo.swapType === hi.swapType) {
      return { type: "noop", reason: "spread too small" };
    }
    const sizeBps = Math.min(
      SIZE_BPS_MAX,
      Math.max(SIZE_BPS_MIN, Math.floor(spread * 200_000)),
    );
    // デルタニュートラル化: 買い脚と売り脚を独立した USDC/WETH 上限で切ると WETH 量が一致せず
    // 残ポジ(方向性)が毎回積み上がる。代わりに「売れる WETH 上限を買うのに必要な USDC」で買い脚を
    // 頭打ちし、買った WETH をそのまま売る（買い==売りで net delta≈0）。
    const maxUsdc = BigInt(obs.limits.maxUsdcInUnits);
    const maxWeth = BigInt(obs.limits.maxWethInWei);
    const priceScaled = BigInt(Math.max(1, Math.round(lo.price * 100))); // USDC*100/WETH
    // maxWeth(wei) を lo.price で買うのに要る USDC(1e6) = maxWeth * priceScaled / (100 * 1e12)
    const usdcForWethCap = (maxWeth * priceScaled) / (100n * 10n ** 12n);
    const usdcCap = maxUsdc < usdcForWethCap ? maxUsdc : usdcForWethCap;
    const usdcIn = (usdcCap * BigInt(sizeBps)) / 10_000n;
    // 買い脚で取得する WETH(wei) = usdcIn(1e6) * 1e18 / (lo.price * 1e6) = usdcIn * 1e12 * 100 / priceScaled
    const boughtWethWei = (usdcIn * 10n ** 12n * 100n) / priceScaled;
    // スリッページで受領が目減りするため 98% を売る（裸ショート/残高超過を避けつつデルタマッチ）。
    const wethIn = (boughtWethWei * 98n) / 100n;
    if (usdcIn <= 0n || wethIn <= 0n) {
      return { type: "noop", reason: "computed size zero" };
    }
    const bundle = {
      type: "bundle",
      actions: [
        {
          type: lo.swapType,
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        },
        {
          type: hi.swapType,
          tokenIn: "WETH",
          amountIn: wethIn.toString(),
          slippageBps: SLIPPAGE_BPS,
        },
      ],
      maxPriorityFeePerGasWei: fee,
    };
    return bundle;
  } catch (error) {
    return { type: "noop", reason: `error: ${error}` };
  }
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
