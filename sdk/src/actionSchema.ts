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

// Issue #27 (c): the stable/stable leg. `stable` names the market-priced registry stable; the other
// side is always USDC, so tokenIn is one of the two.
export const stableSwapSchema = z.object({
  type: z.literal("stableSwap"),
  stable: tokenSymbol,
  tokenIn: tokenSymbol,
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

// LST venue (issue #38). The market is LST/WETH, so there is no `base` market selector here.
export const lstDepositSchema = z.object({
  type: z.literal("lstDeposit"),
  amountWethWei: decimalString.describe(
    "WETH to stake (wei). Mints LST at the vault's current redemption rate.",
  ),
  ...priorityFee,
});

export const lstSwapSchema = z.object({
  type: z.literal("lstSwap"),
  tokenIn: z
    .enum(["WETH", "LST"])
    .describe(
      'the token you are sending: "WETH" buys LST from the secondary market, "LST" sells into it (the instant exit, at the pool\'s discount).',
    ),
  amountIn: decimalString.describe("wei of tokenIn (both are 18-decimal)"),
  slippageBps: z.number().int().nonnegative().optional(),
  ...priorityFee,
});

export const lstRequestWithdrawSchema = z.object({
  type: z.literal("lstRequestWithdraw"),
  amountLstWei: decimalString.describe(
    "LST shares to queue for redemption at par (wei). Claimable after withdrawalDelayBlocks; this is the slow, full-value exit.",
  ),
  ...priorityFee,
});

export const lstClaimWithdrawSchema = z.object({
  type: z.literal("lstClaimWithdraw"),
  requestId: decimalString
    .optional()
    .describe(
      "a specific queued request id. Omit to claim every request that has finalized.",
    ),
  ...priorityFee,
});

// Liquity venue (issue #39). Collateral is denominated in WETH wei even though the protocol takes
// native ETH -- the adapter unwraps -- so there is no `base` selector and no ETH/WETH choice to make.
const liquityMaxFeeBps = z
  .number()
  .int()
  .positive()
  .max(10_000)
  .optional()
  .describe(
    "slippage bound on the protocol fee, in bps. Both fee curves rise with use, so a bound that is too tight reverts. Default 500 (5%).",
  );

export const liquityOpenTroveSchema = z.object({
  type: z.literal("liquityOpenTrove"),
  collateralWethWei: decimalString.describe(
    "WETH to unwrap and post as collateral (wei). It also has to leave enough native ETH behind to pay for gas.",
  ),
  debtEusdWei: decimalString.describe(
    "eUSD to draw (wei). Booked debt is this plus the borrowing fee plus 200 eUSD of gas compensation, and the total must clear MIN_NET_DEBT (1,800 eUSD).",
  ),
  maxFeeBps: liquityMaxFeeBps,
  ...priorityFee,
});

export const liquityAdjustTroveSchema = z.object({
  type: z.literal("liquityAdjustTrove"),
  addCollateralWethWei: decimalString
    .optional()
    .describe("WETH to unwrap and add as collateral (wei)."),
  withdrawCollateralWei: decimalString
    .optional()
    .describe("collateral to take back out, paid in native ETH (wei)."),
  debtChangeEusdWei: decimalString
    .optional()
    .describe("eUSD to draw or repay (wei); set isDebtIncrease to say which."),
  isDebtIncrease: z
    .boolean()
    .optional()
    .describe(
      "true draws more eUSD, false repays. Required with a debt change.",
    ),
  maxFeeBps: liquityMaxFeeBps,
  ...priorityFee,
});

export const liquityCloseTroveSchema = z.object({
  type: z.literal("liquityCloseTrove"),
  ...priorityFee,
});

export const liquityRedeemSchema = z.object({
  type: z.literal("liquityRedeem"),
  amountEusdWei: decimalString.describe(
    "eUSD to redeem for collateral at the oracle price (wei). Worth doing when eUSD trades below par by more than redemptionRateBps.",
  ),
  maxIterations: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("cap on how many Troves the redemption walks. 0 = no cap."),
  maxFeeBps: liquityMaxFeeBps,
  ...priorityFee,
});

export const liquityProvideToSpSchema = z.object({
  type: z.literal("liquityProvideToSP"),
  amountEusdWei: decimalString.describe(
    "eUSD to deposit into the Stability Pool (wei). It absorbs liquidated debt and pays out the collateral at a discount.",
  ),
  ...priorityFee,
});

export const liquityWithdrawFromSpSchema = z.object({
  type: z.literal("liquityWithdrawFromSP"),
  amountEusdWei: decimalOrMax.describe(
    'eUSD to withdraw (wei), or "max". "0" claims the accrued ETH gain without touching the deposit.',
  ),
  ...priorityFee,
});

export const liquityLiquidateSchema = z.object({
  type: z.literal("liquityLiquidate"),
  borrowers: z
    .array(hexString)
    .optional()
    .describe("specific Trove owners to liquidate."),
  maxTroves: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "instead of naming owners, sweep this many of the riskiest Troves.",
    ),
  ...priorityFee,
});

export const liquitySwapEusdSchema = z.object({
  type: z.literal("liquitySwapEusd"),
  tokenIn: z
    .enum(["USDC", "EUSD"])
    .describe(
      'the token you are sending: "USDC" buys eUSD from the pool, "EUSD" sells into it.',
    ),
  amountIn: decimalString.describe(
    "units of tokenIn (USDC is 6-decimal, eUSD is 18-decimal)",
  ),
  slippageBps: z.number().int().nonnegative().optional(),
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
  curve: [curveSwapSchema, stableSwapSchema],
  aave: [
    aaveSupplySchema,
    aaveWithdrawSchema,
    aaveBorrowSchema,
    aaveRepaySchema,
  ],
  gmx: [gmxIncreaseSchema, gmxDecreaseSchema],
  lst: [
    lstDepositSchema,
    lstSwapSchema,
    lstRequestWithdrawSchema,
    lstClaimWithdrawSchema,
  ],
  liquity: [
    liquityOpenTroveSchema,
    liquityAdjustTroveSchema,
    liquityCloseTroveSchema,
    liquityRedeemSchema,
    liquityProvideToSpSchema,
    liquityWithdrawFromSpSchema,
    liquityLiquidateSchema,
    liquitySwapEusdSchema,
  ],
};

// GMX cannot be bundled because it requires keeper execution (same rule as bundleable in action.ts).
const BUNDLEABLE_PROTOCOLS: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "aave",
  "lst",
];

// AgentAction schema restricted to enabled venues (default is all venues).
export function agentActionSchemaFor(
  enabled: ProtocolId[] = [
    "uniswap",
    "balancer",
    "curve",
    "gmx",
    "aave",
    "lst",
  ],
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
