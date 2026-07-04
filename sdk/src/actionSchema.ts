// action スキーマの zod 化（ADR 0015 §4/§8）。
// プロンプト型 agent の system prompt に埋める `<schema>`（JSON Schema）と、LLM 出力の
// 構造検証（エラー内容を会話に追記して再試行するため message が要る）をここから導出する。
// 「LLM が教わるルール」と「実行時に強制されるルール」を同じ sdk パッケージに併置し、
// action の形が変わる PR で必ず同時更新する（ADR 0015 Risks）。
// 残高・limits 等の意味的検証は従来どおり validateAction（action.ts + adapter.validate）が担う。
import { z } from "zod";
import type { ProtocolId } from "./types.js";

// 10 進整数文字列（wei / units。JS number の精度落ちを避けるため文字列で受ける）。
const decimalString = z
  .string()
  .regex(/^[0-9]+$/, "must be a decimal integer string");
// 10 進整数 or "max"（aaveWithdraw / aaveRepay）。
const decimalOrMax = z.union([decimalString, z.literal("max")]);
const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be a hex string");
const tokenSymbol = z.string().min(1);

const priorityFee = {
  maxPriorityFeePerGasWei: decimalString.optional(),
};

export const noopSchema = z.object({
  type: z.literal("noop"),
  reason: z.string().optional(),
});

export const swapSchema = z.object({
  type: z.literal("swap"),
  tokenIn: tokenSymbol,
  base: tokenSymbol.optional(),
  amountIn: decimalString,
  slippageBps: z.number().int().nonnegative().optional(),
  ...priorityFee,
});

export const mintLiquiditySchema = z.object({
  type: z.literal("mintLiquidity"),
  base: tokenSymbol.optional(),
  tickLower: z.number().int(),
  tickUpper: z.number().int(),
  amountWethDesired: decimalString,
  amountUsdcDesired: decimalString,
  amountBaseDesired: decimalString.optional(),
  amountQuoteDesired: decimalString.optional(),
  slippageBps: z.number().int().nonnegative().optional(),
  ...priorityFee,
});

export const removeLiquiditySchema = z.object({
  type: z.literal("removeLiquidity"),
  base: tokenSymbol.optional(),
  tokenId: decimalString,
  liquidity: decimalString,
  amountWethMin: decimalString.optional(),
  amountUsdcMin: decimalString.optional(),
  ...priorityFee,
});

export const collectFeesSchema = z.object({
  type: z.literal("collectFees"),
  base: tokenSymbol.optional(),
  tokenId: decimalString,
  ...priorityFee,
});

export const balancerSwapSchema = z.object({
  type: z.literal("balancerSwap"),
  tokenIn: tokenSymbol,
  base: tokenSymbol.optional(),
  amountIn: decimalString,
  slippageBps: z.number().int().nonnegative().optional(),
  ...priorityFee,
});

export const curveSwapSchema = z.object({
  type: z.literal("curveSwap"),
  tokenIn: tokenSymbol,
  base: tokenSymbol.optional(),
  amountIn: decimalString,
  slippageBps: z.number().int().nonnegative().optional(),
  ...priorityFee,
});

export const aaveSupplySchema = z.object({
  type: z.literal("aaveSupply"),
  asset: tokenSymbol,
  amount: decimalString,
  ...priorityFee,
});

export const aaveWithdrawSchema = z.object({
  type: z.literal("aaveWithdraw"),
  asset: tokenSymbol,
  amount: decimalOrMax,
  ...priorityFee,
});

export const aaveBorrowSchema = z.object({
  type: z.literal("aaveBorrow"),
  asset: tokenSymbol,
  amount: decimalString,
  ...priorityFee,
});

export const aaveRepaySchema = z.object({
  type: z.literal("aaveRepay"),
  asset: tokenSymbol,
  amount: decimalOrMax,
  ...priorityFee,
});

export const gmxIncreaseSchema = z.object({
  type: z.literal("gmxIncrease"),
  isLong: z.boolean(),
  base: tokenSymbol.optional(),
  collateral: tokenSymbol,
  collateralAmount: decimalString,
  sizeDeltaUsd: decimalString,
  acceptablePrice: decimalString.optional(),
  ...priorityFee,
});

export const gmxDecreaseSchema = z.object({
  type: z.literal("gmxDecrease"),
  isLong: z.boolean(),
  base: tokenSymbol.optional(),
  collateral: tokenSymbol,
  collateralDeltaAmount: decimalString,
  sizeDeltaUsd: decimalString,
  acceptablePrice: decimalString.optional(),
  ...priorityFee,
});

const rawTxSchema = z.object({
  to: hexString,
  data: hexString,
  value: decimalString.optional(),
});

export const rawTxActionSchema = z.object({
  type: z.literal("rawTx"),
  tx: rawTxSchema,
  ...priorityFee,
});

export const rawBundleActionSchema = z.object({
  type: z.literal("rawBundle"),
  txs: z.array(rawTxSchema).min(1),
  ...priorityFee,
});

// protocol → その protocol が受け付ける leaf action スキーマ。
// enabledProtocols に応じてプロンプトの <schema> から無効 venue の action を落とすのに使う。
const LEAF_SCHEMAS_BY_PROTOCOL: Record<ProtocolId, z.ZodTypeAny[]> = {
  uniswap: [
    swapSchema,
    mintLiquiditySchema,
    removeLiquiditySchema,
    collectFeesSchema,
  ],
  balancer: [balancerSwapSchema],
  curve: [curveSwapSchema],
  aave: [
    aaveSupplySchema,
    aaveWithdrawSchema,
    aaveBorrowSchema,
    aaveRepaySchema,
  ],
  gmx: [gmxIncreaseSchema, gmxDecreaseSchema],
};

// GMX は keeper 実行が要るため bundle 不可（action.ts の bundleable と同じ規則）。
const BUNDLEABLE_PROTOCOLS: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "aave",
];

// enabled venue に絞った AgentAction スキーマ（既定は全 venue）。
export function agentActionSchemaFor(
  enabled: ProtocolId[] = ["uniswap", "balancer", "curve", "gmx", "aave"],
): z.ZodTypeAny {
  const leaves = enabled.flatMap((id) => LEAF_SCHEMAS_BY_PROTOCOL[id] ?? []);
  const bundleable = enabled
    .filter((id) => BUNDLEABLE_PROTOCOLS.includes(id))
    .flatMap((id) => LEAF_SCHEMAS_BY_PROTOCOL[id] ?? []);
  const members: z.ZodTypeAny[] = [noopSchema, ...leaves];
  if (bundleable.length > 0) {
    members.push(
      z.object({
        type: z.literal("bundle"),
        actions: z
          .array(z.union(bundleable as [z.ZodTypeAny, z.ZodTypeAny]))
          .min(1),
        ...priorityFee,
      }),
    );
  }
  members.push(rawTxActionSchema, rawBundleActionSchema);
  return z.union(members as [z.ZodTypeAny, z.ZodTypeAny]);
}

// 全 venue の AgentAction スキーマ（構造のみ。意味的検証は validateAction）。
export const agentActionSchema = agentActionSchemaFor();

// プロンプト型 agent の system prompt に埋める JSON Schema（Hermes JSON mode の <schema> 形式）。
export function actionJsonSchema(
  enabled?: ProtocolId[],
): Record<string, unknown> {
  return z.toJSONSchema(agentActionSchemaFor(enabled)) as Record<
    string,
    unknown
  >;
}
