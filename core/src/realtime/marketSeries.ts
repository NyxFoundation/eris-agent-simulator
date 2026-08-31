// Post-run market series reconstruction (issue #63 Phase 2).
//
// The dashboard needs per-block per-venue prices, venue state (GMX OI/funding, Aave reserve totals,
// pool depth) and per-tx notionals. None of that may cost the live loop anything (the coordinator
// runs on a per-block time budget), so — like the value series (ADR 0006 §4) — everything here is
// derived after the run ends from the historical block state anvil retains, via blockNumber-pinned
// Multicall3 batches, and materialized into runs/<id>/market.json.
//
// This is a reporting artifact, not scoring: a failed read degrades a sample instead of failing the
// run, and failedReads/failedReadTargets carry the same accountability as valueSeries.
import type { Address, Hex, PublicClient } from "viem";
import { encodeAbiParameters, keccak256, parseAbi, zeroAddress } from "viem";
import {
  balancerQueriesAbi,
  curveTricryptoAbi,
  erc20Abi,
  lstVaultAbi,
  poolAbi,
  stabilityPoolAbi,
  troveManagerAbi,
} from "@eris/sdk/abis.js";
import {
  AAVE,
  BALANCER,
  GMX,
  LIQUITY,
  LST,
  MULTICALL3,
  USDC_VARIANTS,
} from "@eris/sdk/constants.js";
import {
  baseTokens,
  marketsFor,
  tokenInfo,
  tokenInfoByAddress,
} from "@eris/sdk/markets.js";
import { aaveReserveDataAbi } from "@eris/sdk/protocols/aave.js";
import { twoSidedQuote } from "@eris/sdk/protocols/marketHelpers.js";
import {
  decodeStableProbes,
  stableProbeReads,
  stablesForProtocols,
  type StableMarket,
} from "@eris/sdk/stables.js";
import { poolPriceFromSqrtX96 } from "@eris/sdk/protocols/uniswap.js";
import type { MarketConfig } from "@eris/sdk/markets.js";
import type { ProtocolId } from "@eris/sdk/types.js";
import { fromPriceFeedAnswer, priceFeedAbi } from "./priceFeed.js";
import {
  scoringBlocks,
  type FailedReadTarget,
  type ReconstructionAgent,
} from "./reconstruct.js";

// ---------------------------------------------------------------------------
// artifact shape (consumed by dashboard/src/data/runArtifacts.ts)

export type VenueQuoteSample = {
  mid: number;
  // Two-sided quotes at probe size. Curve/balancer are measured executable probes; uniswap is
  // slot0 mid +/- pool fee — the same "impact at probe size is negligible on the deep pool"
  // approximation the no-arb monitor uses (core/src/realtime/noArb.ts quoteFor), not a tick-walk.
  buy?: number;
  sell?: number;
  // Total pool depth in USD (both sides at fair/par). What the liquidityPull event moves.
  depthUsd?: number;
};

export type MarketSeriesRow = {
  block: number;
  // base symbol -> fair USD (the on-chain PriceFeed answer, multi-asset).
  fair: Record<string, number>;
  // venue -> base -> quote sample.
  venues?: Record<string, Record<string, VenueQuoteSample>>;
  gmx?: Record<
    string,
    // fundingPerHourBps derives from SAVED_FUNDING_FACTOR_PER_SECOND (an approximation of the
    // current rate). Absent when the read failed — a failed read must not print as 0.00bps.
    { longOiUsd: number; shortOiUsd: number; fundingPerHourBps?: number }
  >;
  // asset symbol -> reserve totals.
  aave?: Record<
    string,
    { suppliedUsd: number; borrowedUsd: number; utilization: number }
  >;
  // Market-priced stables (issue #27): symbol -> the same two-sided probe the scorer marks them
  // with. `quoted: false` means the pool refused to quote and priceUsdc is par by fallback — the
  // one number here that must never be read as "the peg held".
  stables?: Record<
    string,
    {
      priceUsdc: number;
      sellPriceUsdc: number;
      buyPriceUsdc: number;
      quoted: boolean;
    }
  >;
};

export type GmxPositionAtEnd = {
  agent: string;
  base: string;
  isLong: boolean;
  sizeUsd: number;
  collateralUsd: number;
  entryPriceUsd: number | null;
};

// An LST holding is two numbers for one asset: the vault's par (behind a withdrawal queue) and what
// the queue has actually released. Both, because the gap is the position's whole point (issue #38).
export type LstPositionAtEnd = {
  agent: string;
  shares: number;
  /** shares valued at the vault's redemption rate — the par it owes. */
  shareAssetsWeth: number;
  /** Queued and already finalizable. */
  claimableWeth: number;
  /** Queued but not yet finalizable at this block. */
  pendingWeth: number;
  openRequests: number;
};

// A CDP position is a debt and a collateral, and the ICR is the line the venue liquidates on. The
// Stability Pool deposit is a separate claim on the same venue, so it is reported beside it.
export type LiquityPositionAtEnd = {
  agent: string;
  /** getEntireDebtAndColl: includes pending redistribution, which is what the system will charge. */
  troveDebtEusd: number;
  troveCollWeth: number;
  /** null when the agent has no Trove (the ICR of nothing is not 0). */
  icr: number | null;
  stabilityDepositEusd: number;
  eusdBalance: number;
};

export type AaveAccountAtEnd = {
  agent: string;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number | null;
};

export type TxNotional = {
  // USD moved by the tx from the sender's perspective: max(inbound, outbound) over priceable legs.
  usd: number;
  // The largest single priceable leg, human-readable ("4.20 WETH").
  amount: string;
  // Set when exactly one base token had a nonzero net flow for the sender.
  base?: string;
  side?: "buy" | "sell";
  // Absolute net base flow, in whole tokens. Set together with base/side.
  baseUnits?: number;
  // Per-unit price actually paid/received: the counter-leg USD divided by baseUnits. Only set when
  // the tx really exchanged both legs (a one-sided transfer such as an Aave supply has no counter
  // leg and no price) — which is also what distinguishes a swap from a deposit downstream.
  priceUsd?: number;
};

