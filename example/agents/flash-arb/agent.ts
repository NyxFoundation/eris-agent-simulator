// flash-arb (GitHub #3): uses a flash loan to do cross-venue arbitrage at a size beyond its own capital limit.
// Looks at the deviation between uniswap (dynamic) and balancer (frozen reference price), and executes a
// 2-leg trade (buy WETH on the cheap venue, sell on the expensive venue) in 1 tx inside the FlashArb
// contract. The agent only decides direction and size, then triggers Aave flashLoanSimple via rawTx
// (the FlashArb address is computed deterministically).
//
// Note: because it depends on a flash-loan receiver contract + rawTx, it cannot be turned into a sandbox
// executor (LLM self-improvement). If it isn't profitable it reverts at the repayment step (atomic, so no
// capital loss, only gas).
import { encodeAbiParameters } from "viem";
import type { AgentAction, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import { FLASH_ARB_ADDRESS } from "@eris/sdk/wellKnown.js";
import { buildFlashLoanSimple } from "../lib/flash.js";

const agentAddress = process.env.ERIS_AGENT_ADDRESS ?? "";
const SPREAD_THRESHOLD = floatEnv("FLASH_ARB_SPREAD", 0.003); // 30 bps
const FLASH_USDC = intEnv("FLASH_ARB_USDC", 15000); // flash-borrowed USDC (beyond own capital limit)
const MAX_FLASH_USDC = intEnv("FLASH_ARB_MAX_USDC", FLASH_USDC);
const MIN_FLASH_LIQUIDITY_USDC = intEnv("FLASH_ARB_MIN_LIQUIDITY_USDC", 1000);
const POOL_LIQUIDITY_RESERVE_BPS = intEnv(
  "FLASH_ARB_POOL_LIQUIDITY_RESERVE_BPS",
  1000,
);
const UNI_FEE_BPS = floatEnv("FLASH_ARB_UNI_FEE_BPS", 30);
const BALANCER_FEE_BPS = floatEnv("FLASH_ARB_BALANCER_FEE_BPS", 30);
const FLASH_PREMIUM_BPS = floatEnv("FLASH_ARB_PREMIUM_BPS", 5);
const PRICE_IMPACT_BPS = floatEnv("FLASH_ARB_PRICE_IMPACT_BPS", 500);
const MIN_PROFIT_USDC = floatEnv("FLASH_ARB_MIN_PROFIT_USDC", 5);

const paramsType = [
  {
    type: "tuple",
    components: [
      { name: "mode", type: "uint8" },
      { name: "wethMinOut", type: "uint256" },
      { name: "usdcMinOut", type: "uint256" },
      { name: "profitTo", type: "address" },
    ],
  },
] as const;

export function decide(obs: AgentObservation): AgentAction | null {
  try {
    const fee = obs.limits.defaultPriorityFeePerGasWei;
    const uni = obs.protocols?.uniswap?.pool?.priceUsdcPerWeth ?? 0;
    const bal = obs.protocols?.balancer?.priceUsdcPerWeth ?? 0;
    if (!(uni > 0) || !(bal > 0)) {
      return { type: "noop", reason: "need uniswap+balancer prices" };
    }
    const spread = Math.abs(uni / bal - 1);
    if (spread < SPREAD_THRESHOLD) {
      return { type: "noop", reason: "spread too small" };
    }
    let flashUsdc = Math.min(FLASH_USDC, MAX_FLASH_USDC);
    const poolUsdcRaw = obs.protocols?.aave?.poolLiquidity?.USDC;
    if (typeof poolUsdcRaw === "string" && /^[0-9]+$/.test(poolUsdcRaw)) {
      const poolUsdcUnits = BigInt(poolUsdcRaw);
      const reserveBps = Math.max(
        0,
        Math.min(10000, POOL_LIQUIDITY_RESERVE_BPS),
      );
      const usableUnits = (poolUsdcUnits * BigInt(10000 - reserveBps)) / 10000n;
      const minUsableUnits = BigInt(MIN_FLASH_LIQUIDITY_USDC) * 1_000_000n;
      if (usableUnits < minUsableUnits) {
        return {
          type: "noop",
          reason: `flash liquidity too low: ${(
            Number(poolUsdcUnits) / 1e6
          ).toFixed(2)} USDC`,
        };
      }
      const requestedUnits = BigInt(flashUsdc) * 1_000_000n;
      const cappedUnits =
        usableUnits < requestedUnits ? usableUnits : requestedUnits;
      flashUsdc = Number(cappedUnits / 1_000_000n);
    }
    if (flashUsdc <= 0) {
      return { type: "noop", reason: "flashUsdc zero" };
    }
    // Buy on the venue where WETH is cheap. uni < bal -> buy on uniswap (mode 0), else buy on balancer (mode 1).
    const mode = uni < bal ? 0 : 1;
    const amount = BigInt(flashUsdc) * 1_000_000n;
    const venueRatio = mode === 0 ? bal / uni : uni / bal;
    const feeHaircut =
      (1 - UNI_FEE_BPS / 10000) *
      (1 - BALANCER_FEE_BPS / 10000) *
      (1 - PRICE_IMPACT_BPS / 10000);
    const expectedOut = flashUsdc * venueRatio * feeHaircut;
    const owed = flashUsdc * (1 + FLASH_PREMIUM_BPS / 10000);
    const expectedProfit = expectedOut - owed;
    if (!(expectedProfit >= MIN_PROFIT_USDC)) {
      return {
        type: "noop",
        reason: `flash edge below costs: ${expectedProfit.toFixed(2)} USDC`,
      };
    }
    // min-out is 0 (atomic revert at the repayment step if profit is insufficient; there is no same-tx adversary in the sim).
    const params = encodeAbiParameters(paramsType, [
      {
        mode,
        wethMinOut: 0n,
        usdcMinOut: 0n,
        profitTo: agentAddress as `0x${string}`,
      },
    ]);
    const tx = buildFlashLoanSimple(
      FLASH_ARB_ADDRESS,
      TOKENS.USDC.address,
      amount,
      params,
    );
    return { type: "rawTx", tx, maxPriorityFeePerGasWei: fee };
  } catch (error) {
    return { type: "noop", reason: `error: ${error}` };
  }
}

function floatEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
