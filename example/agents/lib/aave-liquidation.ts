// Raw tx builder for Aave V3 liquidationCall (GitHub #1).
// Pool/tokens are referenced from src/constants.ts (Arbitrum).
import { encodeFunctionData } from "viem";
import { AAVE } from "@eris/sdk/constants.js";

export type RawTx = { to: string; data: string };

const liquidationAbi = [
  {
    type: "function",
    name: "liquidationCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
      { name: "user", type: "address" },
      { name: "debtToCover", type: "uint256" },
      { name: "receiveAToken", type: "bool" },
    ],
    outputs: [],
  },
] as const;

/**
 * Build one tx for liquidationCall.
 * Passing uint256.max as debtToCover makes Aave clamp it to the close factor (e.g. up to 50%).
 * With receiveAToken=false you receive the underlying asset (WETH), which you can later swap to USDC.
 */
export function buildLiquidationCall(
  collateralAsset: string,
  debtAsset: string,
  user: string,
  debtToCover: bigint,
  receiveAToken = false,
): RawTx {
  return {
    to: AAVE.Pool,
    data: encodeFunctionData({
      abi: liquidationAbi,
      functionName: "liquidationCall",
      args: [
        collateralAsset as `0x${string}`,
        debtAsset as `0x${string}`,
        user as `0x${string}`,
        debtToCover,
        receiveAToken,
      ],
    }),
  };
}
