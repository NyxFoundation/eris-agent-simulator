import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  balancerQueriesAbi,
  balancerVaultAbi,
  balancerWeightedPoolAbi,
  erc20Abi,
  wethAbi,
} from "../abis.js";
import { poolShareValueUsdc } from "../valuation.js";
import { BALANCER, stableBalanceOf } from "../constants.js";
import {
  marketFor,
  marketsFor,
  tokenInfo,
  tokenInfoByAddress,
  type MarketConfig,
} from "../markets.js";
import {
  resolveMarket,
  twoSidedFields,
  twoSidedQuote,
} from "./marketHelpers.js";
import { dealErc20, sendAndMine } from "../chain.js";
import type {
  AgentObservation,
  AmmObservation,
  BalanceSnapshot,
  BalancerSwapAction,
  LeafAction,
  TokenSymbol,
} from "../types.js";
import type {
  AgentProtocolValue,
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  UnpricedHoldingDetail,
  ValidationResult,
} from "./types.js";
import { approveTx, getPoolPriceUsdcPerWeth } from "./uniswap.js";
import { accountAddress } from "../chain.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const KIND_GIVEN_IN = 0;
// Price probe amount (in base units). Generalizes over decimals, sending 0.1 unit per base.
const PROBE_BASE_FRACTION = 0.1;
const NO_USERDATA = "0x" as Hex;

type BalancerMarketState = {
  market: MarketConfig;
  // base/USD (name kept WETH-compatible; value is this base's price). With a two-sided probe this is
  // the executable mid = sqrt(sell*buy); if only the sell probe succeeded it is the legacy sell quote.
  priceUsdcPerWeth: number;
  // Two-sided executable quotes (unset when the buy probe failed -> consumers fall back to legacy).
  sellPriceUsdcPerWeth?: number;
  buyPriceUsdcPerWeth?: number;
  effectiveHalfSpreadBps?: number;
};

type BalancerState = {
  // WETH market (kept at top level for backward compatibility).
  priceUsdcPerWeth: number;
  // All balancer markets (including WETH). WETH only on the default fork.
  markets: BalancerMarketState[];
};

function wethMarket(): MarketConfig {
  const m = marketFor("balancer", "WETH");
  if (!m) throw new Error("balancer: WETH market not configured");
  return m;
}

function legOf(market: MarketConfig) {
  if (!market.balancer)
    throw new Error(`balancer: market ${market.key} has no leg`);
  return market.balancer;
}

// swap tokenIn (base|quote symbol) -> in/out addresses (market's base / leg.stable).
function swapLeg(
  market: MarketConfig,
  tokenIn: TokenSymbol,
): { assetIn: Address; assetOut: Address } {
  const baseAddr = tokenInfo(market.base).address;
  const stableAddr = legOf(market).stable;
  return tokenIn === market.base
    ? { assetIn: baseAddr, assetOut: stableAddr }
    : { assetIn: stableAddr, assetOut: baseAddr };
}

async function querySwapOut(
  publicClient: PublicClient,
  market: MarketConfig,
  assetIn: Address,
  assetOut: Address,
  amount: bigint,
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: balancerQueriesAbi,
    functionName: "querySwap",
    args: [
      {
        poolId: legOf(market).poolId,
        kind: KIND_GIVEN_IN,
        assetIn,
        assetOut,
        amount,
        userData: NO_USERDATA,
      },
      {
        sender: zeroAddress,
        fromInternalBalance: false,
        recipient: zeroAddress,
        toInternalBalance: false,
      },
    ],
  });
  const result = await publicClient.call({ to: BALANCER.queries, data });
  return decodeFunctionResult({
    abi: balancerQueriesAbi,
    functionName: "querySwap",
    data: result.data ?? "0x",
  }) as bigint;
}

