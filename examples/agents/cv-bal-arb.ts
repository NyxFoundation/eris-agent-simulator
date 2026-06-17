// cv-bal-arb: uniswap/balancer/curve の最大スプレッドのペアを取りに行く delta-neutral ペア裁定。
// 最安 venue で WETH を買い・最高 venue で WETH を売る両建てを 1 つの bundle で実行する（3 venue 対応）。
//
// env:
//   SPREAD_BPS  発注する最小スプレッド (bps, default 15)
import { createInterface } from "node:readline";
import { createEmitter } from "./lib/agentLog.js";

const SPREAD_BPS = Number(process.env.SPREAD_BPS ?? "15");
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;

const emit = createEmitter();

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line);
  const round = obs.round;
  const signals: Record<string, number> = {};
  const fee = obs.limits.defaultPriorityFeePerGasWei;
  // 3 venue (uniswap/balancer/curve) から最大スプレッドのペアを選ぶ。
  const venues: Array<{ swapType: string; price: number }> = [];
  const uni = obs.protocols?.uniswap?.pool?.priceUsdcPerWeth;
  if (Number.isFinite(uni) && uni > 0)
    venues.push({ swapType: "swap", price: uni });
  const bal = obs.protocols?.balancer?.priceUsdcPerWeth;
  if (Number.isFinite(bal) && bal > 0)
    venues.push({ swapType: "balancerSwap", price: bal });
  const curve = obs.protocols?.curve?.priceUsdcPerWeth;
  if (Number.isFinite(curve) && curve > 0)
    venues.push({ swapType: "curveSwap", price: curve });
  if (venues.length < 2) {
    emit({ type: "noop", reason: "need >=2 venues" }, { round, signals });
    return;
  }
  let lo = venues[0];
  let hi = venues[0];
  for (const v of venues) {
    if (v.price < lo.price) lo = v;
    if (v.price > hi.price) hi = v;
  }

  const spread = hi.price / lo.price - 1;
  signals.lo = lo.price;
  signals.hi = hi.price;
  signals.spread = spread;
  signals.spreadBps = spread * 10_000;
  if (spread < SPREAD_BPS / 10_000 || lo.swapType === hi.swapType) {
    emit({ type: "noop", reason: "spread too small" }, { round, signals });
    return;
  }

  // 最安 venue = WETH が割安 → そこで USDC→WETH 買い。最高 venue で WETH→USDC 売り。
  const buyVenue = lo.swapType;
  const sellVenue = hi.swapType;

  const sizeBps = Math.min(
    SIZE_BPS_MAX,
    Math.max(SIZE_BPS_MIN, Math.floor(spread * 200_000)),
  );
  signals.sizeBps = sizeBps;
  const usdcIn =
    (BigInt(obs.limits.maxUsdcInUnits) * BigInt(sizeBps)) / 10_000n;
  const wethIn = (BigInt(obs.limits.maxWethInWei) * BigInt(sizeBps)) / 10_000n;

  emit(
    {
      type: "bundle",
      actions: [
        {
          type: buyVenue,
          tokenIn: "USDC",
          amountIn: usdcIn.toString(),
          slippageBps: 75,
        },
        {
          type: sellVenue,
          tokenIn: "WETH",
          amountIn: wethIn.toString(),
          slippageBps: 75,
        },
      ],
      maxPriorityFeePerGasWei: fee,
    },
    { round, signals },
  );
});
