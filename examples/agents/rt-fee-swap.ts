import { createInterface } from "node:readline";

// 実時間モード検証用の最小フリーラン agent。
// observation を1行ずつ受け取りつつ、自前タイマー（RT_INTERVAL_MS ごと）で
// 指定 priority fee（FEE_WEI）の WETH->USDC 小口 swap を stdout へ出す。
// FEE_WEI を agent ごとに変えると、同一2秒ブロック内で fee 降順整列するかを観測できる。
// RT_OFFSET_MS で送信位相をずらすと、タイミング差が着ブロック差に出るかを観測できる。
const FEE_WEI = process.env.FEE_WEI ?? "100000000";
const AMOUNT_IN_WEI = process.env.RT_AMOUNT_WEI ?? "1000000000000000"; // 0.001 WETH
const INTERVAL_MS = Number(process.env.RT_INTERVAL_MS ?? "2200");
const OFFSET_MS = Number(process.env.RT_OFFSET_MS ?? "0");

let haveObservation = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", () => {
  haveObservation = true;
});

function emit(): void {
  if (!haveObservation) return; // 最初の observation を受け取るまで待つ
  process.stdout.write(
    `${JSON.stringify({
      type: "swap",
      tokenIn: "WETH",
      amountIn: AMOUNT_IN_WEI,
      maxPriorityFeePerGasWei: FEE_WEI,
      slippageBps: 200,
    })}\n`,
  );
}

setTimeout(() => {
  emit();
  setInterval(emit, INTERVAL_MS);
}, OFFSET_MS);
