// Trading a token that appeared mid-run (issue #29).
//
// A launch pool is a Uniswap V3 pool the environment (or anybody) created against USDC for a token
// the run does not price. It reaches an agent through the #40 registry as a `uniswapV3Pool` entry
// plus an `erc20` entry for the token, one block after it was created. Nothing in the observation
// values the token -- under the round-trip rule (ADR 0022) a balance of it is worth nothing at the
// bell -- so everything about it has to be read from the chain: the pool's price and depth, the
// swaps that hit it, and the agent's own balance.
//
// This module is those reads plus the two transactions that trade it, as `rawTx` / `rawBundle`
// actions: the registered `swap` action resolves its pool from the market set, and a pool that was
// created a block ago is by definition outside that set. Same shape as discoveryAgent's
// approve-then-swap, against the environment's router instead of a bespoke AMM.
import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { AgentObservation } from "@eris/sdk";
import {
  erc20Abi,
  poolAbi,
  quoterV2Abi,
  swapRouterAbi,
} from "@eris/sdk/abis.js";
import { TOKENS, UNISWAP } from "@eris/sdk/constants.js";

const DEADLINE_FAR_FUTURE = BigInt(2 ** 32 - 1);

const poolExtraAbi = parseAbi([
  "function fee() view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

export type LaunchPool = {
  pool: Address;
  token: Address;
  tokenIsToken0: boolean;
  creator: Address;
  // True when this agent created it (the registry's one-block head start is the creator's).
  mine: boolean;
  registeredAtBlock: number;
};

// The addresses the run prices. A pool between two of these is an ordinary market; a pool between
// USDC and anything else is a launch.
function knownTokens(): Set<string> {
  return new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));
}

/** Every registry pool that pairs USDC with a token the run does not price, oldest first. */
export function launchPools(obs: AgentObservation): LaunchPool[] {
  const usdc = TOKENS.USDC.address.toLowerCase();
  const known = knownTokens();
  const out: LaunchPool[] = [];
  for (const e of obs.registry?.entries ?? []) {
    if (e.kind !== "uniswapV3Pool" || !e.token0 || !e.token1) continue;
    const t0 = e.token0.toLowerCase();
    const t1 = e.token1.toLowerCase();
    let token: string | undefined;
    let tokenIsToken0 = false;
    if (t0 === usdc && !known.has(t1)) {
      token = e.token1;
    } else if (t1 === usdc && !known.has(t0)) {
      token = e.token0;
      tokenIsToken0 = true;
    }
    if (!token) continue;
    out.push({
      pool: e.market as Address,
      token: token as Address,
      tokenIsToken0,
      creator: e.creator as Address,
      mine: e.mine,
      registeredAtBlock: Number(e.registeredAtBlock),
    });
  }
  return out.sort((a, b) => a.registeredAtBlock - b.registeredAtBlock);
}

export async function poolFee(
  client: PublicClient,
  pool: Address,
): Promise<number> {
  return Number(
    await client.readContract({
      address: pool,
      abi: poolExtraAbi,
      functionName: "fee",
    }),
  );
}

export type LaunchPoolState = {
  // USDC per whole token, from slot0.
  priceUsdcPerToken: number;
  liquidity: bigint;
  // The pool's USDC balance: what a seller can take out, and the scale a buy should be sized against.
  usdcReserveUnits: bigint;
};

export async function launchPoolState(
  client: PublicClient,
  pool: LaunchPool,
  tokenDecimals = 18,
): Promise<LaunchPoolState> {
  const [slot0, liquidity, usdcReserveUnits] = await Promise.all([
    client.readContract({
      address: pool.pool,
      abi: poolAbi,
      functionName: "slot0",
    }),
    client.readContract({
      address: pool.pool,
      abi: poolAbi,
      functionName: "liquidity",
    }),
    client.readContract({
      address: TOKENS.USDC.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [pool.pool],
    }),
  ]);
  const sqrtPriceX96 = (slot0 as readonly [bigint, ...unknown[]])[0];
  // token1 per token0 in raw units, then to human units by the decimals gap.
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const usdcDecimals = TOKENS.USDC.decimals;
  const priceUsdcPerToken = pool.tokenIsToken0
    ? raw * 10 ** (tokenDecimals - usdcDecimals)
    : 1 / (raw * 10 ** (usdcDecimals - tokenDecimals));
  return {
    priceUsdcPerToken,
    liquidity: liquidity as bigint,
    usdcReserveUnits: usdcReserveUnits as bigint,
  };
}

export type PoolFlow = {
  // USDC paid into the pool by buyers of the token, and taken out by sellers, over the range.
  usdcInUnits: bigint;
  usdcOutUnits: bigint;
  swaps: number;
};

/** What the pool's Swap logs say happened between two blocks (inclusive). */
export async function poolFlow(
  client: PublicClient,
  pool: LaunchPool,
  fromBlock: number,
  toBlock: number,
): Promise<PoolFlow> {
  if (toBlock < fromBlock)
    return { usdcInUnits: 0n, usdcOutUnits: 0n, swaps: 0 };
  const logs = await client.getLogs({
    address: pool.pool,
    event: poolExtraAbi[1],
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  });
  let usdcInUnits = 0n;
  let usdcOutUnits = 0n;
  for (const log of logs) {
    const args = log.args as { amount0?: bigint; amount1?: bigint };
    const usdcDelta = (pool.tokenIsToken0 ? args.amount1 : args.amount0) ?? 0n;
    // Positive = into the pool (somebody paid USDC for the token); negative = out (somebody sold).
    if (usdcDelta > 0n) usdcInUnits += usdcDelta;
    else usdcOutUnits += -usdcDelta;
  }
  return { usdcInUnits, usdcOutUnits, swaps: logs.length };
}

export async function tokenBalance(
  client: PublicClient,
  token: Address,
  holder: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;
}

/** The router's quote for an exact-input swap through the pool's fee tier. */
export async function quoteLaunch(
  client: PublicClient,
  args: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint },
): Promise<bigint> {
  const sim = await client.simulateContract({
    address: UNISWAP.quoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        fee: args.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return sim.result[0];
}

/** An exact approval -- never unlimited -- for the router to pull `amount` of `token`. */
export function approveTx(
  token: Address,
  spender: Address,
  amount: bigint,
): { to: Address; data: Hex } {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

export function exactInputSingleTx(args: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  minOut: bigint;
}): { to: Address; data: Hex } {
  return {
    to: UNISWAP.swapRouter,
    data: encodeFunctionData({
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          fee: args.fee,
          recipient: args.recipient,
          // A constant, not "now plus an hour": a wall-clock value in calldata makes the same
          // decision a different transaction on replay (rules §2.4 / §7).
          deadline: DEADLINE_FAR_FUTURE,
          amountIn: args.amountIn,
          amountOutMinimum: args.minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
}

/**
 * approve + swap as one `rawBundle`: the approve is nonce n and the swap n+1, so they land in the
 * same block in order, and the approval is exactly the amount the swap pulls.
 */
export function swapBundle(args: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  minOut: bigint;
  reason: string;
  maxPriorityFeePerGasWei: string;
}): Record<string, unknown> {
  return {
    type: "rawBundle",
    txs: [
      approveTx(args.tokenIn, UNISWAP.swapRouter, args.amountIn),
      exactInputSingleTx(args),
    ],
    reason: args.reason,
    maxPriorityFeePerGasWei: args.maxPriorityFeePerGasWei,
  };
}

export function applySlippage(quoted: bigint, slippageBps: number): bigint {
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / 10_000n;
}

// A roster's `env` is a string map, so a typo silently becomes NaN. Fail at startup instead.
export function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}