export type MarketSeriesArtifact = {
  source: "post-run-reconstruction";
  fromBlock: number;
  toBlock: number;
  granularityBlocks: number;
  rows: number;
  failedReads: number;
  failedReadTargets: FailedReadTarget[];
  elapsedMs: number;
  bases: string[];
  venues: string[];
  series: MarketSeriesRow[];
  gmxPositionsAtEnd: GmxPositionAtEnd[];
  aaveAccountsAtEnd: AaveAccountAtEnd[];
  lstPositionsAtEnd: LstPositionAtEnd[];
  liquityPositionsAtEnd: LiquityPositionAtEnd[];
  // tx hash (lowercase) -> decoded notional. Absent hashes moved nothing priceable.
  notionals: Record<string, TxNotional>;
  notionalsMeta: {
    source: "receipts";
    txsSeen: number;
    decoded: number;
    receiptFailures: number;
    unknownTokenTransfers: number;
  };
};

// The meta the coordinator logs to events.jsonl — everything except the bulky series/notionals.
export type MarketSeriesMeta = Omit<
  MarketSeriesArtifact,
  | "series"
  | "notionals"
  | "gmxPositionsAtEnd"
  | "aaveAccountsAtEnd"
  | "lstPositionsAtEnd"
  | "liquityPositionsAtEnd"
>;

export function marketSeriesMeta(a: MarketSeriesArtifact): MarketSeriesMeta {
  const {
    series: _s,
    notionals: _n,
    gmxPositionsAtEnd: _g,
    aaveAccountsAtEnd: _a,
    lstPositionsAtEnd: _l,
    liquityPositionsAtEnd: _q,
    ...meta
  } = a;
  return meta;
}

// ---------------------------------------------------------------------------
// ABIs / GMX DataStore keys

const dataStoreReadAbi = parseAbi([
  "function getUint(bytes32 key) view returns (uint256)",
  "function getInt(bytes32 key) view returns (int256)",
]);

const vaultAbi = parseAbi([
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
]);

const readerMarketAbi = parseAbi([
  "function getMarket(address dataStore, address key) view returns ((address marketToken, address indexToken, address longToken, address shortToken))",
]);

const readerPositionsAbi = [
  {
    type: "function",
    name: "getAccountPositions",
    stateMutability: "view",
    inputs: [
      { name: "dataStore", type: "address" },
      { name: "account", type: "address" },
      { name: "start", type: "uint256" },
      { name: "end", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          {
            name: "addresses",
            type: "tuple",
            components: [
              { name: "account", type: "address" },
              { name: "market", type: "address" },
              { name: "collateralToken", type: "address" },
            ],
          },
          {
            name: "numbers",
            type: "tuple",
            components: [
              { name: "sizeInUsd", type: "uint256" },
              { name: "sizeInTokens", type: "uint256" },
              { name: "collateralAmount", type: "uint256" },
              { name: "pendingImpactAmount", type: "int256" },
              { name: "borrowingFactor", type: "uint256" },
              { name: "fundingFeeAmountPerSize", type: "uint256" },
              {
                name: "longTokenClaimableFundingAmountPerSize",
                type: "uint256",
              },
              {
                name: "shortTokenClaimableFundingAmountPerSize",
                type: "uint256",
              },
              { name: "increasedAtTime", type: "uint256" },
              { name: "decreasedAtTime", type: "uint256" },
            ],
          },
          {
            name: "flags",
            type: "tuple",
            components: [{ name: "isLong", type: "bool" }],
          },
        ],
      },
    ],
  },
] as const;

const aavePoolAccountAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

// Keys.sol derivations (deployer/vendor/gmx-src/contracts/data/Keys.sol).
function hashString(s: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }], [s]));
}
const OPEN_INTEREST = hashString("OPEN_INTEREST");
const SAVED_FUNDING_FACTOR_PER_SECOND = hashString(
  "SAVED_FUNDING_FACTOR_PER_SECOND",
);

export function gmxOpenInterestKey(
  market: Address,
  collateralToken: Address,
  isLong: boolean,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
      ],
      [OPEN_INTEREST, market, collateralToken, isLong],
    ),
  );
}

function gmxSavedFundingKey(market: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [SAVED_FUNDING_FACTOR_PER_SECOND, market],
    ),
  );
}

// ---------------------------------------------------------------------------
// multicall plumbing (mirrors reconstruct.ts, kept local: this artifact must degrade, not fail)

type MulticallContract = {
  address: Address;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous ABIs share a single multicall
  abi: any;
  functionName: string;
  args?: readonly unknown[];
};

class ReadBatch {
  readonly contracts: MulticallContract[] = [];
  push(contract: MulticallContract): number {
    this.contracts.push(contract);
    return this.contracts.length - 1;
  }
}

function mergeFailedReads(
  into: Map<string, FailedReadTarget>,
  target: { address: Address; functionName: string },
): void {
  const key = `${target.address.toLowerCase()}|${target.functionName}`;
  const existing = into.get(key);
  if (existing) existing.count += 1;
  else into.set(key, { ...target, count: 1 });
}

// ---------------------------------------------------------------------------
// static layout (resolved once at toBlock; addresses are immutable for a deployment)

const AMM_VENUES = ["uniswap", "balancer", "curve"] as const;
type AmmVenue = (typeof AMM_VENUES)[number];

type AmmMarketLayout = {
  venue: AmmVenue;
  market: MarketConfig;
  base: string;
  baseAddr: Address;
  baseDec: number;
  quoteDec: number;
  probeDx: bigint; // 0.1 base unit, same convention as the adapters' readState probes
};

type GmxMarketLayout = {
  base: string;
  marketToken: Address;
  indexToken: Address;
  longToken: Address;
  shortToken: Address;
  indexDec: number;
};

type AaveReserveLayout = {
  symbol: string;
  asset: Address;
  decimals: number;
  aToken: Address;
  variableDebtToken: Address;
};

function ammMarketLayouts(enabledIds: ProtocolId[]): AmmMarketLayout[] {
  const out: AmmMarketLayout[] = [];
  for (const venue of AMM_VENUES) {
    if (!enabledIds.includes(venue)) continue;
    for (const market of marketsFor(venue)) {
      const baseInfo = tokenInfo(market.base);
      out.push({
        venue,
        market,
        base: market.base,
        baseAddr: baseInfo.address,
        baseDec: baseInfo.decimals,
        quoteDec: tokenInfo(market.quote).decimals,
        probeDx: 10n ** BigInt(baseInfo.decimals) / 10n,
      });
    }
  }
  return out;
}

