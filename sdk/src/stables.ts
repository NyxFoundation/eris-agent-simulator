// Market-priced stables (issue #27).
//
// The registry used to make a stablecoin worth a dollar by saying so. `chain.ts` summed every active
// stable into one `usdcUnits` figure before anything valued it, and `valuation.ts` priced any token
// of kind "stable" at exactly 1. After that sum no agent could hold an opinion about a stablecoin's
// price and no scorer could either -- a depegged stable was still scored at par, which is the
// phantom-value failure the eUSD adapter was kept *out* of the registry to avoid (#39).
//
// A stable with a market leg here is priced from that market instead. Three properties matter:
//
//   two-sided     One side of a stableswap book is a price you can only get by selling into it.
//                 Marking a holding at it understates the holding as reliably as par overstates it,
//                 so the mark is the geometric mean of both executable directions -- the mid an
//                 unwind actually straddles. Same discipline as the LST and Liquity adapters.
//   one stage     Both probes are fixed-notional, so they are independent reads. Chaining them
//                 (sell, then buy back the proceeds) needs a second round trip, and the scorer
//                 batches one multicall per block cross-section (ADR 0006 §4).
//   says so       A market that will not quote falls back to par -- par is the anchor a CDP's
//                 redemption or an issuer's mint/burn actually enforces, so it is the least wrong
//                 number -- but the fallback is reported. A silent par is the bug; a silent zero
//                 would be worse still, reading as a 100% discount and an infinite free arb.
//
// A stable *without* a market leg keeps the unified USDC-equivalent convention. USDC is that by
// definition -- it is the numéraire and the unit every competition metric is denominated in (issue
// #27, "Settled") -- and on the Arbitrum fork USDC.e and USD₮0 still are, for want of a pool to
// quote them against it.
import { formatUnits, type Address, type PublicClient } from "viem";
import { curveStableSwapNgAbi } from "./abis.js";
import { STABLE_MARKET_LEGS, TOKENS } from "./constants.js";
import { tokenInfoByAddress } from "./markets.js";
import { enabledProtocolIds } from "./protocols/enabled.js";
import type { ProtocolId, TokenSymbol } from "./types.js";

// A stable and the pool that quotes it against the run's USDC.
export type StableMarket = {
  symbol: TokenSymbol;
  token: Address;
  decimals: number;
  // The protocol that brings this stable into a run (see StableMarketLeg.venue).
  venue: ProtocolId;
  // Curve stableswap-ng. Every market-priced stable in this environment trades on one, because that
  // is the pool shape a peg lives on: eUSD/USDC (#39) and USDT/USDC both.
  pool: Address;
  stableIndex: number;
  quoteIndex: number;
  // Probe notional per side, in each coin's own units. Big enough to be a real trade against the
  // seeded depth, small enough to report the pool's price rather than its own footprint.
  probeStableUnits: bigint;
  probeQuoteUnits: bigint;
};

// What one probe pair said about one stable.
export type StableQuote = {
  symbol: TokenSymbol;
  token: Address;
  // USDC per unit of the stable, and the two executable directions it came from. priceUsdc is 1
  // when `quoted` is false -- see the fallback note above.
  priceUsdc: number;
  sellPriceUsdc: number;
  buyPriceUsdc: number;
  // False means priceUsdc is par by fallback rather than an observation of the market.
  quoted: boolean;
};

export type StablePrices = {
  // Lowercase token address -> USDC per unit. Always usable: an unquoted market resolves to par
  // here and is named in `unquoted`, because dropping the balance would be a bigger lie than par.
  byToken: Record<string, number>;
  // Markets that would not quote at this block. Reported by the caller that has somewhere to report.
  unquoted: StableMarket[];
  quotes: StableQuote[];
};

// The prices of a run with no market-priced stable: every stable is the USDC-equivalent dollar.
export const PAR_STABLE_PRICES: StablePrices = {
  byToken: {},
  unquoted: [],
  quotes: [],
};

// Default probe notional, in dollars. 1,000 against the 100k/100k pools this environment seeds is
// ~1% of depth: a real trade, and small enough that the two directions bracket the mid closely.
const DEFAULT_PROBE_USD = 1_000n;

function probeUnits(decimals: number): bigint {
  return DEFAULT_PROBE_USD * 10n ** BigInt(decimals);
}

