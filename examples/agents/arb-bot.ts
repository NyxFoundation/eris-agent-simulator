/**
 * arb-bot: gap 駆動 swap で priority fee 入札に参加するクローン可能エージェント。
 *
 * 環境変数:
 *   BID_PROFIT_FRACTION  期待利益のうち priority fee に振る割合 (default 0.3)
 *
 * 戦略:
 *   1. gap = fair / pool - 1
 *   2. |gap| < GAP_THRESHOLD なら noop
 *   3. swap 方向: gap>0 → USDC→WETH, gap<0 → WETH→USDC
 *   4. swap サイズ: simple-rule と同じ size-bps 比例 (上限を 50% に拡張)
 *   5. 期待利益 (USDC) ≈ size_usdc * |gap|
 *   6. priority fee = 利益(wei) * PROFIT_FRACTION / 推定ガス
 *   7. clamp(bid, defaultPriorityFee, maxPriorityFee)
 */
import { createInterface } from "node:readline";

type Observation = {
  protocols: { uniswap: { pool: { priceUsdcPerWeth: number } } };
  fairPriceUsdcPerWeth: number;
  limits: {
    maxWethInWei: string;
    maxUsdcInUnits: string;
    defaultPriorityFeePerGasWei: string;
    maxPriorityFeePerGasWei: string;
  };
};

const PROFIT_FRACTION = Number(process.env.BID_PROFIT_FRACTION ?? "0.3");
const GAS_UNITS_ESTIMATE = 180_000n;
const GAP_THRESHOLD = 0.0005;
const SIZE_BPS_MIN = 250;
const SIZE_BPS_MAX = 5000;

if (!Number.isFinite(PROFIT_FRACTION) || PROFIT_FRACTION < 0) {
  process.stderr.write(
    `invalid BID_PROFIT_FRACTION: ${process.env.BID_PROFIT_FRACTION}\n`,
  );
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const obs = JSON.parse(line) as Observation;
  if (!obs.protocols?.uniswap?.pool) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "uniswap disabled" })}\n`,
    );
    return;
  }
  const pool = obs.protocols.uniswap.pool.priceUsdcPerWeth;
  const fair = obs.fairPriceUsdcPerWeth;
  if (
    !Number.isFinite(pool) ||
    pool <= 0 ||
    !Number.isFinite(fair) ||
    fair <= 0
  ) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "invalid prices" })}\n`,
    );
    return;
  }
  const gap = fair / pool - 1;
  if (Math.abs(gap) < GAP_THRESHOLD) {
    process.stdout.write(
      `${JSON.stringify({ type: "noop", reason: "gap too small" })}\n`,
    );
    return;
  }

  const tokenIn = gap > 0 ? "USDC" : "WETH";
  const max = BigInt(
    tokenIn === "WETH" ? obs.limits.maxWethInWei : obs.limits.maxUsdcInUnits,
  );
  const sizeBps = Math.min(
    SIZE_BPS_MAX,
    Math.max(SIZE_BPS_MIN, Math.floor(Math.abs(gap) * 200_000)),
  );
  const amountIn = (max * BigInt(sizeBps)) / 10_000n;

  const sizeUsdc =
    tokenIn === "USDC"
      ? Number(amountIn) / 1e6
      : (Number(amountIn) / 1e18) * fair;
  const profitUsdc = sizeUsdc * Math.abs(gap);
  const profitGwei = Math.max(0, Math.floor((profitUsdc / fair) * 1e9));
  const profitWei = BigInt(profitGwei) * 1_000_000_000n;
  const fractionScale = 10_000n;
  const fractionNum = BigInt(
    Math.max(0, Math.floor(PROFIT_FRACTION * Number(fractionScale))),
  );
  const bidPerGasWei =
    (profitWei * fractionNum) / fractionScale / GAS_UNITS_ESTIMATE;

  const minBid = BigInt(obs.limits.defaultPriorityFeePerGasWei);
  const maxBid = BigInt(obs.limits.maxPriorityFeePerGasWei);
  const bid =
    bidPerGasWei < minBid
      ? minBid
      : bidPerGasWei > maxBid
        ? maxBid
        : bidPerGasWei;

  process.stdout.write(
    `${JSON.stringify({
      type: "swap",
      tokenIn,
      amountIn: amountIn.toString(),
      maxPriorityFeePerGasWei: bid.toString(),
      slippageBps: 75,
    })}\n`,
  );
});