// Derive this market's two-sided quote via querySwap. Sell probe: 0.1 base -> quote (fee-inclusive
// executable sell). Buy probe: the same notional back (quote -> base) on the same state. Together
// they recover the executable mid and the effective per-side cost (see twoSidedQuote). Decimals
// generalized: price = out/quoteScale / (probe/baseScale).
async function getMarketQuote(
  publicClient: PublicClient,
  market: MarketConfig,
): Promise<Omit<BalancerMarketState, "market">> {
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  const baseAddr = tokenInfo(market.base).address;
  const stable = legOf(market).stable;
  const probe = BigInt(Math.round(PROBE_BASE_FRACTION * 10 ** baseDec));
  const sellOut = await querySwapOut(
    publicClient,
    market,
    baseAddr,
    stable,
    probe,
  );
  const sellQuoteFloat = Number(sellOut) / 10 ** quoteDec;
  const sellPx = sellQuoteFloat / PROBE_BASE_FRACTION;
  if (!(sellPx > 0)) return { priceUsdcPerWeth: 0 };
  try {
    const buyOut = await querySwapOut(
      publicClient,
      market,
      stable,
      baseAddr,
      sellOut,
    );
    const buyBaseFloat = Number(buyOut) / 10 ** baseDec;
    if (!(buyBaseFloat > 0)) return { priceUsdcPerWeth: sellPx };
    return twoSidedQuote(sellPx, sellQuoteFloat / buyBaseFloat);
  } catch {
    // Never fail readState harder than the legacy one-sided probe did.
    return { priceUsdcPerWeth: sellPx };
  }
}

// Backward-compatible price helper (executable mid when both probes succeed).
export async function getBalancerPriceFor(
  publicClient: PublicClient,
  market: MarketConfig,
): Promise<number> {
  const quote = await getMarketQuote(publicClient, market);
  return quote.priceUsdcPerWeth;
}

// Backward compatible: WETH market's USDC per WETH.
export async function getBalancerPrice(
  publicClient: PublicClient,
): Promise<number> {
  return getBalancerPriceFor(publicClient, wethMarket());
}

export async function getBalancerState(
  publicClient: PublicClient,
): Promise<BalancerState> {
  const markets = marketsFor("balancer");
  const states = await Promise.all(
    markets.map(async (m) => ({
      market: m,
      ...(await getMarketQuote(publicClient, m)),
    })),
  );
  const weth = states.find((s) => s.market.base === "WETH") ?? states[0];
  return {
    priceUsdcPerWeth: weth.priceUsdcPerWeth,
    markets: states,
  };
}

// ---------------------------------------------------------------------------
// BPT holdings (issue #41)
//
// joinPool is reachable through rawTx, and a BPT balance used to contribute nothing to an agent's
// value — providing liquidity here read as losing the stake outright. The BPT is the pool contract
// itself, whose address is the leading 20 bytes of the poolId.
// ---------------------------------------------------------------------------

export function bptAddressOf(poolId: Hex): Address {
  return `0x${poolId.slice(2, 42)}` as Address;
}

// Distinct pools an agent could hold BPT for, across the configured balancer markets.
export function balancerPools(): Array<{ poolId: Hex; bpt: Address }> {
  const out = new Map<string, { poolId: Hex; bpt: Address }>();
  for (const m of marketsFor("balancer")) {
    const { poolId } = legOf(m);
    out.set(poolId.toLowerCase(), { poolId, bpt: bptAddressOf(poolId) });
  }
  return [...out.values()];
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}
// A Date.now()-based value causes "Transaction too old" once evm_increaseTime pushes EVM time
// past the wall clock. This is a harmless MEV-protection field, so use a far-future constant.
function deadline(): bigint {
  return BigInt(2 ** 32 - 1); // ~ year 2106
}
function requireDecimalString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL_INTEGER.test(value))
    throw new Error(`${name} must be a decimal integer string`);
}