// Every stable the *deployment* gave a market, whether or not this run enabled its venue. Derived
// once: STABLE_MARKET_LEGS and TOKENS are module constants, and this is called from the per-block
// oracle writes and from every action parse.
let deployedMarkets: StableMarket[] | undefined;

function allMarkets(): StableMarket[] {
  if (deployedMarkets) return deployedMarkets;
  const quoteDecimals = TOKENS.USDC.decimals;
  const out: StableMarket[] = [];
  for (const [symbol, leg] of Object.entries(STABLE_MARKET_LEGS)) {
    const info = TOKENS[symbol];
    // A market leg naming a token the registry does not carry is a generation bug, not a run-time
    // condition: skip it rather than crash a run over a diagnostic price.
    if (!info) continue;
    // USDC is the numéraire and is $1 by definition (issue #27, "Settled"). Letting a pool price it
    // would change what every past run's numbers mean, and every metric is denominated in it -- so
    // a market leg naming it is ignored here rather than quietly redefining the unit.
    if (info.address.toLowerCase() === TOKENS.USDC.address.toLowerCase())
      continue;
    out.push({
      symbol,
      token: info.address,
      decimals: info.decimals,
      venue: leg.venue,
      pool: leg.pool,
      stableIndex: leg.stableIndex,
      quoteIndex: leg.quoteIndex,
      probeStableUnits: probeUnits(info.decimals),
      probeQuoteUnits: probeUnits(quoteDecimals),
    });
  }
  deployedMarkets = out;
  return out;
}

// The market-priced stables this run can actually see, in registry order: those whose owning venue
// the run enabled. Optionally narrowed further to a set of tokens (the run's active stables).
//
// Venue-gated rather than deployment-wide, because the three things have to agree. A stable the run
// did not enable is not swept, so its balance never reaches a value; if it were still parseable and
// approved, an agent could spend USDC on a token the scorer would then not count -- the dollars
// would simply vanish from its score.
export function marketPricedStables(
  tokens?: readonly Address[],
): StableMarket[] {
  const wanted = tokens
    ? new Set(tokens.map((t) => t.toLowerCase()))
    : undefined;
  const enabled = new Set(enabledProtocolIds());
  return allMarkets().filter(
    (m) =>
      enabled.has(m.venue) &&
      (!wanted || wanted.has(m.token.toLowerCase())),
  );
}

// The market-priced stables an explicit protocol set brings with it. Used by initProtocols, which
// runs *while* setting the enabled ids and so cannot read them back yet.
export function stablesForProtocols(
  protocols: readonly ProtocolId[],
): StableMarket[] {
  const enabled = new Set(protocols);
  return allMarkets().filter((m) => enabled.has(m.venue));
}

export function stableMarketFor(token: Address): StableMarket | undefined {
  const target = token.toLowerCase();
  return marketPricedStables().find((m) => m.token.toLowerCase() === target);
}

// True when this token is a dollar by convention rather than by measurement: USDC itself, or a
// registry stable no pool quotes. Funding grants these and only these -- see fundWallet.
//
// Deliberately checked against the whole deployment rather than the enabled venues: a venue-issued
// stable must never be conjured by a cheatcode just because its venue is switched off.
export function isParStable(token: Address): boolean {
  const target = token.toLowerCase();
  return !allMarkets().some((m) => m.token.toLowerCase() === target);
}

// One contract read inside a batched cross-section multicall. Structurally the scorer's
// ValuationRead; declared here so the sdk's pricing layer does not depend on the protocol types.
export type StableProbeRead = {
  address: Address;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous ABIs share a single multicall
  abi: any;
  functionName: string;
  args?: readonly unknown[];
};

// Two reads per market, in a fixed order the decode below mirrors.
export function stableProbeReads(
  markets: readonly StableMarket[],
): StableProbeRead[] {
  const reads: StableProbeRead[] = [];
  for (const m of markets) {
    reads.push({
      address: m.pool,
      abi: curveStableSwapNgAbi,
      functionName: "get_dy",
      args: [BigInt(m.stableIndex), BigInt(m.quoteIndex), m.probeStableUnits],
    });
    reads.push({
      address: m.pool,
      abi: curveStableSwapNgAbi,
      functionName: "get_dy",
      args: [BigInt(m.quoteIndex), BigInt(m.stableIndex), m.probeQuoteUnits],
    });
  }
  return reads;
}

