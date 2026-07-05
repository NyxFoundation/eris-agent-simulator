import { encodeFunctionData, type PublicClient } from "viem";
import { curveTricryptoAbi } from "../abis.js";
import { CURVE, TOKENS, stableBalanceOf } from "../constants.js";
import {
  marketFor,
  marketsFor,
  tokenInfo,
  type MarketConfig,
} from "../markets.js";
import { baseFairPrice, resolveMarket } from "./marketHelpers.js";
import type {
  AgentObservation,
  AmmObservation,
  BalanceSnapshot,
  CurveLeg,
  CurveSwapAction,
  LeafAction,
} from "../types.js";
import type {
  BuiltTx,
  ProtocolAdapter,
  SimContext,
  ValidationResult,
} from "./types.js";
import { approveTx } from "./uniswap.js";

const DECIMAL_INTEGER = /^[0-9]+$/;

type CurveMarketState = {
  market: MarketConfig;
  priceUsdcPerWeth: number; // base/USD (name kept WETH-compatible; value is this base's price)
};

type CurveState = {
  // WETH market (kept at top level for backward compatibility).
  priceUsdcPerWeth: number;
  // All curve markets (including WETH). WETH only on the default fork.
  markets: CurveMarketState[];
};

function wethMarket(): MarketConfig {
  const m = marketFor("curve", "WETH");
  if (!m) throw new Error("curve: WETH market not configured");
  return m;
}

function legOf(market: MarketConfig): CurveLeg {
  if (!market.curve) throw new Error(`curve: market ${market.key} has no leg`);
  return market.curve;
}

// Use 0.1 base unit as the probe (small amount to limit slippage impact; price is recovered as output/probe).
function probeBaseAmount(market: MarketConfig): bigint {
  return 10n ** BigInt(tokenInfo(market.base).decimals) / 10n;
}

async function getDy(
  publicClient: PublicClient,
  leg: CurveLeg,
  i: number,
  j: number,
  dx: bigint,
): Promise<bigint> {
  return publicClient.readContract({
    address: leg.pool,
    abi: curveTricryptoAbi,
    functionName: "get_dy",
    args: [BigInt(i), BigInt(j), dx],
  }) as Promise<bigint>;
}

async function getMarketPrice(
  publicClient: PublicClient,
  market: MarketConfig,
): Promise<number> {
  // base probe amount -> quote. Convert to the quote (=USDC-equivalent) price per 1 base (decimals generalized).
  const leg = legOf(market);
  const dx = probeBaseAmount(market);
  const out = await getDy(publicClient, leg, leg.baseIndex, leg.quoteIndex, dx);
  const baseDec = tokenInfo(market.base).decimals;
  const quoteDec = tokenInfo(market.quote).decimals;
  // (out / 10^quoteDec) / (dx / 10^baseDec) = quote per base
  return Number(out) / 10 ** quoteDec / (Number(dx) / 10 ** baseDec);
}

export async function getCurveState(
  publicClient: PublicClient,
): Promise<CurveState> {
  const markets = marketsFor("curve");
  const states = await Promise.all(
    markets.map(async (m) => ({
      market: m,
      priceUsdcPerWeth: await getMarketPrice(publicClient, m),
    })),
  );
  const weth = states.find((s) => s.market.base === "WETH") ?? states[0];
  return {
    priceUsdcPerWeth: weth?.priceUsdcPerWeth ?? 0,
    markets: states,
  };
}

// Backward compatible: WETH/USDC curve price (USDC per WETH). Shared by dashboard/reconstruct.
export async function getCurvePrice(
  publicClient: PublicClient,
): Promise<number> {
  return getMarketPrice(publicClient, wethMarket());
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
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
  const market = marketFor("curve", base);
  if (!market) throw new Error(`curve: no market for base "${base}"`);
  return { base, market };
}