async function resolveGmxMarkets(
  publicClient: PublicClient,
  enabledIds: ProtocolId[],
  blockNumber: bigint,
): Promise<GmxMarketLayout[]> {
  if (!enabledIds.includes("gmx")) return [];
  const markets = marketsFor("gmx").filter((m) => m.gmx);
  if (markets.length === 0) return [];
  const props = (await publicClient.multicall({
    contracts: markets.map((m) => ({
      address: GMX.Reader,
      abi: readerMarketAbi,
      functionName: "getMarket",
      args: [GMX.DataStore, m.gmx?.market as Address],
    })) as never,
    blockNumber,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  const out: GmxMarketLayout[] = [];
  markets.forEach((m, i) => {
    const p = props[i];
    if (p.status !== "success") return;
    const r = p.result as {
      marketToken: Address;
      indexToken: Address;
      longToken: Address;
      shortToken: Address;
    };
    out.push({
      base: m.base,
      marketToken: r.marketToken,
      indexToken: r.indexToken,
      longToken: r.longToken,
      shortToken: r.shortToken,
      indexDec: tokenInfo(m.base).decimals,
    });
  });
  return out;
}

async function resolveAaveReserves(
  publicClient: PublicClient,
  enabledIds: ProtocolId[],
  blockNumber: bigint,
): Promise<AaveReserveLayout[]> {
  if (!enabledIds.includes("aave")) return [];
  const candidates = [
    ...baseTokens().map((t) => ({ symbol: t.symbol, info: t })),
    { symbol: "USDC", info: tokenInfo("USDC") },
  ];
  const data = (await publicClient.multicall({
    contracts: candidates.map((c) => ({
      address: AAVE.Pool,
      abi: aaveReserveDataAbi,
      functionName: "getReserveData",
      args: [c.info.address],
    })) as never,
    blockNumber,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  const out: AaveReserveLayout[] = [];
  candidates.forEach((c, i) => {
    const r = data[i];
    if (r.status !== "success") return;
    const reserve = r.result as {
      aTokenAddress: Address;
      variableDebtTokenAddress: Address;
    };
    if (!reserve.aTokenAddress || reserve.aTokenAddress === zeroAddress) return;
    out.push({
      symbol: c.symbol,
      asset: c.info.address,
      decimals: c.info.decimals,
      aToken: reserve.aTokenAddress,
      variableDebtToken: reserve.variableDebtTokenAddress,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// per-block sampling

// The fork pools pair against USDC.e (balancer) and USDT (curve/tricrypto) — USDC-equivalent
// 6-decimal stables that are not in the TOKENS registry. Without them a fork run's balancer and
// curve depth silently vanish from the series.
const USDC_EQUIVALENTS = new Set(
  Object.values(USDC_VARIANTS).map((a) => a.toLowerCase()),
);

// USD price of a pool-side token given the row's fair map: bases at fair, stables at par (a
// reporting approximation — depth is a size, not a mark), anything else unpriceable.
function tokenUsd(
  token: Address,
  amount: bigint,
  fair: Record<string, number>,
): number | undefined {
  const info = tokenInfoByAddress(token);
  if (!info) {
    if (USDC_EQUIVALENTS.has(token.toLowerCase())) return Number(amount) / 1e6; // USDC.e / USD₮0, both 6 decimals, at par
    return undefined;
  }
  const units = Number(amount) / 10 ** info.decimals;
  if (info.kind === "stable") return units;
  const price = fair[info.symbol];
  return price !== undefined && price > 0 ? units * price : undefined;
}

// ---------------------------------------------------------------------------
// tx notionals (decoded from receipts)

const TRANSFER_TOPIC =
  // keccak256("Transfer(address,address,uint256)")
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export type DecodedTransfer = {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
};

// Pure summarizer, exported for unit tests: what a tx moved from the sender's point of view.
export function summarizeTransfers(opts: {
  sender: Address;
  transfers: DecodedTransfer[];
  // base symbol -> fair USD at the tx's block.
  fair: Record<string, number>;
  onUnknownToken?: () => void;
}): TxNotional | undefined {
  const sender = opts.sender.toLowerCase();
  let inUsd = 0;
  let outUsd = 0;
  let largest: { usd: number; units: number; symbol: string } | undefined;
  const netBaseUnits = new Map<string, number>();
  for (const t of opts.transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from !== sender && to !== sender) continue;
    // Self-transfers move nothing.
    if (from === sender && to === sender) continue;
    const info = tokenInfoByAddress(t.token);
    if (!info) {
      opts.onUnknownToken?.();
      continue;
    }
    const units = Number(t.value) / 10 ** info.decimals;
    const usd =
      info.kind === "stable"
        ? units
        : (opts.fair[info.symbol] ?? 0) > 0
          ? units * opts.fair[info.symbol]
          : undefined;
    if (usd === undefined) {
      opts.onUnknownToken?.();
      continue;
    }
    if (to === sender) inUsd += usd;
    else outUsd += usd;
    if (info.kind === "base") {
      const signed = to === sender ? units : -units;
      netBaseUnits.set(
        info.symbol,
        (netBaseUnits.get(info.symbol) ?? 0) + signed,
      );
    }
    if (!largest || usd > largest.usd) {
      largest = { usd, units, symbol: info.symbol };
    }
  }
  if (!largest) return undefined;
  const usd = Math.max(inUsd, outUsd);
  if (!(usd > 0)) return undefined;
  const flows = [...netBaseUnits.entries()].filter(
    ([, net]) => Math.abs(net) > 1e-12,
  );
  const single = flows.length === 1 ? flows[0] : undefined;
  let priced: { baseUnits: number; priceUsd: number } | undefined;
  if (single) {
    const baseUnits = Math.abs(single[1]);
    // The counter leg is whatever moved the other way: what was paid for a buy, received for a
    // sell. A one-sided transfer (an Aave supply, GMX collateral) has no counter leg and gets no
    // price — which is exactly what tells a swap apart from a deposit.
    const counterUsd = single[1] > 0 ? outUsd : inUsd;
    if (counterUsd > 0 && baseUnits > 0) {
      priced = { baseUnits, priceUsd: counterUsd / baseUnits };
    }
  }
  return {
    usd,
    amount: `${formatUnitsShort(largest.units)} ${largest.symbol}`,
    ...(single
      ? {
          base: single[0],
          side: single[1] > 0 ? ("buy" as const) : ("sell" as const),
        }
      : {}),
    ...(priced ?? {}),
  };
}

function formatUnitsShort(units: number): string {
  if (units >= 1000)
    return units.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (units >= 1) return units.toFixed(2);
  return units.toPrecision(3);
}

// ---------------------------------------------------------------------------
// main entry

// A market sampler that stays alive across the run, so a row can be taken at the block it describes
// rather than replayed out of history afterwards (ADR 0021 §3).
//
// The layouts -- which AMM markets, which GMX markets, which Aave reserves -- are resolved once and
// reused, which is also why this is a class: they cost several reads each, and on a chain that never
// restarts there is no "after" in which to resolve them.
export class LiveMarketSampler {
  private layouts: {
    extraBases: string[];
    ammMarkets: AmmMarketLayout[];
    gmxMarkets: GmxMarketLayout[];
    aaveReserves: AaveReserveLayout[];
    stableMarkets: StableMarket[];
  } | null = null;

  constructor(
    private readonly opts: {
      publicClient: PublicClient;
      enabledIds: ProtocolId[];
      priceFeed: Address;
    },
  ) {}

  private async call(
    contracts: MulticallContract[],
    blockNumber: bigint,
  ): Promise<unknown[]> {
    if (contracts.length === 0) return [];
    const results = (await this.opts.publicClient.multicall({
      contracts: contracts as never,
      blockNumber,
      multicallAddress: MULTICALL3,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
    return results.map((r) => (r.status === "failure" ? undefined : r.result));
  }

  private async resolve(blockNumber: number) {
    if (this.layouts) return this.layouts;
    this.layouts = {
      extraBases: baseTokens()
        .map((t) => t.symbol)
        .filter((s) => s !== "WETH"),
      ammMarkets: ammMarketLayouts(this.opts.enabledIds),
      gmxMarkets: await resolveGmxMarkets(
        this.opts.publicClient,
        this.opts.enabledIds,
        BigInt(blockNumber),
      ),
      aaveReserves: await resolveAaveReserves(
        this.opts.publicClient,
        this.opts.enabledIds,
        BigInt(blockNumber),
      ),
      stableMarkets: stablesForProtocols(this.opts.enabledIds),
    };
    return this.layouts;
  }

  async sample(blockNumber: number): Promise<MarketSeriesRow | undefined> {
    const layouts = await this.resolve(blockNumber);
    return sampleBlock({
      call: (contracts, bn) => this.call(contracts, bn),
      blockNumber,
      priceFeed: this.opts.priceFeed,
      ...layouts,
    });
  }
}

export async function reconstructMarketSeries(opts: {
  publicClient: PublicClient;
  agents: ReconstructionAgent[];
  enabledIds: ProtocolId[];
  priceFeed: Address;
  fromBlock: number;
  toBlock: number;
  // Same thinning knob as the value series (config.scoreEvery): this is a view artifact and the
  // same granularity notion applies.
  scoreEvery?: number;
}): Promise<MarketSeriesArtifact> {
  const {
    publicClient,
    agents,
    enabledIds,
    priceFeed,
    fromBlock,
    toBlock,
    scoreEvery = 1,
  } = opts;
  const started = Date.now();
  let failedReads = 0;
  const failedReadTargets = new Map<string, FailedReadTarget>();

  const call = async (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ): Promise<unknown[]> => {
    if (contracts.length === 0) return [];
    const results = (await publicClient.multicall({
      contracts: contracts as never,
      blockNumber,
      multicallAddress: MULTICALL3,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
    return results.map((r, i) => {
      if (r.status === "failure") {
        failedReads++;
        mergeFailedReads(failedReadTargets, contracts[i]);
        return undefined;
      }
      return r.result;
    });
  };

  const extraBases = baseTokens()
    .map((t) => t.symbol)
    .filter((s) => s !== "WETH");
  const ammMarkets = ammMarketLayouts(enabledIds);
  const gmxMarkets = await resolveGmxMarkets(
    publicClient,
    enabledIds,
    BigInt(toBlock),
  );
  const aaveReserves = await resolveAaveReserves(
    publicClient,
    enabledIds,
    BigInt(toBlock),
  );
  // Venue-gated like everywhere else: a stable whose owning venue this run did not enable is not
  // tradable and not swept, so probing it would report a price nobody could act on.
  const stableMarkets = stablesForProtocols(enabledIds);

  // ---- the per-block series ----
  const blocks = scoringBlocks(fromBlock, toBlock, scoreEvery);
  const series: MarketSeriesRow[] = [];
  for (const b of blocks) {
    const row = await sampleBlock({
      call,
      blockNumber: b,
      priceFeed,
      extraBases,
      ammMarkets,
      gmxMarkets,
      aaveReserves,
      stableMarkets,
    });
    if (row) series.push(row);
  }

  // ---- end-of-run per-agent venue state ----
  const gmxPositionsAtEnd = await readGmxPositionsAtEnd({
    call,
    agents,
    gmxMarkets,
    blockNumber: toBlock,
    fair: series[series.length - 1]?.fair ?? {},
  });
  const aaveAccountsAtEnd = enabledIds.includes("aave")
    ? await readAaveAccountsAtEnd({ call, agents, blockNumber: toBlock })
    : [];
  // The LST vault and the CDP are the two venues an agent can hold a position in that no other
  // artifact records per agent — the scorer values them but writes only the total (issue #38/#39).
  const lstPositionsAtEnd = enabledIds.includes("lst")
    ? await readLstPositionsAtEnd({ call, agents, blockNumber: toBlock })
    : [];
  const liquityPositionsAtEnd = enabledIds.includes("liquity")
    ? await readLiquityPositionsAtEnd({
        call,
        agents,
        blockNumber: toBlock,
        fairWeth: series[series.length - 1]?.fair.WETH ?? 0,
      })
    : [];

  // ---- per-tx notionals from receipts ----
  const fairAt = fairLookup(series);
  const notionals: Record<string, TxNotional> = {};
  const notionalsMeta = {
    source: "receipts" as const,
    txsSeen: 0,
    decoded: 0,
    receiptFailures: 0,
    unknownTokenTransfers: 0,
  };
  for (let b = fromBlock; b <= toBlock; b++) {
    let hashes: Hex[] = [];
    let senders = new Map<string, Address>();
    try {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(b),
        includeTransactions: true,
      });
      for (const tx of block.transactions) {
        hashes.push(tx.hash);
        senders.set(tx.hash.toLowerCase(), tx.from);
      }
    } catch {
      notionalsMeta.receiptFailures++;
      continue;
    }
    notionalsMeta.txsSeen += hashes.length;
    const fair = fairAt(b);
    await Promise.all(
      hashes.map(async (hash) => {
        let logs: Array<{
          address: Address;
          topics: readonly Hex[];
          data: Hex;
        }>;
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash });
          logs = receipt.logs as never;
        } catch {
          notionalsMeta.receiptFailures++;
          return;
        }
        const transfers: DecodedTransfer[] = [];
        for (const log of logs) {
          if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3)
            continue;
          transfers.push({
            token: log.address,
            from: `0x${log.topics[1].slice(26)}` as Address,
            to: `0x${log.topics[2].slice(26)}` as Address,
            value: BigInt(log.data === "0x" ? 0 : log.data),
          });
        }
        const sender = senders.get(hash.toLowerCase());
        if (!sender || transfers.length === 0) return;
        const notional = summarizeTransfers({
          sender,
          transfers,
          fair,
          onUnknownToken: () => {
            notionalsMeta.unknownTokenTransfers++;
          },
        });
        if (notional) {
          notionals[hash.toLowerCase()] = notional;
          notionalsMeta.decoded++;
        }
      }),
    );
  }

  return {
    source: "post-run-reconstruction",
    fromBlock,
    toBlock,
    granularityBlocks: scoreEvery,
    rows: series.length,
    failedReads,
    failedReadTargets: [...failedReadTargets.values()],
    elapsedMs: Date.now() - started,
    bases: baseTokens().map((t) => t.symbol),
    venues: [...new Set(ammMarkets.map((m) => m.venue))],
    series,
    gmxPositionsAtEnd,
    aaveAccountsAtEnd,
    lstPositionsAtEnd,
    liquityPositionsAtEnd,
    notionals,
    notionalsMeta,
  };
}

// Nearest-sample fair lookup for pricing notional legs when the series is thinned.
function fairLookup(
  series: MarketSeriesRow[],
): (block: number) => Record<string, number> {
  return (block) => {
    if (series.length === 0) return {};
    // The last sample at or before the block — never a later one: with a thinned series
    // (scoreEvery > 1) the nearest sample can sit in the tx's future, and across a crash edge
    // that prices the notional off information the tx could not have traded on.
    let best = series[0];
    for (const row of series) {
      if (row.block > block) break;
      best = row;
    }
    return best.fair;
  };
}

async function sampleBlock(opts: {
  call: (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ) => Promise<unknown[]>;
  blockNumber: number;
  priceFeed: Address;
  extraBases: string[];
  ammMarkets: AmmMarketLayout[];
  gmxMarkets: GmxMarketLayout[];
  aaveReserves: AaveReserveLayout[];
  stableMarkets: StableMarket[];
}): Promise<MarketSeriesRow | undefined> {
  const { call, blockNumber, priceFeed, extraBases } = opts;
  const batch = new ReadBatch();

  // fair prices
  const fairIdx = batch.push({
    address: priceFeed,
    abi: priceFeedAbi,
    functionName: "latestAnswer",
  });
  const extraFairIdx = extraBases.map((b) =>
    batch.push({
      address: priceFeed,
      abi: priceFeedAbi,
      functionName: "answerOf",
      args: [tokenInfo(b).address],
    }),
  );

  // AMM stage-0 reads
  type AmmIdx = {
    layout: AmmMarketLayout;
    priceIdx: number; // slot0 (uniswap) / sell probe (curve, balancer)
    depthIdx: number[]; // token balance reads (uniswap/curve) or getPoolTokens (balancer, single idx)
  };
  const ammIdx: AmmIdx[] = opts.ammMarkets.map((layout) => {
    const { venue, market } = layout;
    if (venue === "uniswap") {
      const pool = market.uniswap?.pool as Address;
      return {
        layout,
        priceIdx: batch.push({
          address: pool,
          abi: poolAbi,
          functionName: "slot0",
        }),
        depthIdx: [
          batch.push({
            address: layout.baseAddr,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [pool],
          }),
          batch.push({
            address: tokenInfo(market.quote).address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [pool],
          }),
        ],
      };
    }
    if (venue === "curve") {
      const leg = market.curve;
      if (!leg) return { layout, priceIdx: -1, depthIdx: [] };
      return {
        layout,
        priceIdx: batch.push({
          address: leg.pool,
          abi: curveTricryptoAbi,
          functionName: "get_dy",
          args: [BigInt(leg.baseIndex), BigInt(leg.quoteIndex), layout.probeDx],
        }),
        depthIdx: [
          batch.push({
            address: layout.baseAddr,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [leg.pool],
          }),
          batch.push({
            address: leg.stable,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [leg.pool],
          }),
        ],
      };
    }
    // balancer
    const leg = market.balancer;
    if (!leg) return { layout, priceIdx: -1, depthIdx: [] };
    return {
      layout,
      priceIdx: batch.push(
        balancerQuery(leg.poolId, layout.baseAddr, leg.stable, layout.probeDx),
      ),
      depthIdx: [
        batch.push({
          address: BALANCER.vault,
          abi: vaultAbi,
          functionName: "getPoolTokens",
          args: [leg.poolId],
        }),
      ],
    };
  });

  // GMX OI + funding
  const gmxIdx = opts.gmxMarkets.map((m) => ({
    market: m,
    oi: [
      gmxOpenInterestKey(m.marketToken, m.longToken, true),
      gmxOpenInterestKey(m.marketToken, m.shortToken, true),
      gmxOpenInterestKey(m.marketToken, m.longToken, false),
      gmxOpenInterestKey(m.marketToken, m.shortToken, false),
    ].map((key) =>
      batch.push({
        address: GMX.DataStore,
        abi: dataStoreReadAbi,
        functionName: "getUint",
        args: [key],
      }),
    ),
    funding: batch.push({
      address: GMX.DataStore,
      abi: dataStoreReadAbi,
      functionName: "getInt",
      args: [gmxSavedFundingKey(m.marketToken)],
    }),
  }));

  // Aave reserve totals
  const aaveIdx = opts.aaveReserves.map((r) => ({
    reserve: r,
    supplied: batch.push({
      address: r.aToken,
      abi: erc20Abi,
      functionName: "totalSupply",
    }),
    borrowed: batch.push({
      address: r.variableDebtToken,
      abi: erc20Abi,
      functionName: "totalSupply",
    }),
  }));

  // Market-priced stables: two fixed-notional probes per stable, in stableProbeReads' own order.
  // Indices are kept per read rather than as an offset into the batch, so the decode cannot drift
  // if anything is ever appended between here and it -- the same idiom the reads above use.
  const stableIdx = stableProbeReads(opts.stableMarkets).map((read) =>
    batch.push(read),
  );

  const stage0 = await call(batch.contracts, BigInt(blockNumber));

  // fair map — without a WETH fair the row is meaningless; skip it (reporting, not scoring).
  const answer = stage0[fairIdx];
  if (typeof answer !== "bigint") return undefined;
  const fair: Record<string, number> = {
    WETH: fromPriceFeedAnswer(answer),
  };
  extraBases.forEach((b, i) => {
    const raw = stage0[extraFairIdx[i]];
    if (typeof raw === "bigint") {
      const price = fromPriceFeedAnswer(raw);
      if (price > 0) fair[b] = price;
    }
  });
  if (!(fair.WETH > 0)) return undefined;

  // stage 1: buy-side probes sized from the sell probes (curve get_dy / balancer querySwap).
  const stage1Batch = new ReadBatch();
  const buyProbeIdx = new Map<number, number>(); // ammIdx position -> stage1 index
  ammIdx.forEach((entry, i) => {
    const { layout, priceIdx } = entry;
    if (priceIdx < 0) return;
    if (layout.venue === "curve") {
      const sellOut = stage0[priceIdx];
      const leg = layout.market.curve;
      if (typeof sellOut !== "bigint" || sellOut <= 0n || !leg) return;
      buyProbeIdx.set(
        i,
        stage1Batch.push({
          address: leg.pool,
          abi: curveTricryptoAbi,
          functionName: "get_dy",
          args: [BigInt(leg.quoteIndex), BigInt(leg.baseIndex), sellOut],
        }),
      );
    } else if (layout.venue === "balancer") {
      const sellOut = decodeQuerySwap(stage0[priceIdx]);
      const leg = layout.market.balancer;
      if (sellOut === undefined || sellOut <= 0n || !leg) return;
      buyProbeIdx.set(
        i,
        stage1Batch.push(
          balancerQuery(leg.poolId, leg.stable, layout.baseAddr, sellOut),
        ),
      );
    }
  });
  const stage1 =
    stage1Batch.contracts.length > 0
      ? await call(stage1Batch.contracts, BigInt(blockNumber))
      : [];

  // ---- decode ----
  const venues: NonNullable<MarketSeriesRow["venues"]> = {};
  ammIdx.forEach((entry, i) => {
    const { layout, priceIdx, depthIdx } = entry;
    if (priceIdx < 0) return;
    let sample: VenueQuoteSample | undefined;
    if (layout.venue === "uniswap") {
      const slot0 = stage0[priceIdx] as readonly [bigint] | undefined;
      if (slot0) {
        const mid = poolPriceFromSqrtX96(slot0[0], layout.market);
        const feeFrac = (layout.market.uniswap?.fee ?? 3000) / 1_000_000;
        if (mid > 0)
          sample = {
            mid,
            buy: mid / (1 - feeFrac),
            sell: mid * (1 - feeFrac),
          };
      }
      if (sample) {
        const baseBal = stage0[depthIdx[0]];
        const quoteBal = stage0[depthIdx[1]];
        if (typeof baseBal === "bigint" && typeof quoteBal === "bigint") {
          const baseUsd = tokenUsd(layout.baseAddr, baseBal, fair);
          const quoteUsd = Number(quoteBal) / 10 ** layout.quoteDec; // quote is the USDC-equivalent stable
          if (baseUsd !== undefined)
            sample.depthUsd = round2(baseUsd + quoteUsd);
        }
      }
    } else {
      // curve / balancer: sell probe + optional buy probe -> two-sided quote
      const sellRaw =
        layout.venue === "curve"
          ? (stage0[priceIdx] as bigint | undefined)
          : decodeQuerySwap(stage0[priceIdx]);
      if (typeof sellRaw === "bigint" && sellRaw > 0n) {
        const probeBaseFloat = Number(layout.probeDx) / 10 ** layout.baseDec;
        const sellQuoteFloat = Number(sellRaw) / 10 ** layout.quoteDec;
        const sellPx = sellQuoteFloat / probeBaseFloat;
        const buyIdx = buyProbeIdx.get(i);
        const buyRaw =
          buyIdx === undefined
            ? undefined
            : layout.venue === "curve"
              ? (stage1[buyIdx] as bigint | undefined)
              : decodeQuerySwap(stage1[buyIdx]);
        if (typeof buyRaw === "bigint" && buyRaw > 0n) {
          const buyBaseFloat = Number(buyRaw) / 10 ** layout.baseDec;
          const q = twoSidedQuote(sellPx, sellQuoteFloat / buyBaseFloat);
          sample = {
            mid: q.priceUsdcPerWeth,
            buy: q.buyPriceUsdcPerWeth,
            sell: q.sellPriceUsdcPerWeth,
          };
        } else if (sellPx > 0) {
          sample = { mid: sellPx, sell: sellPx };
        }
      }
      if (sample) {
        if (layout.venue === "curve") {
          const baseBal = stage0[depthIdx[0]];
          const quoteBal = stage0[depthIdx[1]];
          if (typeof baseBal === "bigint" && typeof quoteBal === "bigint") {
            const baseUsd = tokenUsd(layout.baseAddr, baseBal, fair);
            const quoteUsd = tokenUsd(
              layout.market.curve?.stable as Address,
              quoteBal,
              fair,
            );
            if (baseUsd !== undefined && quoteUsd !== undefined)
              sample.depthUsd = round2(baseUsd + quoteUsd);
          }
        } else {
          const poolTokens = stage0[depthIdx[0]] as
            | readonly [readonly Address[], readonly bigint[], bigint]
            | undefined;
          if (poolTokens) {
            let depth = 0;
            let priced = true;
            poolTokens[0].forEach((token, k) => {
              const usd = tokenUsd(token, poolTokens[1][k], fair);
              if (usd === undefined) priced = false;
              else depth += usd;
            });
            if (priced) sample.depthUsd = round2(depth);
          }
        }
      }
    }
    if (sample) {
      (venues[layout.venue] ??= {})[layout.base] = {
        ...sample,
        mid: round6(sample.mid),
        ...(sample.buy !== undefined ? { buy: round6(sample.buy) } : {}),
        ...(sample.sell !== undefined ? { sell: round6(sample.sell) } : {}),
      };
    }
  });

  const gmx: NonNullable<MarketSeriesRow["gmx"]> = {};
  for (const entry of gmxIdx) {
    const oi = entry.oi.map((idx) => stage0[idx]);
    if (oi.some((v) => typeof v !== "bigint")) continue;
    const [longA, longB, shortA, shortB] = oi as bigint[];
    const fundingRaw = stage0[entry.funding];
    // OI is stored in USD with 30 decimals; savedFundingFactorPerSecond is a per-second fraction
    // at 30 decimals (sign = longs pay shorts when positive). A failed funding read leaves the
    // field absent rather than printing 0.00bps — a zero here is not a measurement (issue #44's
    // discipline applies to reporting too).
    gmx[entry.market.base] = {
      longOiUsd: round2(Number(longA + longB) / 1e30),
      shortOiUsd: round2(Number(shortA + shortB) / 1e30),
      ...(typeof fundingRaw === "bigint"
        ? {
            fundingPerHourBps: round6(
              (Number(fundingRaw) / 1e30) * 3600 * 10_000,
            ),
          }
        : {}),
    };
  }

  const aave: NonNullable<MarketSeriesRow["aave"]> = {};
  for (const entry of aaveIdx) {
    const supplied = stage0[entry.supplied];
    const borrowed = stage0[entry.borrowed];
    if (typeof supplied !== "bigint" || typeof borrowed !== "bigint") continue;
    const suppliedUsd = tokenUsd(entry.reserve.asset, supplied, fair);
    const borrowedUsd = tokenUsd(entry.reserve.asset, borrowed, fair);
    if (suppliedUsd === undefined || borrowedUsd === undefined) continue;
    aave[entry.reserve.symbol] = {
      suppliedUsd: round2(suppliedUsd),
      borrowedUsd: round2(borrowedUsd),
      utilization: suppliedUsd > 0 ? round6(borrowedUsd / suppliedUsd) : 0,
    };
  }

  const stables: NonNullable<MarketSeriesRow["stables"]> = {};
  if (opts.stableMarkets.length > 0) {
    const prices = decodeStableProbes(
      opts.stableMarkets,
      stableIdx.map((i) => stage0[i]),
    );
    for (const quote of prices.quotes) {
      stables[quote.symbol] = {
        priceUsdc: round6(quote.priceUsdc),
        sellPriceUsdc: round6(quote.sellPriceUsdc),
        buyPriceUsdc: round6(quote.buyPriceUsdc),
        quoted: quote.quoted,
      };
    }
  }

  return {
    block: blockNumber,
    fair: Object.fromEntries(
      Object.entries(fair).map(([k, v]) => [k, round6(v)]),
    ),
    ...(Object.keys(venues).length > 0 ? { venues } : {}),
    ...(Object.keys(gmx).length > 0 ? { gmx } : {}),
    ...(Object.keys(aave).length > 0 ? { aave } : {}),
    ...(Object.keys(stables).length > 0 ? { stables } : {}),
  };
}

function balancerQuery(
  poolId: Hex,
  assetIn: Address,
  assetOut: Address,
  amount: bigint,
): MulticallContract {
  return {
    address: BALANCER.queries,
    abi: balancerQueriesAbi,
    functionName: "querySwap",
    args: [
      {
        poolId,
        kind: 0, // GIVEN_IN
        assetIn,
        assetOut,
        amount,
        userData: "0x" as Hex,
      },
      {
        sender: zeroAddress,
        fromInternalBalance: false,
        recipient: zeroAddress,
        toInternalBalance: false,
      },
    ],
  };
}

function decodeQuerySwap(result: unknown): bigint | undefined {
  return typeof result === "bigint" ? result : undefined;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// end-of-run per-agent venue state

type RawPosition = {
  addresses: { account: Address; market: Address; collateralToken: Address };
  numbers: {
    sizeInUsd: bigint;
    sizeInTokens: bigint;
    collateralAmount: bigint;
  };
  flags: { isLong: boolean };
};

async function readGmxPositionsAtEnd(opts: {
  call: (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ) => Promise<unknown[]>;
  agents: ReconstructionAgent[];
  gmxMarkets: GmxMarketLayout[];
  blockNumber: number;
  fair: Record<string, number>;
}): Promise<GmxPositionAtEnd[]> {
  if (opts.gmxMarkets.length === 0) return [];
  const reads = opts.agents.map((a) => ({
    address: GMX.Reader,
    abi: readerPositionsAbi,
    functionName: "getAccountPositions",
    args: [GMX.DataStore, a.address, 0n, 50n],
  }));
  const results = await opts.call(reads as never, BigInt(opts.blockNumber));
  const byMarket = new Map(
    opts.gmxMarkets.map((m) => [m.marketToken.toLowerCase(), m]),
  );
  const out: GmxPositionAtEnd[] = [];
  opts.agents.forEach((agent, i) => {
    const positions = results[i] as readonly RawPosition[] | undefined;
    if (!positions) return;
    for (const p of positions) {
      const market = byMarket.get(p.addresses.market.toLowerCase());
      if (!market || p.numbers.sizeInUsd <= 0n) continue;
      const sizeUsd = Number(p.numbers.sizeInUsd) / 1e30;
      const sizeTokens = Number(p.numbers.sizeInTokens) / 10 ** market.indexDec;
      const collateralInfo = tokenInfoByAddress(p.addresses.collateralToken);
      const collateralUnits = collateralInfo
        ? Number(p.numbers.collateralAmount) / 10 ** collateralInfo.decimals
        : 0;
      const collateralUsd = collateralInfo
        ? collateralInfo.kind === "stable"
          ? collateralUnits
          : collateralUnits * (opts.fair[collateralInfo.symbol] ?? 0)
        : 0;
      out.push({
        agent: agent.id,
        base: market.base,
        isLong: p.flags.isLong,
        sizeUsd: round2(sizeUsd),
        collateralUsd: round2(collateralUsd),
        entryPriceUsd: sizeTokens > 0 ? round6(sizeUsd / sizeTokens) : null,
      });
    }
  });
  return out;
}

async function readAaveAccountsAtEnd(opts: {
  call: (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ) => Promise<unknown[]>;
  agents: ReconstructionAgent[];
  blockNumber: number;
}): Promise<AaveAccountAtEnd[]> {
  const reads = opts.agents.map((a) => ({
    address: AAVE.Pool,
    abi: aavePoolAccountAbi,
    functionName: "getUserAccountData",
    args: [a.address],
  }));
  const results = await opts.call(reads as never, BigInt(opts.blockNumber));
  const out: AaveAccountAtEnd[] = [];
  opts.agents.forEach((agent, i) => {
    const r = results[i] as readonly bigint[] | undefined;
    if (!r) return;
    // totalCollateralBase / totalDebtBase are in the market's base currency (USD, 8 decimals).
    const collateralUsd = Number(r[0]) / 1e8;
    const debtUsd = Number(r[1]) / 1e8;
    if (collateralUsd <= 0 && debtUsd <= 0) return;
    // type(uint256).max = no debt.
    const hfRaw = r[5];
    const healthFactor =
      hfRaw >= 2n ** 128n ? null : round6(Number(hfRaw) / 1e18);
    out.push({
      agent: agent.id,
      collateralUsd: round2(collateralUsd),
      debtUsd: round2(debtUsd),
      healthFactor,
    });
  });
  return out;
}

// An agent's LST holding at the run's end (issue #38). One accountSummary read per agent gives the
// shares, their par value, and the withdrawal queue split into what has finalized and what has not —
// the two halves that make the discount a decision rather than free money.
async function readLstPositionsAtEnd(opts: {
  call: (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ) => Promise<unknown[]>;
  agents: ReconstructionAgent[];
  blockNumber: number;
}): Promise<LstPositionAtEnd[]> {
  const vault = LST?.vault;
  if (!vault) return [];
  const reads = opts.agents.map((a) => ({
    address: vault,
    abi: lstVaultAbi,
    functionName: "accountSummary",
    args: [a.address],
  }));
  const results = await opts.call(reads as never, BigInt(opts.blockNumber));
  const out: LstPositionAtEnd[] = [];
  opts.agents.forEach((agent, i) => {
    const r = results[i] as readonly bigint[] | undefined;
    if (!r) return;
    const [shares, shareAssets, pending, claimable, , openRequests] = r;
    if (shares <= 0n && pending <= 0n && claimable <= 0n) return;
    out.push({
      agent: agent.id,
      shares: round6(Number(shares) / 1e18),
      shareAssetsWeth: round6(Number(shareAssets) / 1e18),
      claimableWeth: round6(Number(claimable) / 1e18),
      pendingWeth: round6(Number(pending) / 1e18),
      openRequests: Number(openRequests),
    });
  });
  return out;
}

// An agent's CDP position at the run's end (issue #39): the Trove it owes on, the Stability Pool
// deposit that underwrites other people's liquidations, and the eUSD it is holding. The ICR needs
// the oracle price the venue itself would use, so it is read in a second stage off the first.
async function readLiquityPositionsAtEnd(opts: {
  call: (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ) => Promise<unknown[]>;
  agents: ReconstructionAgent[];
  blockNumber: number;
  /** WETH fair at the same block — the price the ICR is expressed against. */
  fairWeth: number;
}): Promise<LiquityPositionAtEnd[]> {
  const liquity = LIQUITY;
  if (!liquity) return [];
  const batch = new ReadBatch();
  const idx = opts.agents.map((a) => ({
    agent: a,
    trove: batch.push({
      address: liquity.troveManager,
      abi: troveManagerAbi,
      functionName: "getEntireDebtAndColl",
      args: [a.address],
    }),
    deposit: batch.push({
      address: liquity.stabilityPool,
      abi: stabilityPoolAbi,
      functionName: "getCompoundedLUSDDeposit",
      args: [a.address],
    }),
    balance: batch.push({
      address: liquity.eusd,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [a.address],
    }),
  }));
  const results = await opts.call(batch.contracts, BigInt(opts.blockNumber));

  const out: LiquityPositionAtEnd[] = [];
  for (const entry of idx) {
    const trove = results[entry.trove] as readonly bigint[] | undefined;
    const deposit = results[entry.deposit];
    const balance = results[entry.balance];
    const debt = trove ? Number(trove[0]) / 1e18 : 0;
    const coll = trove ? Number(trove[1]) / 1e18 : 0;
    const depositEusd =
      typeof deposit === "bigint" ? Number(deposit) / 1e18 : 0;
    const eusd = typeof balance === "bigint" ? Number(balance) / 1e18 : 0;
    if (debt <= 0 && coll <= 0 && depositEusd <= 0 && eusd <= 0) continue;
    out.push({
      agent: entry.agent.id,
      troveDebtEusd: round6(debt),
      troveCollWeth: round6(coll),
      // Derived rather than read: getCurrentICR wants the oracle price as an argument, and the fair
      // this row already carries is the same number the environment writes to that oracle.
      icr: debt > 0 ? round6((coll * opts.fairWeth) / debt) : null,
      stabilityDepositEusd: round6(depositEusd),
      eusdBalance: round6(eusd),
    });
  }
  return out;
}
