// The **read-side** contract for on-chain distribution of the fair price (ADR 0006 §3).
// The environment deploys the PriceFeed contract and writes the fair price every block (the write
// side is core/src/realtime/priceFeed.ts). Agents receive ERIS_PRICE_FEED_ADDRESS and read via this
// readFairPrice / readFairPriceFor (the write tx lands in the next block, so the information is one
// block late; it affects all agents equally, so fairness is preserved — a spec documented in ADR 0006 §3).
import type { Address, PublicClient } from "viem";

export const priceFeedAbi = [
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [{ name: "answer", type: "int256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "latestAnswer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int256" }],
  },
  // ADR 0013: per-asset price for additional bases (WBTC etc.). WETH uses setPrice/latestAnswer above.
  {
    type: "function",
    name: "setPriceFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "answer", type: "int256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "answerOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ type: "int256" }],
  },
] as const;

const PRICE_DECIMALS = 1e8; // USD 8-decimal fixed point (same convention as Chainlink/Aave)

export function toPriceFeedAnswer(price: number): bigint {
  return BigInt(Math.round(price * PRICE_DECIMALS));
}

export function fromPriceFeedAnswer(answer: bigint): number {
  return Number(answer) / PRICE_DECIMALS;
}

// Fair price read by the agent / reconstruction. With a blockNumber, a historical block cross-section can also be read (ADR 0006 §4).
export async function readFairPrice(
  publicClient: PublicClient,
  address: Address,
  blockNumber?: bigint,
): Promise<number> {
  const answer = (await publicClient.readContract({
    address,
    abi: priceFeedAbi,
    functionName: "latestAnswer",
    blockNumber,
  })) as bigint;
  return fromPriceFeedAnswer(answer);
}

// Read the fair price of an additional base (answerOf). WETH uses readFairPrice(latestAnswer).
export async function readFairPriceFor(
  publicClient: PublicClient,
  address: Address,
  token: Address,
  blockNumber?: bigint,
): Promise<number> {
  const answer = (await publicClient.readContract({
    address,
    abi: priceFeedAbi,
    functionName: "answerOf",
    args: [token],
    blockNumber,
  })) as bigint;
  return fromPriceFeedAnswer(answer);
}