function parse(obj: Record<string, unknown>): LeafAction | null {
  if (obj.type !== "curveSwap") return null;
  const { base, market } = parseBase(obj);
  if (obj.tokenIn !== market.base && obj.tokenIn !== market.quote)
    throw new Error(`tokenIn must be ${market.base} or ${market.quote}`);
  requireDecimalString(obj.amountIn, "amountIn");
  const action: CurveSwapAction = {
    type: "curveSwap",
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
  if (action.type !== "curveSwap")
    return { ok: false, reason: "not a curve action" };
  const amountIn = BigInt(action.amountIn);
  if (amountIn <= 0n) return { ok: false, reason: "amountIn must be positive" };
  const base = action.base ?? "WETH";
  const market = marketFor("curve", base);
  if (!market) return { ok: false, reason: `no curve market for ${base}` };
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
    ? (balances.bases?.[market.base] ?? balances.wethWei)
    : stableBalanceOf(balances, legOf(market).stable);
  if (amountIn > balance)
    return { ok: false, reason: "amountIn exceeds balance" };
  return { ok: true };
}

async function buildSwapTx(
  publicClient: PublicClient,
  market: MarketConfig,
  action: CurveSwapAction,
): Promise<BuiltTx> {
  const leg = legOf(market);
  const amountIn = BigInt(action.amountIn);
  const slippageBps = action.slippageBps ?? 50;
  const [i, j] =
    action.tokenIn === market.base
      ? [leg.baseIndex, leg.quoteIndex]
      : [leg.quoteIndex, leg.baseIndex];
  const quoted = await getDy(publicClient, leg, i, j, amountIn);
  const minDy = applySlippage(quoted, slippageBps);
  return {
    to: leg.pool,
    data: encodeFunctionData({
      abi: curveTricryptoAbi,
      functionName: "exchange",
      args: [BigInt(i), BigInt(j), amountIn, minDy],
    }),
  };
}

export const curveAdapter: ProtocolAdapter = {
  id: "curve",
  stableToken: CURVE.usdcToken,
  parse,
  bundleable: () => true,
  validate,

  async readState(ctx): Promise<CurveState> {
    return getCurveState(ctx.publicClient);
  },

  async observe(ctx, state, _agent, fairPrice): Promise<AmmObservation> {
    const s = state as CurveState;
    const weth =
      s.markets.find((m) => m.market.base === "WETH") ?? s.markets[0];
    const obs: AmmObservation = {
      priceUsdcPerWeth: weth?.priceUsdcPerWeth ?? s.priceUsdcPerWeth,
    };
    const extra: NonNullable<AmmObservation["markets"]> = {};
    for (const ms of s.markets) {
      if (ms.market.base === "WETH") continue;
      extra[ms.market.key] = {
        priceUsdcPerWeth: baseFairPrice(
          ctx,
          ms.market.base,
          ms.priceUsdcPerWeth,
        ),
      };
    }
    if (Object.keys(extra).length > 0) obs.markets = extra;
    return obs;
  },

  async buildTxs(ctx, _owner, action): Promise<BuiltTx[]> {
    if (action.type !== "curveSwap")
      throw new Error("curve buildTxs: unexpected action");
    const market = resolveMarket("curve", action);
    return [await buildSwapTx(ctx.publicClient, market, action)];
  },

  async valueUsdc(): Promise<number> {
    return 0; // swap only. Balance is already counted on the wallet side (stable aggregate)
  },

  async setupWallet(): Promise<BuiltTx[]> {
    const txs: BuiltTx[] = [];
    const seen = new Set<string>();
    const approve = (token: string, spender: string) => {
      const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      txs.push(approveTx(token as `0x${string}`, spender as `0x${string}`));
    };
    for (const m of marketsFor("curve")) {
      const leg = legOf(m);
      approve(tokenInfo(m.base).address, leg.pool);
      approve(leg.stable, leg.pool);
    }
    return txs;
  },
};

export type { CurveState };
