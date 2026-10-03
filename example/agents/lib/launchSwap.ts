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
  encodeDeployData,
  encodeFunctionData,
  keccak256,
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
import {
  readUntrusted,
  UNTRUSTED_SIMULATION_GAS,
} from "@eris/sdk/untrustedRead.js";
import { readForgeArtifact } from "@eris/sdk/forge.js";

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
  // From the token's own `erc20` registry entry: the code it runs at registration.
  tokenCodehash: Hex;
};

export type LaunchPoolFilter = {
  // keccak256 of the runtime code the environment's launch token has (`launchTokenCodehash`).
  // When given, a pool whose token runs any other code is not a launch pool. `null` means the
  // expected hash could not be computed (no artifact, no node): the shape checks still apply.
  tokenCodehash?: Hex | null;
};

// The addresses the run prices. A pool between two of these is an ordinary market; a pool between
// USDC and anything else is a launch.
function knownTokens(): Set<string> {
  return new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));
}

/**
 * The registry pools that look like the environment's launches, oldest first.
 *
 * Anyone can create a USDC pool for a token of their own, and the registry publishes it exactly as
 * it publishes the environment's (issue #216 (4)). The frozen reference agents in `full-field.yaml`
 * used to buy every such pool, so a participant could set one up and harvest them -- and through
 * them move the field's mean and spread. Nothing in the observation names the environment's launch
 * wallets (they are drawn from the hidden seed; publishing them would publish the count of launches
 * ahead of the windows), so the filter is on what the listing itself must look like:
 *
 *   1. the token has its own `erc20` entry, and the pool's creator deployed it (the environment
 *      deploys the token and creates the pool from one key in one block);
 *   2. the token's code is the environment's `AgentERC20` (fixed supply, no owner, no minter, no
 *      hook), when the caller could compute that hash (`launchTokenCodehash`);
 *   3. the code has not changed since registration.
 *
 * What this does not do: a participant who deploys that same bytecode from the key that creates the
 * pool passes, and that is accepted -- such a token is the same kind of thing as a launch, with the
 * same one risk (its price), so trading it is the strategy's call, not this module's. What it keeps
 * out is every token with other code (a transfer hook, a blacklist, a fee, a mint) and every pool
 * whose creator did not deploy the token. Until the token's entry is published (it can trail the
 * pool's by a block under the per-block registration cap) the pool is not a launch yet.
 */
export function launchPools(
  obs: AgentObservation,
  filter: LaunchPoolFilter = {},
): LaunchPool[] {
  const usdc = TOKENS.USDC.address.toLowerCase();
  const known = knownTokens();
  const entries = obs.registry?.entries ?? [];
  const tokenEntries = new Map(
    entries
      .filter((e) => e.kind === "erc20")
      .map((e) => [e.market.toLowerCase(), e] as const),
  );
  const out: LaunchPool[] = [];
  for (const e of entries) {
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
    const tokenEntry = tokenEntries.get(token.toLowerCase());
    if (!tokenEntry) continue;
    if (tokenEntry.creator.toLowerCase() !== e.creator.toLowerCase()) continue;
    if (
      tokenEntry.codehashNow !== undefined &&
      tokenEntry.codehashNow.toLowerCase() !==
        tokenEntry.codehashAtRegistration.toLowerCase()
    )
      continue;
    if (
      filter.tokenCodehash &&
      tokenEntry.codehashAtRegistration.toLowerCase() !==
        filter.tokenCodehash.toLowerCase()
    )
      continue;
    out.push({
      pool: e.market as Address,
      token: token as Address,
      tokenIsToken0,
      creator: e.creator as Address,
      mine: e.mine,
      registeredAtBlock: Number(e.registeredAtBlock),
      tokenCodehash: tokenEntry.codehashAtRegistration as Hex,
    });
  }
  return out.sort((a, b) => a.registeredAtBlock - b.registeredAtBlock);
}

// The environment lists 18-decimal tokens (core/src/realtime/tokenLaunch.ts LAUNCH_TOKEN_DECIMALS).
// `decimals` is an immutable in AgentERC20, so it is part of the runtime code and of its hash.
const LAUNCH_TOKEN_DECIMALS = 18;
let launchTokenCodehashPromise: Promise<Hex | null> | undefined;

/**
 * keccak256 of the runtime code an environment launch token runs, for `launchPools`'s filter.
 *
 * Computed once per process from the repository's own `AgentERC20` artifact: the creation code is
 * run through `eth_call` with no `to`, which returns the code CREATE would have stored, immutables
 * filled in. The node that lists the environment's tokens is the node answering, so the hash is the
 * registry's `codehashAtRegistration` for them, whatever the compiler did. `null` when the artifact
 * is not on disk (a bundle carries only the artifacts of the contracts its agent deploys) or the
 * call failed; a failure is retried on the next call rather than cached.
 */
export function launchTokenCodehash(client: PublicClient): Promise<Hex | null> {
  if (!launchTokenCodehashPromise) {
    launchTokenCodehashPromise = (async () => {
      let artifact: ReturnType<typeof readForgeArtifact>;
      try {
        artifact = readForgeArtifact("AgentERC20");
      } catch {
        return null;
      }
      try {
        const { data } = await client.call({
          data: encodeDeployData({
            abi: artifact.abi,
            bytecode: artifact.bytecode,
            args: ["", "", LAUNCH_TOKEN_DECIMALS, 0n],
          }),
        });
        if (!data || data === "0x") return null;
        return keccak256(data);
      } catch {
        launchTokenCodehashPromise = undefined;
        return null;
      }
    })();
  }
  return launchTokenCodehashPromise;
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

/**
 * The agent's balance of the launch token. The token is whoever listed it compiled it (the
 * environment's `AgentERC20` for an official launch, a participant's for anything else in the
 * registry), so the read is gas-capped and `undefined` when the token does not answer -- a token
 * whose balance cannot be read cannot be sold this block either (issue #213).
 */
export async function tokenBalance(
  client: PublicClient,
  token: Address,
  holder: Address,
): Promise<bigint | undefined> {
  const read = await readUntrusted(client, {
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  return typeof read.value === "bigint" ? read.value : undefined;
}

/**
 * The router's quote for an exact-input swap through the pool's fee tier. The quoter and the pool
 * are the environment's, but the swap executes the launch token's `transfer` inside the pool, so
 * the simulation carries a gas cap: a quote that needs more than a real swap would is not a trade
 * worth sending (issue #213).
 */
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
    gas: UNTRUSTED_SIMULATION_GAS,
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
