// Per-venue withdrawal paths for the liquidityPull stress event (issue #52 phase 2).
//
// The reconcile loop in liquidity.ts is venue-agnostic because all three venues expose the same
// thing: a *proportional claim* on the pool that the environment owns and can shrink. Uniswap calls
// it position liquidity, Balancer calls it BPT, Curve calls it an LP balance -- in each case half
// the claim is half the depth, and giving it up returns both sides at the pool's current ratio, so
// the mid does not move. That property is what keeps this event a constraint rather than a free
// arbitrage, and it is why the one-coin exits (`remove_liquidity_one_coin`,
// EXACT_BPT_IN_FOR_ONE_TOKEN_OUT) are deliberately not used here.
//
// GMX and Aave are a different axis (GM pool depth, reserve liquidity) and out of scope.
import {
  encodeAbiParameters,
  encodeFunctionData,
  maxUint128,
  type Address,
  type Hex,
} from "viem";
import {
  balancerVaultAbi,
  curveTwocryptoLiquidityAbi,
  erc20Abi,
  nonfungiblePositionManagerAbi,
  poolAbi,
} from "@eris/sdk/abis.js";
import { BALANCER, UNISWAP } from "@eris/sdk/constants.js";
import { marketsFor, tokenInfo, type MarketConfig } from "@eris/sdk/markets.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { TokenSymbol } from "@eris/sdk/types.js";
import { getAmountsForLiquidity, getSqrtRatioAtTick } from "./tickMath.js";

export type PullVenue = "uniswap" | "balancer" | "curve";

export const PULL_VENUES: PullVenue[] = ["uniswap", "balancer", "curve"];

// Generous enough for any of the three exits (the Uniswap one is a decrease+collect multicall); a
// fixed value avoids an estimateGas round trip on the critical path of every window block.
export const RECONCILE_GAS = 900_000n;

type UniswapHandle = {
  venue: "uniswap";
  tokenId: bigint;
  pool: Address;
  token0: Address;
  token1: Address;
  tickLower: number;
  tickUpper: number;
};

type BalancerHandle = {
  venue: "balancer";
  poolId: Hex;
  bpt: Address;
  assets: Address[];
};

type CurveHandle = {
  venue: "curve";
  pool: Address; // twocrypto-ng pools are their own LP token
  coins: [Address, Address];
};

export type PullHandle = UniswapHandle | BalancerHandle | CurveHandle;

export type PullPosition = {
  venue: PullVenue;
  base: string;
  marketKey: string;
  handle: PullHandle;
  // The environment's claim at run start. Every target is a fraction of this, and the window has to
  // end back here.
  seededShare: bigint;
};

