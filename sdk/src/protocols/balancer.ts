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
import { balancerQueriesAbi, balancerVaultAbi, wethAbi } from "../abis.js";
import { BALANCER, TOKENS, stableBalanceOf } from "../constants.js";
import {
  marketFor,
  marketsFor,
  tokenInfo,
  type MarketConfig,
} from "../markets.js";
import { resolveMarket } from "./marketHelpers.js";
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
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";
import { approveTx } from "./uniswap.js";
import { accountAddress } from "../chain.js";

const DECIMAL_INTEGER = /^[0-9]+$/;
const KIND_GIVEN_IN = 0;
// Price probe amount (in base units). Generalizes over decimals, sending 0.1 unit per base.
const PROBE_BASE_FRACTION = 0.1;
const NO_USERDATA = "0x" as Hex;

type BalancerMarketState = {
  market: MarketConfig;
  priceUsdcPerWeth: number; // base/USD (name kept WETH-compatible; value is this base's price)
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

// Derive this market's base/USD via querySwap (divide the base->stable out by the probe amount).
// Decimals generalized: probe = 0.1 base, price = out/quoteScale / (probe/baseScale).
export async function getBalancerPriceFor(
  publicClient: PublicClient,
  market: MarketConfig,
): Promise<number> {
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  const probe = BigInt(Math.round(PROBE_BASE_FRACTION * 10 ** baseDec));
  const out = await querySwapOut(
    publicClient,
    market,
    tokenInfo(market.base).address,
    legOf(market).stable,
    probe,
  );
  const outQuote = Number(out) / 10 ** quoteDec;
  return outQuote / PROBE_BASE_FRACTION;
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
      priceUsdcPerWeth: await getBalancerPriceFor(publicClient, m),
    })),
  );
  const weth = states.find((s) => s.market.base === "WETH") ?? states[0];
  return {
    priceUsdcPerWeth: weth.priceUsdcPerWeth,
    markets: states,
  };
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
    };
    const extra: NonNullable<AmmObservation["markets"]> = {};
    for (const ms of s.markets) {
      if (ms.market.base === "WETH") continue;
      extra[ms.market.key] = {
        priceUsdcPerWeth:
          ms.priceUsdcPerWeth ?? ctx.fairPrices?.[ms.market.base],
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

  // The pool is empty at the fork point, so admin joins and seeds it.
  // Only the WETH market is seeded here (seeding the WBTC pool is separate work on the deployer side).
  async setupGlobal(ctx: SimContext): Promise<void> {
    // On local deploy the bundled deployer/ has already seeded the WETH/USDC pool
    // (2 tokens, 80/20). The poc-side 3-token INIT join is unnecessary and breaks on the config mismatch, so skip it.
    if (ctx.config.localDeploy) {
      return;
    }
    const admin = accountAddress(ctx.adminPk);
    // Prepare seed tokens for admin (wrap for WETH, deal for the stables)
    await sendAndMine(
      ctx.publicClient,
      ctx.walletClient,
      ctx.chain,
      ctx.adminPk,
      {
        to: TOKENS.WETH.address,
        data: encodeFunctionData({
          abi: wethAbi,
          functionName: "deposit",
          args: [],
        }),
        value: BALANCER.seedWethWei,
      },
    );
    await dealErc20(
      ctx.publicClient,
      BALANCER.tokens[1],
      admin,
      BALANCER.seedUsdcUnits,
    );
    await dealErc20(
      ctx.publicClient,
      BALANCER.tokens[2],
      admin,
      BALANCER.seedUsdtUnits,
    );

    for (const token of BALANCER.tokens) {
      const approve = approveTx(token, BALANCER.vault);
      await sendAndMine(
        ctx.publicClient,
        ctx.walletClient,
        ctx.chain,
        ctx.adminPk,
        { to: approve.to, data: approve.data },
      );
    }

    const amountsIn = [
      BALANCER.seedWethWei,
      BALANCER.seedUsdcUnits,
      BALANCER.seedUsdtUnits,
    ];
    const userData = encodeExactTokensInJoin(amountsIn, 0n);
    const joinData = encodeFunctionData({
      abi: balancerVaultAbi,
      functionName: "joinPool",
      args: [
        BALANCER.poolId,
        admin,
        admin,
        {
          assets: BALANCER.tokens,
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