// Read action.base (default WETH) and resolve the corresponding market (for parse).
function parseBase(obj: Record<string, unknown>): {
  base: string;
  market: MarketConfig;
} {
  const base = typeof obj.base === "string" ? obj.base : "WETH";
  const market = marketFor("balancer", base);
  if (!market) throw new Error(`balancer: no market for base "${base}"`);
  return { base, market };
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type !== "balancerSwap") return null;
  const { base, market } = parseBase(obj);
  if (obj.tokenIn !== market.base && obj.tokenIn !== market.quote)
    throw new Error(`tokenIn must be ${market.base} or ${market.quote}`);
  requireDecimalString(obj.amountIn, "amountIn");
  const action: BalancerSwapAction = {
    type: "balancerSwap",
    tokenIn: obj.tokenIn,
    amountIn: obj.amountIn,
  };
  if (base !== "WETH") action.base = base;
  if (obj.maxPriorityFeePerGasWei !== undefined) {
    requireDecimalString(
      obj.maxPriorityFeePerGasWei,
      "maxPriorityFeePerGasWei",
    );
    action.maxPriorityFeePerGasWei = obj.maxPriorityFeePerGasWei;
  }
  if (obj.slippageBps !== undefined) {
    if (
      typeof obj.slippageBps !== "number" ||
      !Number.isInteger(obj.slippageBps) ||
      obj.slippageBps < 0 ||
      obj.slippageBps > 1000
    ) {
      throw new Error("slippageBps must be an integer between 0 and 1000");
    }
    action.slippageBps = obj.slippageBps;
  }
  return action;
}

function validate(
  action: LeafAction,
  obs: AgentObservation,
  balances: BalanceSnapshot,
): ValidationResult {
  if (action.type !== "balancerSwap")
    return { ok: false, reason: "not a balancer action" };
  const amountIn = BigInt(action.amountIn);
  if (amountIn <= 0n) return { ok: false, reason: "amountIn must be positive" };
  const base = action.base ?? "WETH";
  const market = marketFor("balancer", base);
  if (!market) return { ok: false, reason: `no balancer market for ${base}` };
  const inIsBase = action.tokenIn === market.base;
  // ADR 0013: apply the per-round limit to every base. The base side uses per-base limits (WETH=maxWethInWei;
  // additional bases use limits.baseLimits[base]; "0"=no limit). The quote side uses the shared maxUsdcInUnits. WETH is byte-compatible.
  if (inIsBase) {
    const maxBaseIn =
      base === "WETH"
        ? BigInt(obs.limits.maxWethInWei)
        : BigInt(obs.limits.baseLimits?.[base]?.maxSwapInBaseWei ?? "0");
    if (maxBaseIn > 0n && amountIn > maxBaseIn)
      return {
        ok: false,
        reason: "amountIn exceeds configured per-round limit",
      };
  } else if (amountIn > BigInt(obs.limits.maxUsdcInUnits)) {
    return {
      ok: false,
      reason: "amountIn exceeds configured per-round limit",
    };
  }
  const balance = inIsBase
    ? (balances.bases?.[base] ?? balances.wethWei)
    : stableBalanceOf(balances, legOf(market).stable);
  if (amountIn > balance)
    return { ok: false, reason: "amountIn exceeds balance" };
  return { ok: true };
}

async function buildSwapTx(
  publicClient: PublicClient,
  owner: Address,
  market: MarketConfig,
  action: BalancerSwapAction,
): Promise<BuiltTx> {
  const amountIn = BigInt(action.amountIn);
  const slippageBps = action.slippageBps ?? 50;
  const { assetIn, assetOut } = swapLeg(market, action.tokenIn);
  const quoted = await querySwapOut(
    publicClient,
    market,
    assetIn,
    assetOut,
    amountIn,
  );
  const limit = applySlippage(quoted, slippageBps);
  return {
    to: BALANCER.vault,
    data: encodeFunctionData({
      abi: balancerVaultAbi,
      functionName: "swap",
      args: [
        {
          poolId: legOf(market).poolId,
          kind: KIND_GIVEN_IN,
          assetIn,
          assetOut,
          amount: amountIn,
          userData: NO_USERDATA,
        },
        {
          sender: owner,
          fromInternalBalance: false,
          recipient: owner,
          toInternalBalance: false,
        },
        limit,
        deadline(),
      ],
    }),
  };
}

// WeightedPool JoinKind.EXACT_TOKENS_IN_FOR_BPT_OUT = 1
function encodeExactTokensInJoin(amountsIn: bigint[], minBpt: bigint): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint256, uint256[], uint256"),
    [1n, amountsIn, minBpt],
  );
}

