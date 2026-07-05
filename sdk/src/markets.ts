// Core of the token registry + market-config drive (ADR 0013).
//
// A pure layer that generalizes the places that used to hardcode WETH/USDC by name into
// "one market that trades a base token against a quote (USDC-equivalent)". It takes constants'
// TOKENS / MARKET_LEGS (raw addresses, venue legs) and assembles a MarketConfig the adapters can
// drive. New tokens add a market by adding one constant each to TOKENS and MARKET_LEGS (no type/branch changes needed).
import { MARKET_LEGS, TOKENS } from "./constants.js";
import type {
  AaveLeg,
  BalancerLeg,
  CurveLeg,
  GmxLeg,
  ProtocolId,
  TokenKind,
  TokenSymbol,
  UniswapLeg,
} from "./types.js";
import type { Address } from "viem";

export type TokenInfo = {
  symbol: TokenSymbol;
  address: Address;
  decimals: number;
  kind: TokenKind;
};

// The accounting settlement-currency symbol. The venue's actual stable (native USDC / USDC.e / USDT)
// is held in leg.stable, while balances and PnL are summed as "USDC-equivalent" (unified stable
// accounting; consistent with constants' USDC_VARIANTS).
const QUOTE_SYMBOL: TokenSymbol = "USDC";

// Symbols treated as stable. Everything else is base (a tradable with a USD price).
// Add here only when adding a new stable. A base is treated as a base without doing anything.
const STABLE_SYMBOLS = new Set<TokenSymbol>(["USDC", "USDT", "DAI", "USDC.e"]);

export function kindOf(symbol: TokenSymbol): TokenKind {
  return STABLE_SYMBOLS.has(symbol) ? "stable" : "base";
}

export function tokenInfo(symbol: TokenSymbol): TokenInfo {
  const info = TOKENS[symbol];
  if (!info) throw new Error(`markets: unknown token symbol "${symbol}"`);
  return {
    symbol,
    address: info.address,
    decimals: info.decimals,
    kind: kindOf(symbol),
  };
}

export function tokenRegistry(): Record<TokenSymbol, TokenInfo> {
  const out: Record<TokenSymbol, TokenInfo> = {};
  for (const symbol of Object.keys(TOKENS)) out[symbol] = tokenInfo(symbol);
  return out;
}

export function baseTokens(): TokenInfo[] {
  return Object.values(tokenRegistry()).filter((t) => t.kind === "base");
}

export function stableTokens(): TokenInfo[] {
  return Object.values(tokenRegistry()).filter((t) => t.kind === "stable");
}

// Per-venue trading pair. One market that trades a base against a quote (USDC-equivalent).
export type MarketConfig = {
  key: string; // "WETH/USDC" etc. Used for the observation's pair / marketKey
  protocol: ProtocolId;
  base: TokenSymbol;
  quote: TokenSymbol;
  uniswap?: UniswapLeg;
  balancer?: BalancerLeg;
  curve?: CurveLeg;
  gmx?: GmxLeg;
  aave?: AaveLeg;
};

function attachLeg(
  market: MarketConfig,
  protocol: ProtocolId,
  leg: UniswapLeg | BalancerLeg | CurveLeg | GmxLeg | AaveLeg,
): MarketConfig {
  switch (protocol) {
    case "uniswap":
      market.uniswap = leg as UniswapLeg;
      break;
    case "balancer":
      market.balancer = leg as BalancerLeg;
      break;
    case "curve":
      market.curve = leg as CurveLeg;
      break;
    case "gmx":
      market.gmx = leg as GmxLeg;
      break;
    case "aave":
      market.aave = leg as AaveLeg;
      break;
  }
  return market;
}

// Assemble the protocol's enabled markets from MARKET_LEGS. Preserves the base registration order
// (WETH first → the deterministic-order premise for RNG/scoring. ADR 0013 backward compatibility).
export function marketsFor(protocol: ProtocolId): MarketConfig[] {
  const legs = MARKET_LEGS[protocol];
  const out: MarketConfig[] = [];
  for (const base of Object.keys(legs)) {
    const market: MarketConfig = {
      key: `${base}/${QUOTE_SYMBOL}`,
      protocol,
      base,
      quote: QUOTE_SYMBOL,
    };
    out.push(attachLeg(market, protocol, legs[base]));
  }
  return out;
}

export function marketFor(
  protocol: ProtocolId,
  base: TokenSymbol,
): MarketConfig | undefined {
  return marketsFor(protocol).find((m) => m.base === base);
}

// Backward-compatible default base. WETH if present, otherwise the first one.
export function defaultBaseFor(protocol: ProtocolId): TokenSymbol {
  const markets = marketsFor(protocol);
  return (
    markets.find((m) => m.base === "WETH")?.base ?? markets[0]?.base ?? "WETH"
  );
}

// gmx base -> market address (for setting SimContext.gmx.markets). The fork default is {WETH: ETH_USD}.
export function gmxMarketAddresses(): Record<TokenSymbol, Address> {
  const out: Record<TokenSymbol, Address> = {};
  for (const m of marketsFor("gmx")) if (m.gmx) out[m.base] = m.gmx.market;
  return out;
}

// Set of enabled bases across all protocols (used e.g. to derive ACTIVE_BASES in chain.ts).
export function activeBaseSymbols(protocols: ProtocolId[]): TokenSymbol[] {
  const seen = new Set<TokenSymbol>();
  for (const p of protocols) {
    for (const m of marketsFor(p)) seen.add(m.base);
  }
  // Pin WETH first (deterministic order).
  const ordered = [...seen];
  ordered.sort((a, b) => (a === "WETH" ? -1 : b === "WETH" ? 1 : 0));
  return ordered;
}
