// zod version of the action schema (ADR 0015 §4/§8).
// The `<schema>` (JSON Schema) embedded in a prompt agent's system prompt and the structural
// validation of LLM output (which needs a message so errors can be appended to the conversation and
// retried) are both derived here. Colocating "the rules the LLM is taught" and "the rules enforced at
// runtime" in the same sdk package ensures a PR that changes the action shape updates both at once
// (ADR 0015 Risks). Semantic validation of balances/limits etc. is still handled by validateAction
// (action.ts + adapter.validate) as before.
import { z } from "zod";
import type { ProtocolId } from "./types.js";

// Decimal integer string (wei / units; taken as a string to avoid JS number precision loss).
const decimalString = z
  .string()
  .regex(/^[0-9]+$/, "must be a decimal integer string");
// Decimal integer or "max" (aaveWithdraw / aaveRepay).
const decimalOrMax = z.union([decimalString, z.literal("max")]);
const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be a hex string");
// Token symbols are uppercase (WETH / USDC / WBTC ...). The adapters' parse layer is
// case-sensitive, so reject wrong casing here: prompt-mode validation then feeds the error back to
// the LLM for a retry (observed failure: an LLM emitted tokenIn "usdc" which passed a plain
// z.string() and died at send time with no feedback). The regex also lands in the generated
// <schema> as a pattern, so the constraint is visible to the LLM before its first attempt.
const tokenSymbol = z
  .string()
  .min(1)
  .regex(/^[A-Z0-9]+$/, "token symbols are uppercase (e.g. WETH, USDC, WBTC)");

const priorityFee = {
  maxPriorityFeePerGasWei: decimalString.optional(),
};

// The `base` of a swap selects the market (base/USDC pair), it is NOT the token being sent.
// Omit it for the default WETH/USDC market; set it to the base symbol (e.g. "WBTC") only when
// trading another market. The description lands in the generated <schema>, because an LLM
// otherwise plausibly fills base with the sell-side token ("USDC") and the send-time market
// resolution fails with no retry feedback (observed live).
const marketBase = tokenSymbol
  .optional()
  .describe(
    'market selector: the base asset of the base/USDC market to trade (e.g. "WBTC"). ' +
      "Omit for the default WETH/USDC market. NOT the input token — use tokenIn for that " +
      '(tokenIn is the base symbol to sell, or "USDC" to buy).',
  );

export const noopSchema = z.object({
  type: z.literal("noop"),
  reason: z.string().optional(),
});

export const swapSchema = z.object({
  type: z.literal("swap"),
  tokenIn: tokenSymbol,
  base: marketBase,
  amountIn: decimalString,
  slippageBps: z.number().int().nonnegative().optional(),
  ...priorityFee,
});

export const mintLiquiditySchema = z.object({
  type: z.literal("mintLiquidity"),
  base: marketBase,
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
  base: marketBase,
  tokenId: decimalString,
  liquidity: decimalString,
  amountWethMin: decimalString.optional(),
  amountUsdcMin: decimalString.optional(),
  ...priorityFee,
});

export const collectFeesSchema = z.object({
  type: z.literal("collectFees"),
  base: marketBase,
  tokenId: decimalString,
  ...priorityFee,
});

export const balancerSwapSchema = z.object({
  type: z.literal("balancerSwap"),
  tokenIn: tokenSymbol,
  base: marketBase,
  amountIn: decimalString,
  slippageBps: z.number().int().nonnegative().optional(),
  ...priorityFee,
});

export const curveSwapSchema = z.object({
  type: z.literal("curveSwap"),
  tokenIn: tokenSymbol,
  base: marketBase,
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
  base: marketBase,
  collateral: tokenSymbol,
  collateralAmount: decimalString,
  sizeDeltaUsd: decimalString,
  acceptablePrice: decimalString.optional(),
  ...priorityFee,
});

export const gmxDecreaseSchema = z.object({
  type: z.literal("gmxDecrease"),
  isLong: z.boolean(),
  base: marketBase,
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

// protocol → the leaf action schemas that protocol accepts.
// Used to drop actions for disabled venues from the prompt's <schema> based on enabledProtocols.
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

// GMX cannot be bundled because it requires keeper execution (same rule as bundleable in action.ts).
const BUNDLEABLE_PROTOCOLS: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "aave",
];

// AgentAction schema restricted to enabled venues (default is all venues).
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

// AgentAction schema for all venues (structure only; semantic validation is validateAction).
export const agentActionSchema = agentActionSchemaFor();

// JSON Schema embedded in a prompt agent's system prompt (Hermes JSON mode <schema> form).
export function actionJsonSchema(
  enabled?: ProtocolId[],
): Record<string, unknown> {
  return z.toJSONSchema(agentActionSchemaFor(enabled)) as Record<
    string,
    unknown
  >;
}