// ---------------------------------------------------------------------------
// Admin seed of the fork pool (issue #43)
//
// The Arbitrum pool is depleted at the fork block, so setupGlobal admin-joins it to make it
// tradeable. A weighted pool's spot price is set by its balance/weight ratios, so joining at fixed
// notionals pins the pool at whatever price those notionals imply: the old seed constants meant
// ETH~$2,100, and once spot left that level every fork run died on the startup no-arb check. The
// stable legs are therefore sized from the live price instead — each leg lands on its weight share
// of one total USD value, which is the state at which the pool quotes exactly that price.
// ---------------------------------------------------------------------------

export type SeedLeg = {
  token: Address;
  decimals: number;
  // USD per whole token ($1 for the pool's stable legs).
  priceUsd: number;
  // Normalized weight as the pool reports it (1e18 = 100%).
  weight: bigint;
  // What the pool already holds (raw units). The join adds on top of it.
  balance: bigint;
};

// Amounts to join so the pool ends up quoting each leg at its priceUsd, holding anchorAmount of the
// anchor leg (the base; its notional is the pool's depth knob).
export function seedAmountsIn(
  legs: SeedLeg[],
  anchorIndex: number,
  anchorAmount: bigint,
): bigint[] {
  const anchor = legs[anchorIndex];
  if (!anchor) throw new Error("balancer seed: anchor leg out of range");
  const weightTotal = legs.reduce((sum, l) => sum + Number(l.weight), 0);
  if (!(weightTotal > 0))
    throw new Error("balancer seed: pool reported no normalized weights");
  for (const l of legs) {
    if (!(l.priceUsd > 0))
      throw new Error(`balancer seed: no USD price for leg ${l.token}`);
  }
  const share = (l: SeedLeg) => Number(l.weight) / weightTotal;
  // Total pool value implied by holding anchorAmount of the anchor at its weight share.
  const totalUsd =
    ((Number(anchorAmount) / 10 ** anchor.decimals) * anchor.priceUsd) /
    share(anchor);
  const target = legs.map((l, i) =>
    i === anchorIndex
      ? anchorAmount
      : BigInt(
          Math.round(((share(l) * totalUsd) / l.priceUsd) * 10 ** l.decimals),
        ),
  );
  // A join cannot drain a leg that already holds more than its target, and joining the other legs
  // anyway would seed the pool off-price. Scale every target up instead: the ratios (and so the
  // price) are preserved and the pool only comes out deeper than asked for.
  let scale = 1;
  legs.forEach((l, i) => {
    if (target[i] > 0n && l.balance > target[i])
      scale = Math.max(scale, Number(l.balance) / Number(target[i]));
  });
  return legs.map((l, i) => {
    const t =
      scale > 1 ? BigInt(Math.round(Number(target[i]) * scale)) : target[i];
    return t > l.balance ? t - l.balance : 0n;
  });
}

// Read the pool's registered tokens, weights and residual balances, and price each leg: the base at
// the live market price (the same Uniswap pool the run takes its initial fair price from), the rest
// at $1. The stable legs are the pool's dollar tokens (native USDC / USD₮0), and USD₮0 is not in the
// token registry, so "not a registered base" is what identifies them.
async function readSeedLegs(
  ctx: SimContext,
): Promise<{ assets: Address[]; legs: SeedLeg[]; anchorIndex: number }> {
  const client = ctx.publicClient;
  const [tokens, balances] = (await client.readContract({
    address: BALANCER.vault,
    abi: balancerVaultAbi,
    functionName: "getPoolTokens",
    args: [BALANCER.poolId],
  })) as readonly [readonly Address[], readonly bigint[], bigint];
  const [weights, decimals, basePriceUsd] = await Promise.all([
    client.readContract({
      address: bptAddressOf(BALANCER.poolId),
      abi: balancerWeightedPoolAbi,
      functionName: "getNormalizedWeights",
    }) as Promise<readonly bigint[]>,
    Promise.all(
      tokens.map(
        (token) =>
          client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "decimals",
          }) as Promise<number>,
      ),
    ),
    getPoolPriceUsdcPerWeth(client),
  ]);
  if (weights.length !== tokens.length)
    throw new Error(
      `balancer seed: pool reports ${weights.length} weights for ${tokens.length} tokens`,
    );

  const baseToken = tokenInfo(wethMarket().base).address.toLowerCase();
  let anchorIndex = -1;
  const legs = tokens.map((token, i) => {
    const isAnchor = token.toLowerCase() === baseToken;
    if (isAnchor) anchorIndex = i;
    // Another base in the pool would need its own live price; seeding it at $1 would silently
    // mis-seed the pool, so refuse instead.
    if (!isAnchor && tokenInfoByAddress(token)?.kind === "base")
      throw new Error(
        `balancer seed: pool leg ${token} is a second base token; seeding needs its price`,
      );
    return {
      token,
      decimals: decimals[i],
      priceUsd: isAnchor ? basePriceUsd : 1,
      weight: weights[i],
      balance: balances[i],
    };
  });
  if (anchorIndex < 0)
    throw new Error(
      `balancer seed: pool ${BALANCER.pool} does not hold the market base ${baseToken}`,
    );
  return { assets: [...tokens], legs, anchorIndex };
}