type PositionTuple = readonly [
  bigint,
  Address,
  Address,
  Address,
  number,
  number,
  number,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

// Balancer encodes its join/exit intent in `userData`.
//
// The exit names the BPT exactly and returns both sides at the pool's weights -- proportional by
// construction. The join has to be built proportionally instead: this deployment's WeightedPool has
// no ALL_TOKENS_IN_FOR_EXACT_BPT_OUT (kind 3) and reverts on it, verified against the state dump, so
// the amounts are scaled from the pool's own balances and the BPT minted follows from them. A
// balanced deposit pays no swap fee, which is what keeps the price still.
const EXIT_EXACT_BPT_IN_FOR_TOKENS_OUT = 1n;
const JOIN_EXACT_TOKENS_IN_FOR_BPT_OUT = 1n;

// A Balancer poolId is the pool address followed by a nonce, which is how the vault itself resolves
// one from the other.
function bptOf(poolId: Hex): Address {
  return poolId.slice(0, 42) as Address;
}

// Round up when scaling a claim into token amounts: a rounded-down side deposits slightly less than
// asked for, every block of the decay leg.
function ceilDiv(a: bigint, b: bigint): bigint {
  return a % b === 0n ? a / b : a / b + 1n;
}

function sortedTokens(
  base: TokenSymbol,
  quote: TokenSymbol,
): [Address, Address] {
  const b = tokenInfo(base).address;
  const q = tokenInfo(quote).address;
  return b.toLowerCase() < q.toLowerCase() ? [b, q] : [q, b];
}

/// Find the environment-owned claims on every requested (venue, base) pair, and record them at their
/// run-start size. A pair that resolves to nothing is returned as a miss rather than skipped: the
/// caller fails fast on it, because a run that logs a liquidity-pull schedule and withdraws nothing
/// is the very defect issue #52 exists to fix.
export async function discoverPullPositions(
  ctx: SimContext,
  venues: PullVenue[],
  bases: string[],
  owner: Address,
): Promise<{ positions: PullPosition[]; misses: string[] }> {
  const positions: PullPosition[] = [];
  const misses: string[] = [];
  for (const venue of venues) {
    const markets = marketsFor(venue).filter((m) => bases.includes(m.base));
    for (const base of bases) {
      const market = markets.find((m) => m.base === base);
      if (!market) {
        misses.push(`${venue}:${base} (no market configured)`);
        continue;
      }
      const found = await discoverOne(ctx, venue, market, owner);
      if (found) positions.push(found);
      else misses.push(`${venue}:${base} (no owned liquidity)`);
    }
  }
  return { positions, misses };
}

async function discoverOne(
  ctx: SimContext,
  venue: PullVenue,
  market: MarketConfig,
  owner: Address,
): Promise<PullPosition | null> {
  const common = { venue, base: market.base, marketKey: market.key };
  if (venue === "uniswap") {
    if (!market.uniswap) return null;
    const [want0, want1] = sortedTokens(market.base, market.quote);
    const key = `${want0.toLowerCase()}:${want1.toLowerCase()}:${market.uniswap.fee}`;
    const count = (await ctx.publicClient.readContract({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    const tokenIds = (await Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        ctx.publicClient.readContract({
          address: UNISWAP.nonfungiblePositionManager,
          abi: nonfungiblePositionManagerAbi,
          functionName: "tokenOfOwnerByIndex",
          args: [owner, BigInt(i)],
        }),
      ),
    )) as bigint[];
    const raws = (await Promise.all(
      tokenIds.map((tokenId) =>
        ctx.publicClient.readContract({
          address: UNISWAP.nonfungiblePositionManager,
          abi: nonfungiblePositionManagerAbi,
          functionName: "positions",
          args: [tokenId],
        }),
      ),
    )) as PositionTuple[];
    for (let i = 0; i < raws.length; i++) {
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity] =
        raws[i];
      if (`${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}` !== key)
        continue;
      if (liquidity <= 0n) continue;
      return {
        ...common,
        handle: {
          venue: "uniswap",
          tokenId: tokenIds[i],
          pool: market.uniswap.pool,
          token0,
          token1,
          tickLower: Number(tickLower),
          tickUpper: Number(tickUpper),
        },
        seededShare: liquidity,
      };
    }
    return null;
  }

  if (venue === "balancer") {
    if (!market.balancer) return null;
    const bpt = bptOf(market.balancer.poolId);
    const balance = (await ctx.publicClient.readContract({
      address: bpt,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    if (balance <= 0n) return null;
    return {
      ...common,
      handle: {
        venue: "balancer",
        poolId: market.balancer.poolId,
        bpt,
        assets: market.balancer.tokens,
      },
      seededShare: balance,
    };
  }

  if (!market.curve) return null;
  const balance = (await ctx.publicClient.readContract({
    address: market.curve.pool,
    abi: curveTwocryptoLiquidityAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  if (balance <= 0n) return null;
  const baseAddr = tokenInfo(market.base as TokenSymbol).address;
  const quoteAddr = tokenInfo(market.quote as TokenSymbol).address;
  const coins: [Address, Address] =
    market.curve.baseIndex === 0
      ? [baseAddr, quoteAddr]
      : [quoteAddr, baseAddr];
  return {
    ...common,
    handle: { venue: "curve", pool: market.curve.pool, coins },
    seededShare: balance,
  };
}

/// The claim the environment currently holds. Read after every write settles, so a revert or a
/// deposit that landed short becomes the next block's delta instead of a silent drift.
export async function readShare(
  ctx: SimContext,
  pos: PullPosition,
  owner: Address,
): Promise<bigint> {
  const h = pos.handle;
  if (h.venue === "uniswap") {
    const raw = (await ctx.publicClient.readContract({
      address: UNISWAP.nonfungiblePositionManager,
      abi: nonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [h.tokenId],
    })) as PositionTuple;
    return raw[7];
  }
  if (h.venue === "balancer") {
    return (await ctx.publicClient.readContract({
      address: h.bpt,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
  }
  return (await ctx.publicClient.readContract({
    address: h.pool,
    abi: curveTwocryptoLiquidityAbi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

/// What the book looks like right now, for post-run attribution: the number an agent's slippage
/// actually depends on, participant liquidity included. Undefined when it cannot be read -- callers
/// treat it as a diagnostic, never as a control input.
export async function readPoolDepth(
  ctx: SimContext,
  pos: PullPosition,
): Promise<bigint | undefined> {
  const h = pos.handle;
  try {
    if (h.venue === "uniswap") {
      return (await ctx.publicClient.readContract({
        address: h.pool,
        abi: poolAbi,
        functionName: "liquidity",
      })) as bigint;
    }
    if (h.venue === "balancer") {
      return (await ctx.publicClient.readContract({
        address: h.bpt,
        abi: erc20Abi,
        functionName: "totalSupply",
      })) as bigint;
    }
    return (await ctx.publicClient.readContract({
      address: h.pool,
      abi: curveTwocryptoLiquidityAbi,
      functionName: "totalSupply",
    })) as bigint;
  } catch {
    return undefined;
  }
}

/// Tokens the owner must approve, and to whom, before the decay leg can put depth back. The
/// deploy-time approvals covered only the exact seeding amounts.
export function approvalsFor(pos: PullPosition): Array<{
  token: Address;
  spender: Address;
}> {
  const h = pos.handle;
  if (h.venue === "uniswap") {
    return [h.token0, h.token1].map((token) => ({
      token,
      spender: UNISWAP.nonfungiblePositionManager,
    }));
  }
  if (h.venue === "balancer") {
    return h.assets.map((token) => ({ token, spender: BALANCER.vault }));
  }
  return h.coins.map((token) => ({ token, spender: h.pool }));
}

export type VenueCall = { to: Address; data: Hex };

/// Give up `share` of the claim, taking both sides at the pool's current ratio.
export async function buildWithdraw(
  ctx: SimContext,
  pos: PullPosition,
  owner: Address,
  share: bigint,
  deadline: bigint,
): Promise<VenueCall> {
  const h = pos.handle;
  if (h.venue === "uniswap") {
    // decreaseLiquidity only credits tokensOwed; the tokens do not leave the pool until collect, and
    // both have to ride in one transaction -- two sends from one key race on the nonce.
    const decrease = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: h.tokenId,
          liquidity: share,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        },
      ],
    });
    const collect = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: h.tokenId,
          recipient: owner,
          amount0Max: maxUint128,
          amount1Max: maxUint128,
        },
      ],
    });
    return {
      to: UNISWAP.nonfungiblePositionManager,
      data: encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: "multicall",
        args: [[decrease, collect]],
      }),
    };
  }

  if (h.venue === "balancer") {
    return {
      to: BALANCER.vault,
      data: encodeFunctionData({
        abi: balancerVaultAbi,
        functionName: "exitPool",
        args: [
          h.poolId,
          owner,
          owner,
          {
            assets: h.assets,
            minAmountsOut: h.assets.map(() => 0n),
            userData: encodeAbiParameters(
              [{ type: "uint256" }, { type: "uint256" }],
              [EXIT_EXACT_BPT_IN_FOR_TOKENS_OUT, share],
            ),
            toInternalBalance: false,
          },
        ],
      }),
    };
  }

  return {
    to: h.pool,
    data: encodeFunctionData({
      abi: curveTwocryptoLiquidityAbi,
      functionName: "remove_liquidity",
      args: [share, [0n, 0n]],
    }),
  };
}

/// Take `share` of the claim back. Uniswap and Curve take token amounts and derive the claim from
/// them at execution price, so both come up short by roughly the price move between this read and
/// the mine -- the reconcile loop reads the position back and carries the shortfall into the next
/// delta rather than adding a margin here, which would only be withdrawn again. Balancer can name
/// the BPT amount exactly, so it does not have that problem.
export async function buildDeposit(
  ctx: SimContext,
  pos: PullPosition,
  owner: Address,
  share: bigint,
  deadline: bigint,
): Promise<VenueCall> {
  const h = pos.handle;
  if (h.venue === "uniswap") {
    const slot0 = (await ctx.publicClient.readContract({
      address: h.pool,
      abi: poolAbi,
      functionName: "slot0",
    })) as readonly [bigint, number, number, number, number, number, boolean];
    const { amount0, amount1 } = getAmountsForLiquidity(
      slot0[0],
      getSqrtRatioAtTick(h.tickLower),
      getSqrtRatioAtTick(h.tickUpper),
      share,
    );
    return {
      to: UNISWAP.nonfungiblePositionManager,
      data: encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: "increaseLiquidity",
        args: [
          {
            tokenId: h.tokenId,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline,
          },
        ],
      }),
    };
  }

  if (h.venue === "balancer") {
    const [, balances] = (await ctx.publicClient.readContract({
      address: BALANCER.vault,
      abi: balancerVaultAbi,
      functionName: "getPoolTokens",
      args: [h.poolId],
    })) as [Address[], bigint[], bigint];
    const supply = (await ctx.publicClient.readContract({
      address: h.bpt,
      abi: erc20Abi,
      functionName: "totalSupply",
    })) as bigint;
    if (supply <= 0n) throw new Error(`balancer pool ${h.bpt} has no supply`);
    const amountsIn = balances.map((b) => ceilDiv(b * share, supply));
    return {
      to: BALANCER.vault,
      data: encodeFunctionData({
        abi: balancerVaultAbi,
        functionName: "joinPool",
        args: [
          h.poolId,
          owner,
          owner,
          {
            assets: h.assets,
            maxAmountsIn: amountsIn,
            userData: encodeAbiParameters(
              [{ type: "uint256" }, { type: "uint256[]" }, { type: "uint256" }],
              [JOIN_EXACT_TOKENS_IN_FOR_BPT_OUT, amountsIn, 0n],
            ),
            fromInternalBalance: false,
          },
        ],
      }),
    };
  }

  // Curve: deposit at the pool's current composition, which is what keeps the price still. The LP
  // minted for a balanced deposit is proportional to supply, so scale each coin by share/totalSupply
  // and round up -- a rounded-down side would mint slightly less than asked for, every block.
  const [totalSupply, balance0, balance1] = (await Promise.all([
    ctx.publicClient.readContract({
      address: h.pool,
      abi: curveTwocryptoLiquidityAbi,
      functionName: "totalSupply",
    }),
    ctx.publicClient.readContract({
      address: h.pool,
      abi: curveTwocryptoLiquidityAbi,
      functionName: "balances",
      args: [0n],
    }),
    ctx.publicClient.readContract({
      address: h.pool,
      abi: curveTwocryptoLiquidityAbi,
      functionName: "balances",
      args: [1n],
    }),
  ])) as [bigint, bigint, bigint];
  if (totalSupply <= 0n) throw new Error(`curve pool ${h.pool} has no supply`);
  const amounts: [bigint, bigint] = [
    ceilDiv(balance0 * share, totalSupply),
    ceilDiv(balance1 * share, totalSupply),
  ];
  return {
    to: h.pool,
    data: encodeFunctionData({
      abi: curveTwocryptoLiquidityAbi,
      functionName: "add_liquidity",
      args: [amounts, 0n],
    }),
  };
}