function ratio(
  numerator: bigint,
  numDecimals: number,
  denominator: bigint,
  denDecimals: number,
): number {
  if (denominator <= 0n) return 0;
  const d = Number(formatUnits(denominator, denDecimals));
  if (!(d > 0)) return 0;
  return Number(formatUnits(numerator, numDecimals)) / d;
}

// Turn one market's probe pair into a price. Exported for the tests that pin the marking rules
// without a deployed pool.
export function stableQuoteFrom(
  market: StableMarket,
  sellOut: bigint | undefined,
  buyOut: bigint | undefined,
  quoteDecimals: number,
): StableQuote {
  // Sell: USDC received for a fixed amount of the stable.
  const sellPriceUsdc =
    sellOut === undefined
      ? 0
      : ratio(sellOut, quoteDecimals, market.probeStableUnits, market.decimals);
  // Buy: USDC paid per unit of the stable received for a fixed amount of USDC.
  const buyPriceUsdc =
    buyOut === undefined
      ? 0
      : ratio(market.probeQuoteUnits, quoteDecimals, buyOut, market.decimals);
  const priceUsdc =
    sellPriceUsdc > 0 && buyPriceUsdc > 0
      ? Math.sqrt(sellPriceUsdc * buyPriceUsdc)
      : sellPriceUsdc > 0
        ? sellPriceUsdc
        : buyPriceUsdc;
  return {
    symbol: market.symbol,
    token: market.token,
    priceUsdc: priceUsdc > 0 ? priceUsdc : 1,
    sellPriceUsdc,
    buyPriceUsdc,
    quoted: priceUsdc > 0,
  };
}

// Decode the results of stableProbeReads, in the same order.
export function decodeStableProbes(
  markets: readonly StableMarket[],
  results: readonly unknown[],
): StablePrices {
  const quoteDecimals = TOKENS.USDC.decimals;
  const byToken: Record<string, number> = {};
  const unquoted: StableMarket[] = [];
  const quotes: StableQuote[] = [];
  markets.forEach((market, i) => {
    const sell = results[i * 2];
    const buy = results[i * 2 + 1];
    const quote = stableQuoteFrom(
      market,
      typeof sell === "bigint" ? sell : undefined,
      typeof buy === "bigint" ? buy : undefined,
      quoteDecimals,
    );
    quotes.push(quote);
    byToken[market.token.toLowerCase()] = quote.priceUsdc;
    if (!quote.quoted) unquoted.push(market);
  });
  return { byToken, unquoted, quotes };
}

// The live path: what the agent runtime's observation and the coordinator's end-of-run PnL use.
// Reads are issued together so the client's multicall batching folds them into one round trip.
export async function readStablePrices(
  publicClient: PublicClient,
  tokens?: readonly Address[],
  // Read at a specific block. The end-of-run PnL needs it: the environment's depeg teardown runs
  // after the last competition block, and pricing the close at the restored peg would score the
  // teardown rather than the run.
  blockNumber?: bigint,
): Promise<StablePrices> {
  const markets = marketPricedStables(tokens);
  if (markets.length === 0) return PAR_STABLE_PRICES;
  const reads = stableProbeReads(markets);
  const results = await Promise.all(
    reads.map((read) =>
      publicClient
        .readContract({
          address: read.address,
          abi: read.abi,
          functionName: read.functionName,
          ...(read.args ? { args: read.args } : {}),
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        } as never)
        // A quote the pool refuses is "no market at this size", not a price of zero.
        .catch(() => undefined),
    ),
  );
  return decodeStableProbes(markets, results);
}

// USDC per unit of a stable. Par for the numéraire, for a stable no pool quotes, and for a market
// that did not answer -- the fallback the caller is expected to have already reported.
export function stablePriceUsdc(
  prices: StablePrices | undefined,
  token: Address,
): number {
  return prices?.byToken[token.toLowerCase()] ?? 1;
}

// The symbol a stable balance should be reported under. Falls back to the raw address for the
// fork's USDC.e / USD₮0, which the registry does not name.
export function stableKeyFor(token: Address): string {
  return tokenInfoByAddress(token)?.symbol ?? token.toLowerCase();
}