export const balancerAdapter: ProtocolAdapter = {
  id: "balancer",
  stableToken: BALANCER.usdcToken,
  parse,
  bundleable: () => true,
  validate,

  async readState(ctx): Promise<BalancerState> {
    return getBalancerState(ctx.publicClient);
  },

  async observe(ctx, state, _agent, fairPrice): Promise<AmmObservation> {
    const s = state as BalancerState;
    const weth =
      s.markets.find((m) => m.market.base === "WETH") ?? s.markets[0];
    // The observation reports the pool's live price (querySwap estimate). fairPrices is only the
    // last fallback for when state could not be read. Reversing the order (fairPrices first) makes
    // the pool price disappear from the agent's observation and pins it to fair, so cross-venue
    // strategies chase a spread that does not exist forever (introduced in ADR 0013's 2da82e6; a real
    // bug that surfaced as a systematic loss of -1,700 USDC/agent over a 60blk calm regime).
    const obs: AmmObservation = {
      priceUsdcPerWeth:
        weth?.priceUsdcPerWeth ?? ctx.fairPrices?.["WETH"] ?? fairPrice,
      ...twoSidedFields(weth),
    };
    const extra: NonNullable<AmmObservation["markets"]> = {};
    for (const ms of s.markets) {
      if (ms.market.base === "WETH") continue;
      extra[ms.market.key] = {
        priceUsdcPerWeth:
          ms.priceUsdcPerWeth ?? ctx.fairPrices?.[ms.market.base],
        ...twoSidedFields(ms),
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, owner, action): Promise<BuiltTx[]> {
    if (action.type !== "balancerSwap")
      throw new Error("balancer buildTxs: unexpected action");
    const market = resolveMarket("balancer", action);
    return [await buildSwapTx(ctx.publicClient, owner, market, action)];
  },

  async valueUsdc(): Promise<number> {
    return 0;
  },

  // Issue #41: a BPT balance used to contribute nothing. Reserves and supply are shared across
  // agents, the balance is per agent, and all of it fits in one stage.
  async *valueAtBlock(ctx) {
    const pools = balancerPools();
    const empty: Record<string, AgentProtocolValue> = {};
    for (const a of ctx.agents)
      empty[a.id] = { valueUsdc: 0, liquidatableValueUsdc: 0, unpriced: [] };
    if (pools.length === 0) return empty;

    const results = yield [
      ...pools.flatMap(({ poolId, bpt }) => [
        {
          address: BALANCER.vault,
          abi: balancerVaultAbi,
          functionName: "getPoolTokens",
          args: [poolId],
        },
        { address: bpt, abi: erc20Abi, functionName: "totalSupply" },
      ]),
      ...ctx.agents.flatMap((a) =>
        pools.map(({ bpt }) => ({
          address: bpt,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [a.address],
        })),
      ),
    ];

    // A pool whose reserves could not be read decodes to undefined, which reports any holding of it
    // rather than marking a wrong number.
    const reserves = pools.map((_, i) => {
      const poolTokens = results[i * 2] as
        readonly [readonly Address[], readonly bigint[], bigint] | undefined;
      const totalSupply = results[i * 2 + 1];
      if (!poolTokens || typeof totalSupply !== "bigint") return undefined;
      return {
        tokens: [...poolTokens[0]],
        balances: [...poolTokens[1]],
        totalSupply,
      };
    });

    const fairByBase = ctx.fairByBase();
    const stablePrices = ctx.stablePrices();
    const balancesBase = pools.length * 2;
    const out: Record<string, AgentProtocolValue> = {};
    ctx.agents.forEach((agent, a) => {
      let valueUsdc = 0;
      const unpriced: UnpricedHoldingDetail[] = [];
      pools.forEach(({ bpt }, p) => {
        const balance = results[balancesBase + a * pools.length + p];
        if (typeof balance !== "bigint" || balance <= 0n) return;
        const pool = reserves[p];
        if (!pool) {
          unpriced.push({
            token: bpt,
            amountRaw: balance.toString(),
            source: "balancer-bpt",
          });
          return;
        }
        const share = poolShareValueUsdc(
          pool,
          balance,
          fairByBase,
          stablePrices,
        );
        valueUsdc += share.valueUsdc;
        for (const h of share.unpriced)
          unpriced.push({ ...h, source: "balancer-bpt" });
      });
      out[agent.id] = {
        valueUsdc,
        // Proportional exit is fee-free on a weighted pool, so the share is already realizable.
        liquidatableValueUsdc: valueUsdc,
        unpriced,
      };
    });
    return out;
  },

  async accountedTokens(): Promise<Address[]> {
    return balancerPools().map((p) => p.bpt);
  },

  async setupWallet(): Promise<BuiltTx[]> {
    const txs: BuiltTx[] = [];
    const seen = new Set<string>();
    const approve = (token: Address) => {
      const key = token.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      txs.push(approveTx(token, BALANCER.vault));
    };
    for (const m of marketsFor("balancer")) {
      approve(tokenInfo(m.base).address);
      approve(legOf(m).stable);
    }
    return txs;
  },

  // The pool is empty at the fork point, so admin joins and seeds it — at the live price, not at a
  // constant (issue #43; see seedAmountsIn).
  // Only the WETH market is seeded here (seeding the WBTC pool is separate work on the deployer side).
  async setupGlobal(ctx: SimContext): Promise<void> {
    // On local deploy the bundled deployer/ has already seeded the WETH/USDC pool
    // (2 tokens, 80/20). The poc-side 3-token INIT join is unnecessary and breaks on the config mismatch, so skip it.
    if (ctx.config.localDeploy) {
      return;
    }
    const admin = accountAddress(ctx.adminPk);
    const { assets, legs, anchorIndex } = await readSeedLegs(ctx);
    const amountsIn = seedAmountsIn(legs, anchorIndex, BALANCER.seedWethWei);

    // Prepare seed tokens for admin (wrap for WETH, deal for the stables)
    for (const [i, leg] of legs.entries()) {
      if (amountsIn[i] <= 0n) continue;
      if (i === anchorIndex) {
        await sendAndMine(
          ctx.publicClient,
          ctx.walletClient,
          ctx.chain,
          ctx.adminPk,
          {
            to: leg.token,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: "deposit",
              args: [],
            }),
            value: amountsIn[i],
          },
        );
      } else {
        await dealErc20(ctx.publicClient, leg.token, admin, amountsIn[i]);
      }
    }

    for (const token of assets) {
      const approve = approveTx(token, BALANCER.vault);
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        { to: approve.to, data: approve.data },
      );
    }

    const userData = encodeExactTokensInJoin(amountsIn, 0n);
    const joinData = encodeFunctionData({
      abi: balancerVaultAbi,
      functionName: "joinPool",
      args: [
        BALANCER.poolId,
        admin,
        admin,
        {
          assets,
          maxAmountsIn: amountsIn,
          userData,
          fromInternalBalance: false,
        },
      ],
    });
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      { to: BALANCER.vault, data: joinData },
    );
  },
};

export type { BalancerState };
