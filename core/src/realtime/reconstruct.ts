// Post-run per-agent value series reconstruction (ADR 0006 §4).
//
// In place of scoring reads removed from the realtime loop, right after the run ends (before resetFork
// erases history) it walks back over the historical block state anvil retains via blockNumber-specified
// Multicall3 batch reads, and reconstructs "each agent's total value (spot + protocol positions)" at each
// block cross-section.
//   - Because all agents are read at the same block cross-section, the IR point correspondence is not muddied
//   - A metric hack synced to the snapshot phase is impossible in principle
// The output is observation-shaped events into events.jsonl (inventory.valueUsdc = total value).
// readPerRoundValues (evaluate / gate / discrimination) can read it without modification.
//
// ADR 0013: also scores extra bases' (WBTC etc.) spot balances and LP. Under the fork default (base=WETH
// only), there are no extra reads and it matches the prior behavior exactly (byte-compatible).
import type { Address, PublicClient } from "viem";
import { parseAbi, parseAbiItem } from "viem";
import {
  balancerVaultAbi,
  curveTricryptoAbi,
  erc20Abi,
  poolAbi,
  uniswapV3FactoryAbi,
} from "@eris/sdk/abis.js";
import {
  AAVE,
  BALANCER,
  MULTICALL3,
  TOKENS,
  UNISWAP,
} from "@eris/sdk/constants.js";
import {
  baseTokens,
  marketsFor,
  tokenInfo,
  tokenRegistry,
} from "@eris/sdk/markets.js";
import type { RunLogger } from "../logger.js";
import { valueUsdc } from "@eris/sdk/pnl.js";
import { type PoolReserves, poolShareValueUsdc } from "@eris/sdk/valuation.js";
import { aavePoolAbi } from "@eris/sdk/protocols/aave.js";
import { balancerPools } from "@eris/sdk/protocols/balancer.js";
import { resolveCurvePools } from "@eris/sdk/protocols/curve.js";
import {
  gmxAccountPositionsCall,
  gmxEthUsdPositionValueUsd,
} from "@eris/sdk/protocols/gmx.js";
import {
  type PoolFeeGrowth,
  lpPositionValuation,
  lpPositionValueUsdcMulti,
  poolPriceUsdcPerWethFromSqrtX96,
  positionPoolKey,
  registeredPoolFor,
  tickFeeGrowthEntry,
  uniswapFactory,
} from "@eris/sdk/protocols/uniswap.js";
import type { ProtocolId } from "@eris/sdk/types.js";
import { fromPriceFeedAnswer, priceFeedAbi } from "./priceFeed.js";

// Measured upper bound of anvil's historical state retention depth (~1,050; ADR 0006 Risks). Warn if likely to exceed it.
const HISTORY_DEPTH_LIMIT = 1000;

const multicall3Abi = parseAbi([
  "function getEthBalance(address addr) view returns (uint256)",
]);
const npmAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

export type ReconstructionAgent = { id: string; address: Address };

export type ReconstructionMeta = {
  source: "post-run-reconstruction";
  granularityBlocks: 1;
  fromBlock: number;
  toBlock: number;
  blocks: number;
  failedReads: number;
  elapsedMs: number;
  // The fixed reference fair used for α evaluation (USDC/WETH; the fair at run end).
  alphaRefFairUsdcPerWeth: number;
  // agent -> α (= value at the fixed reference fair, toBlock − fromBlock; β-removed trade-derived PnL).
  alphaByAgent: Record<string, number>;
  // Holdings excluded from the value series because they could not be priced (issue #41).
  unpricedHoldings: UnpricedHolding[];
};

type MulticallContract = {
  address: Address;
  // biome-ignore lint/suspicious/noExplicitAny: mixing heterogeneous ABIs into a single multicall
  abi: any;
  functionName: string;
  args?: readonly unknown[];
};

// Number of cross-section multicall reads per agent (for index computation).
function perAgentReads(opts: {
  extraBaseCount: number;
  activeStables: Address[];
  lpTokenCount: number;
  hasUniswap: boolean;
  hasAave: boolean;
  hasGmx: boolean;
}): number {
  return (
    1 + // ETH
    1 + // WETH
    opts.extraBaseCount + // extra base balances (WBTC etc.)
    opts.activeStables.length +
    opts.lpTokenCount + // balancer BPT / curve LP balances (issue #41)
    (opts.hasAave ? 1 : 0) +
    (opts.hasGmx ? 1 : 0) +
    (opts.hasUniswap ? 1 : 0) // LP NFT balanceOf
  );
}

// Total value of all agents at one block cross-section (spot + LP + aave + gmx).
// A single cross-section reader so that post-run reconstruction (reconstructValueSeries) and the dashboard's
// valuePoller share the same value computation (ADR 0008 P0). With blockNumber it can read either a historical
// or current cross-section. It does not emit observations (that is the caller's responsibility).
// valueUsdc = total value at live fair (β-inclusive mark-to-market).
// alphaValueUsdc = value of free inventory (eth/weth/extra base) evaluated at "the reference fair fixed within
//   the run" (+ protocol positions are marked at live fair; the same approximation as ADR 0002-family
//   attribution). Because it evaluates at the fixed reference, price drift (β) on held inventory cancels between
//   the two cross-sections, and only the portion where a trade "executed at a favorable/unfavorable price versus
//   fair" = α remains (equivalent to the amm-challenge fair-price-at-execution edge; ADR 0015 Notes). If
//   refFairByBase is unspecified, alphaValueUsdc = valueUsdc (backward compatible).
export type AgentValueSnapshot = {
  id: string;
  valueUsdc: number;
  alphaValueUsdc: number;
};

// A holding excluded from an agent's value (issue #41), either because the scorer cannot price it or
// because nothing sums it. Either way a zero in summary.json is indistinguishable from a trading
// loss, so the exclusion is reported instead of being applied silently.
export type UnpricedHolding = {
  agentId: string;
  // Where the holding came from, e.g. "uniswap-lp:<tokenId>" / "balancer-bpt" / "erc20-unaccounted".
  source: string;
  token: Address;
  // Raw token amount, or "" when even the amount could not be derived.
  amountRaw: string;
};

export type ValueSnapshot = {
  blockNumber: number;
  fairPriceUsdcPerWeth: number;
  // Pool price (from slot0) only when Uniswap is enabled. null if disabled.
  poolPriceUsdcPerWeth: number | null;
  failedReads: number;
  values: AgentValueSnapshot[];
  unpriced: UnpricedHolding[];
};

export async function readValueSnapshotAtBlock(opts: {
  publicClient: PublicClient;
  agents: ReconstructionAgent[];
  enabledIds: ProtocolId[];
  activeStables: Address[];
  priceFeed: Address;
  blockNumber: number;
  // Fixed reference fair for α evaluation (base symbol -> USD). If unspecified, α = total value.
  refFairByBase?: Record<string, number>;
}): Promise<ValueSnapshot> {
  const { publicClient, agents, enabledIds, activeStables, priceFeed } = opts;
  const hasUniswap = enabledIds.includes("uniswap");
  const hasAave = enabledIds.includes("aave");
  const hasGmx = enabledIds.includes("gmx");
  let failedReads = 0;

  const call = async (
    contracts: MulticallContract[],
    blockNumber: bigint,
  ): Promise<unknown[]> => {
    const results = (await publicClient.multicall({
      contracts: contracts as never,
      blockNumber,
      multicallAddress: MULTICALL3,
      allowFailure: true,
    })) as Array<{ status: "success" | "failure"; result?: unknown }>;
    return results.map((r) => {
      if (r.status === "failure") {
        failedReads++;
        return undefined;
      }
      return r.result;
    });
  };

  // ADR 0013: extra bases (other than WETH) and all uniswap markets. Under the fork default, empty / WETH only.
  const extraBases = baseTokens()
    .map((t) => t.symbol)
    .filter((s) => s !== "WETH");
  const uniMarkets = hasUniswap ? marketsFor("uniswap") : [];
  // Issue #41: balancer BPT / curve LP holdings. Reserves and supply are shared reads (head), the
  // per-agent balance rides in the existing per-agent group, so no extra round trip is added.
  const lpVenues = await lpTokenVenues(publicClient, enabledIds);

  const perAgent = perAgentReads({
    extraBaseCount: extraBases.length,
    activeStables,
    lpTokenCount: lpVenues.length,
    hasUniswap,
    hasAave,
    hasGmx,
  });

  const blockNumber = BigInt(opts.blockNumber);
  // head: [WETH price (latestAnswer), extra base prices (answerOf)…, uniswap per-market slot0…]
  const head: MulticallContract[] = [
    {
      address: priceFeed,
      abi: priceFeedAbi,
      functionName: "latestAnswer",
    },
  ];
  for (const b of extraBases) {
    head.push({
      address: priceFeed,
      abi: priceFeedAbi,
      functionName: "answerOf",
      args: [tokenInfo(b).address],
    });
  }
  const uniHeadBase = head.length; // start index of the uniswap slot0 group
  for (const m of uniMarkets) {
    head.push({
      address: m.uniswap!.pool,
      abi: poolAbi,
      functionName: "slot0",
    });
  }
  const lpHeadBase = head.length; // start index of the LP-token reserve group
  for (const venue of lpVenues) head.push(...venue.reserveReads);

  const contracts: MulticallContract[] = [...head];
  for (const agent of agents) {
    contracts.push(
      {
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: "getEthBalance",
        args: [agent.address],
      },
      {
        address: TOKENS.WETH.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [agent.address],
      },
      ...extraBases.map((b) => ({
        address: tokenInfo(b).address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [agent.address],
      })),
      ...activeStables.map((token) => ({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [agent.address],
      })),
      ...lpVenues.map((venue) => ({
        address: venue.lpToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [agent.address],
      })),
    );
    if (hasAave) {
      contracts.push({
        address: AAVE.Pool,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [agent.address],
      });
    }
    if (hasGmx) contracts.push(gmxAccountPositionsCall(agent.address));
    if (hasUniswap) {
      contracts.push({
        address: UNISWAP.nonfungiblePositionManager,
        abi: npmAbi,
        functionName: "balanceOf",
        args: [agent.address],
      });
    }
  }

  const results = await call(contracts, blockNumber);
  const fairPrice = fromPriceFeedAnswer((results[0] as bigint) ?? 0n);
  // USD prices of all bases (WETH=latestAnswer, extra base=answerOf).
  const fairByBase: Record<string, number> = { WETH: fairPrice };
  extraBases.forEach((b, i) => {
    fairByBase[b] = fromPriceFeedAnswer((results[1 + i] as bigint) ?? 0n);
  });

  // tick of each uniswap market (for LP scoring). Backward-compatible poolPrice from the WETH market's slot0.
  const tickByPool: Record<string, number> = {};
  let poolPriceUsdcPerWeth: number | null = null;
  uniMarkets.forEach((m, i) => {
    const s = results[uniHeadBase + i] as readonly [bigint, number] | undefined;
    if (!s) return;
    tickByPool[m.uniswap!.pool.toLowerCase()] = Number(s[1]);
    if (m.base === "WETH") {
      poolPriceUsdcPerWeth = poolPriceUsdcPerWethFromSqrtX96(s[0]);
    }
  });

  // Reserves behind each balancer/curve LP token (issue #41). A venue whose reserves could not be
  // read decodes to undefined, which makes any holding of it reported rather than valued.
  let lpCursor = lpHeadBase;
  const lpReserves = lpVenues.map((venue) => {
    const slice = results.slice(lpCursor, lpCursor + venue.reserveReads.length);
    lpCursor += venue.reserveReads.length;
    return venue.decode(slice);
  });

  // LP enumeration (2nd/3rd stage multicall): for agents holding an NFT, look up tokenId → positions
  const lpValueByAgent = new Map<string, number>();
  const unpriced: UnpricedHolding[] = [];
  if (hasUniswap) {
    const owners: Array<{ agent: ReconstructionAgent; index: bigint }> = [];
    agents.forEach((agent, i) => {
      const base = head.length + i * perAgent;
      const nftCount = (results[base + perAgent - 1] as bigint) ?? 0n;
      for (let k = 0n; k < nftCount; k++) owners.push({ agent, index: k });
    });
    if (owners.length > 0) {
      const tokenIds = await call(
        owners.map(({ agent, index }) => ({
          address: UNISWAP.nonfungiblePositionManager,
          abi: npmAbi,
          functionName: "tokenOfOwnerByIndex",
          args: [agent.address, index],
        })),
        blockNumber,
      );
      const positions = await call(
        tokenIds.map((tokenId) => ({
          address: UNISWAP.nonfungiblePositionManager,
          abi: npmAbi,
          functionName: "positions",
          args: [tokenId ?? 0n],
        })),
        blockNumber,
      );
      // Issue #41: a position may sit in a pool outside MARKET_LEGS (another fee tier, an
      // unregistered pair). Resolve those through the factory and read their tick, so they are
      // valued rather than scored as a total loss. No extra reads when there are none.
      const poolByKey = await resolveUnregisteredPools({
        publicClient,
        positions,
        call,
        blockNumber,
        tickByPool,
      });
      // Issue #21: fees earned since a position's last checkpoint stay in the pool until
      // poke/collect, so valuing liquidity + tokensOwed alone hides fee income. One extra
      // cross-section read per block covers every boundary the owned positions touch.
      const feeGrowthByPool = await readFeeGrowthForPositions(
        positions,
        poolByKey,
        call,
        blockNumber,
      );
      owners.forEach(({ agent }, j) => {
        const pos = positions[j];
        if (!pos || tokenIds[j] === undefined) return;
        const valuation = lpPositionValuation(pos as PositionTuple, {
          tickByPool,
          fairByBase,
          poolByKey,
          feeGrowthByPool,
        });
        for (const holding of valuation.unpriced) {
          unpriced.push({
            agentId: agent.id,
            source: `uniswap-lp:${tokenIds[j]}`,
            token: holding.token,
            amountRaw: holding.amountRaw,
          });
        }
        lpValueByAgent.set(
          agent.id,
          (lpValueByAgent.get(agent.id) ?? 0) + valuation.valueUsdc,
        );
      });
    }
  }

  // α evaluation values free base inventory at the fixed reference fair (if unspecified, same as live fair = α=total value).
  const refFairByBase = opts.refFairByBase ?? fairByBase;
  const values: AgentValueSnapshot[] = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    let idx = head.length + i * perAgent;
    const ethWei = (results[idx++] as bigint) ?? 0n;
    const wethWei = (results[idx++] as bigint) ?? 0n;
    const bases: Record<string, bigint> = { WETH: wethWei };
    for (const b of extraBases) bases[b] = (results[idx++] as bigint) ?? 0n;
    let usdcUnits = 0n;
    for (let s = 0; s < activeStables.length; s++) {
      usdcUnits += (results[idx++] as bigint) ?? 0n;
    }
    // Issue #41: balancer BPT / curve LP holdings, valued as the proportional share of the pool's
    // reserves. Marked live in both evaluations, like the other protocol positions.
    let lpTokenUsd = 0;
    lpVenues.forEach((venue, v) => {
      const lpBalance = (results[idx++] as bigint) ?? 0n;
      if (lpBalance <= 0n) return;
      const reserves = lpReserves[v];
      if (!reserves) {
        unpriced.push({
          agentId: agent.id,
          source: venue.source,
          token: venue.lpToken,
          amountRaw: lpBalance.toString(),
        });
        return;
      }
      const share = poolShareValueUsdc(reserves, lpBalance, fairByBase);
      lpTokenUsd += share.valueUsdc;
      for (const holding of share.unpriced) {
        unpriced.push({ agentId: agent.id, source: venue.source, ...holding });
      }
    });
    const balance = { ethWei, wethWei, usdcUnits, bases };
    // Evaluate free inventory two ways: at live fair (β-inclusive) and at the fixed reference fair (β-removed).
    let total = valueUsdc(balance, fairByBase) + lpTokenUsd;
    let alphaTotal = valueUsdc(balance, refFairByBase) + lpTokenUsd;
    if (hasAave) {
      const account = results[idx++] as readonly bigint[] | undefined;
      // aave collateral − debt is USD 8-decimals. The position is a live mark in both evaluations (β removal applies to free inventory only).
      const aaveUsd = account ? Number(account[0] - account[1]) / 1e8 : 0;
      total += aaveUsd;
      alphaTotal += aaveUsd;
    }
    if (hasGmx) {
      const positions = results[idx++] as
        Parameters<typeof gmxEthUsdPositionValueUsd>[0] | undefined;
      const gmxUsd = gmxEthUsdPositionValueUsd(positions, fairPrice);
      total += gmxUsd;
      alphaTotal += gmxUsd;
    }
    const lpUsd = lpValueByAgent.get(agent.id) ?? 0;
    total += lpUsd;
    alphaTotal += lpUsd;
    values.push({ id: agent.id, valueUsdc: total, alphaValueUsdc: alphaTotal });
  }

  return {
    blockNumber: opts.blockNumber,
    fairPriceUsdcPerWeth: fairPrice,
    poolPriceUsdcPerWeth,
    failedReads,
    values,
    unpriced,
  };
}

// An LP token an agent can hold (balancer BPT / curve LP). reserveReads go into the shared head of
// the cross-section multicall and decode() turns that slice into the pool's reserves, so valuing the
// holding costs one extra entry per agent and no extra round trip.
type LpTokenVenue = {
  lpToken: Address;
  // Recorded on unpriced holdings, e.g. "balancer-bpt" / "curve-lp".
  source: string;
  reserveReads: MulticallContract[];
  decode: (slice: unknown[]) => PoolReserves | undefined;
};

async function lpTokenVenues(
  publicClient: PublicClient,
  enabledIds: ProtocolId[],
): Promise<LpTokenVenue[]> {
  const venues: LpTokenVenue[] = [];
  if (enabledIds.includes("balancer")) {
    for (const { poolId, bpt } of balancerPools()) {
      venues.push({
        lpToken: bpt,
        source: "balancer-bpt",
        reserveReads: [
          {
            address: BALANCER.vault,
            abi: balancerVaultAbi,
            functionName: "getPoolTokens",
            args: [poolId],
          },
          { address: bpt, abi: erc20Abi, functionName: "totalSupply" },
        ],
        decode: ([poolTokens, totalSupply]) => {
          const pt = poolTokens as
            | readonly [readonly Address[], readonly bigint[], bigint]
            | undefined;
          if (!pt || typeof totalSupply !== "bigint") return undefined;
          return {
            tokens: [...pt[0]],
            balances: [...pt[1]],
            totalSupply,
          };
        },
      });
    }
  }
  if (enabledIds.includes("curve")) {
    for (const shape of await resolveCurvePools(publicClient)) {
      const coinCount = shape.coins.length;
      venues.push({
        lpToken: shape.lpToken,
        source: "curve-lp",
        reserveReads: [
          ...shape.coins.map((_, i) => ({
            address: shape.pool,
            abi: curveTricryptoAbi,
            functionName: "balances",
            args: [BigInt(i)],
          })),
          {
            address: shape.lpToken,
            abi: erc20Abi,
            functionName: "totalSupply",
          },
        ],
        decode: (slice) => {
          const totalSupply = slice[coinCount];
          if (typeof totalSupply !== "bigint") return undefined;
          const balances = slice.slice(0, coinCount);
          if (balances.some((b) => typeof b !== "bigint")) return undefined;
          return {
            tokens: shape.coins,
            balances: balances as bigint[],
            totalSupply,
          };
        },
      });
    }
  }
  return venues;
}

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const aaveDataProviderAbi = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);

// a/stableDebt/variableDebt token addresses for every registry asset. Cached: they are immutable for
// a deployment. Reserves that are not listed simply fail their read and are skipped.
let aaveReserveTokenCache: Address[] | undefined;
async function aaveReserveTokens(
  publicClient: PublicClient,
): Promise<Address[]> {
  if (aaveReserveTokenCache) return aaveReserveTokenCache;
  const assets = Object.values(tokenRegistry()).map((t) => t.address);
  const results = (await publicClient.multicall({
    contracts: assets.map((asset) => ({
      address: AAVE.PoolDataProvider,
      abi: aaveDataProviderAbi,
      functionName: "getReserveTokensAddresses",
      args: [asset],
    })) as never,
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  const out: Address[] = [];
  for (const r of results) {
    if (r.status !== "success") continue;
    for (const token of r.result as readonly Address[]) out.push(token);
  }
  aaveReserveTokenCache = out;
  return out;
}

// Tokens an agent received during the run that nothing in the value computation sums (issue #41).
//
// ERC-20 balances cannot be enumerated, so discovery goes through Transfer logs over the run window
// -- once per agent, not per block. Holdings acquired before fromBlock are out of scope, which is
// safe because setup funding only ever uses registry tokens. Reporting is deliberately all this
// does: pricing an arbitrary token would mean extending the registry, and scoring it at zero is the
// bug being fixed.
export async function findUnaccountedTokens(opts: {
  publicClient: PublicClient;
  agents: ReconstructionAgent[];
  enabledIds: ProtocolId[];
  activeStables: Address[];
  fromBlock: number;
  toBlock: number;
}): Promise<UnpricedHolding[]> {
  const { publicClient, agents, fromBlock, toBlock } = opts;
  const accounted = new Set<string>();
  for (const t of baseTokens()) accounted.add(t.address.toLowerCase());
  for (const s of opts.activeStables) accounted.add(s.toLowerCase());
  for (const v of await lpTokenVenues(publicClient, opts.enabledIds))
    accounted.add(v.lpToken.toLowerCase());
  // ERC-721; already valued through the position enumeration.
  accounted.add(UNISWAP.nonfungiblePositionManager.toLowerCase());
  // Aave a/debt tokens are minted to the agent on supply/borrow but their value already arrives
  // through getUserAccountData's aggregate. Flagging them would be a false positive.
  if (opts.enabledIds.includes("aave")) {
    for (const t of await aaveReserveTokens(publicClient))
      accounted.add(t.toLowerCase());
  }

  const pairs: Array<{ agent: ReconstructionAgent; token: Address }> = [];
  for (const agent of agents) {
    let logs: Awaited<ReturnType<typeof publicClient.getLogs>>;
    try {
      logs = await publicClient.getLogs({
        event: transferEvent,
        args: { to: agent.address },
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
        strict: false,
      });
    } catch {
      continue; // discovery is best-effort; never fail a run's scoring over it
    }
    const seen = new Set<string>();
    for (const log of logs) {
      // ERC-721 shares this topic0 but indexes tokenId as well, giving four topics.
      if (log.topics.length !== 3) continue;
      const token = log.address.toLowerCase();
      if (accounted.has(token) || seen.has(token)) continue;
      seen.add(token);
      pairs.push({ agent, token: log.address });
    }
  }
  if (pairs.length === 0) return [];

  const balances = (await publicClient.multicall({
    contracts: pairs.map(({ agent, token }) => ({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [agent.address],
    })) as never,
    blockNumber: BigInt(toBlock),
    multicallAddress: MULTICALL3,
    allowFailure: true,
  })) as Array<{ status: "success" | "failure"; result?: unknown }>;

  const out: UnpricedHolding[] = [];
  pairs.forEach(({ agent, token }, i) => {
    const balance = balances[i];
    if (balance.status !== "success") return;
    const amount = balance.result as bigint;
    if (amount <= 0n) return;
    out.push({
      agentId: agent.id,
      source: "erc20-unaccounted",
      token,
      amountRaw: amount.toString(),
    });
  });
  return out;
}

type PositionTuple = Parameters<typeof lpPositionValueUsdcMulti>[0];
type MulticallFn = (
  contracts: MulticallContract[],
  blockNumber: bigint,
) => Promise<unknown[]>;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Resolve the pools of positions that are not in MARKET_LEGS (issue #41) and record their ticks in
// tickByPool, so the scorer values them instead of returning zero. Costs two extra round trips only
// when such a position exists; a run where every position is in a registered market pays nothing.
async function resolveUnregisteredPools(opts: {
  publicClient: PublicClient;
  positions: unknown[];
  call: MulticallFn;
  blockNumber: bigint;
  tickByPool: Record<string, number>;
}): Promise<Record<string, Address>> {
  const wanted = new Map<
    string,
    { token0: Address; token1: Address; fee: number }
  >();
  for (const raw of opts.positions) {
    if (!raw) continue;
    const [, , token0, token1, fee] = raw as PositionTuple;
    if (registeredPoolFor(token0, token1, fee)) continue;
    wanted.set(positionPoolKey(token0, token1, fee), { token0, token1, fee });
  }
  if (wanted.size === 0) return {};
  const factory = await uniswapFactory(opts.publicClient);
  if (!factory) return {};

  const keys = [...wanted.keys()];
  const addresses = await opts.call(
    keys.map((k) => {
      const { token0, token1, fee } = wanted.get(k) as {
        token0: Address;
        token1: Address;
        fee: number;
      };
      return {
        address: factory,
        abi: uniswapV3FactoryAbi,
        functionName: "getPool",
        args: [token0, token1, fee],
      };
    }),
    opts.blockNumber,
  );

  const poolByKey: Record<string, Address> = {};
  const discovered: Address[] = [];
  keys.forEach((k, i) => {
    const pool = addresses[i] as Address | undefined;
    if (!pool || pool.toLowerCase() === ZERO_ADDRESS) return;
    poolByKey[k] = pool;
    discovered.push(pool);
  });
  if (discovered.length === 0) return poolByKey;

  const slots = await opts.call(
    discovered.map((pool) => ({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    })),
    opts.blockNumber,
  );
  discovered.forEach((pool, i) => {
    const slot0 = slots[i] as readonly [bigint, number] | undefined;
    if (slot0) opts.tickByPool[pool.toLowerCase()] = Number(slot0[1]);
  });
  return poolByKey;
}

// Fee-growth cross-section for the pools the given positions sit in (issue #21). Batched into a
// single extra multicall: two globals per pool plus one ticks() per distinct boundary. Pools whose
// reads fail are simply absent, which suppresses their fee term instead of marking a wrong number.
async function readFeeGrowthForPositions(
  positions: unknown[],
  poolByKey: Record<string, Address>,
  call: MulticallFn,
  blockNumber: bigint,
): Promise<Record<string, PoolFeeGrowth>> {
  const pools = new Map<string, { address: Address; ticks: number[] }>();
  for (const raw of positions) {
    if (!raw) continue;
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] =
      raw as PositionTuple;
    if (liquidity <= 0n) continue;
    const pool =
      registeredPoolFor(token0, token1, fee) ??
      poolByKey[positionPoolKey(token0, token1, fee)];
    if (!pool) continue;
    const key = pool.toLowerCase();
    const entry = pools.get(key) ?? { address: pool, ticks: [] };
    for (const t of [tickLower, tickUpper])
      if (!entry.ticks.includes(t)) entry.ticks.push(t);
    pools.set(key, entry);
  }
  if (pools.size === 0) return {};

  const contracts: MulticallContract[] = [];
  const layout: Array<{ key: string; ticks: number[]; base: number }> = [];
  for (const [key, { address, ticks }] of pools) {
    layout.push({ key, ticks, base: contracts.length });
    contracts.push(
      { address, abi: poolAbi, functionName: "feeGrowthGlobal0X128" },
      { address, abi: poolAbi, functionName: "feeGrowthGlobal1X128" },
      ...ticks.map((t) => ({
        address,
        abi: poolAbi,
        functionName: "ticks",
        args: [t],
      })),
    );
  }
  const results = await call(contracts, blockNumber);

  const out: Record<string, PoolFeeGrowth> = {};
  for (const { key, ticks, base } of layout) {
    const global0 = results[base] as bigint | undefined;
    const global1 = results[base + 1] as bigint | undefined;
    if (global0 === undefined || global1 === undefined) continue;
    const outsideByTick: Record<number, readonly [bigint, bigint]> = {};
    ticks.forEach((t, i) => {
      const entry = tickFeeGrowthEntry(
        results[base + 2 + i] as Parameters<typeof tickFeeGrowthEntry>[0],
      );
      if (entry) outsideByTick[t] = entry;
    });
    out[key] = {
      feeGrowthGlobal0X128: global0,
      feeGrowthGlobal1X128: global1,
      outsideByTick,
    };
  }
  return out;
}

export async function reconstructValueSeries(opts: {
  publicClient: PublicClient;
  logger: RunLogger;
  agents: ReconstructionAgent[];
  enabledIds: ProtocolId[];
  activeStables: Address[];
  priceFeed: Address;
  fromBlock: number;
  toBlock: number;
}): Promise<ReconstructionMeta> {
  const {
    publicClient,
    logger,
    agents,
    enabledIds,
    activeStables,
    priceFeed,
    fromBlock,
    toBlock,
  } = opts;
  const started = Date.now();
  let failedReads = 0;

  if (toBlock - fromBlock > HISTORY_DEPTH_LIMIT) {
    console.warn(
      `[reconstruct] run window ${toBlock - fromBlock} blocks exceeds anvil history depth ~${HISTORY_DEPTH_LIMIT}; ` +
        "reads of old blocks may be missing (switch long runs to chunked reconstruction; ADR 0006 §4)",
    );
  }

  // The fixed reference fair for α uses the fair at run end (toBlock) across all bases. Read toBlock first,
  // set that fairByBase as the reference, then evaluate fromBlock..toBlock (removing β across the whole run).
  const refSnapshot = await readValueSnapshotAtBlock({
    publicClient,
    agents,
    enabledIds,
    activeStables,
    priceFeed,
    blockNumber: toBlock,
  });
  failedReads += refSnapshot.failedReads;
  const refFairByBase: Record<string, number> = { WETH: 0 };
  for (const b of baseTokens().map((t) => t.symbol)) {
    refFairByBase[b] = await readFairForRef(
      publicClient,
      priceFeed,
      b,
      toBlock,
    );
  }

  const alphaFirst = new Map<string, number>();
  const alphaLast = new Map<string, number>();
  // Issue #41: holdings the scorer could not price. Deduplicated across the run window (they persist
  // block to block) and emitted once at the end, so a zero in summary.json is never mistaken for a
  // trading loss. Keyed by agent + source + token; amountRaw is the last one seen.
  const unpriced = new Map<string, UnpricedHolding>();
  for (let b = fromBlock; b <= toBlock; b++) {
    const snapshot = await readValueSnapshotAtBlock({
      publicClient,
      agents,
      enabledIds,
      activeStables,
      priceFeed,
      blockNumber: b,
      refFairByBase,
    });
    failedReads += snapshot.failedReads;
    for (const h of snapshot.unpriced) {
      unpriced.set(`${h.agentId}|${h.source}|${h.token.toLowerCase()}`, h);
    }
    for (const { id, valueUsdc: total, alphaValueUsdc } of snapshot.values) {
      if (!alphaFirst.has(id)) alphaFirst.set(id, alphaValueUsdc);
      alphaLast.set(id, alphaValueUsdc);
      // The observation shape readPerRoundValues reads (inventory.valueUsdc = total value).
      // Do not include protocols (avoids double-counting perRoundValueUsdc). alphaValueUsdc is
      // the fixed-reference fair evaluation (β-removed) and can also be read as a per-round α series.
      logger.event({
        type: "observation",
        agentId: id,
        observation: {
          reconstructed: true,
          round: b,
          blockNumber: String(b),
          fairPriceUsdcPerWeth: snapshot.fairPriceUsdcPerWeth,
          // Also record the pool price (when uniswap is enabled; used for post-run analysis of fair tracking = residual gap).
          ...(snapshot.poolPriceUsdcPerWeth !== null
            ? { poolPriceUsdcPerWeth: snapshot.poolPriceUsdcPerWeth }
            : {}),
          inventory: { valueUsdc: total, alphaValueUsdc },
        },
      });
    }
  }

  const alphaByAgent: Record<string, number> = {};
  for (const { id } of agents)
    alphaByAgent[id] = (alphaLast.get(id) ?? 0) - (alphaFirst.get(id) ?? 0);

  // Issue #41: tokens outside the accounted set are invisible to the per-block cross-section (they
  // cannot be enumerated), so they are discovered once from the run window's Transfer logs.
  for (const holding of await findUnaccountedTokens({
    publicClient,
    agents,
    enabledIds,
    activeStables,
    fromBlock,
    toBlock,
  })) {
    unpriced.set(
      `${holding.agentId}|${holding.source}|${holding.token.toLowerCase()}`,
      holding,
    );
  }

  const unpricedHoldings = [...unpriced.values()];
  if (unpricedHoldings.length > 0) {
    logger.event({
      type: "scoring_unpriced_holdings",
      holdings: unpricedHoldings,
    });
    console.warn(
      `[reconstruct] ${unpricedHoldings.length} holding(s) could not be priced and are excluded ` +
        "from agent value (see scoring_unpriced_holdings in events.jsonl); a zero here is not a trading loss",
    );
  }

  return {
    source: "post-run-reconstruction",
    granularityBlocks: 1,
    fromBlock,
    toBlock,
    blocks: toBlock - fromBlock + 1,
    failedReads,
    elapsedMs: Date.now() - started,
    alphaRefFairUsdcPerWeth: refFairByBase.WETH,
    alphaByAgent,
    unpricedHoldings,
  };
}

// Read one base's fair for the fixed reference fair (WETH=latestAnswer / extra base=answerOf).
async function readFairForRef(
  publicClient: PublicClient,
  priceFeed: Address,
  base: string,
  blockNumber: number,
): Promise<number> {
  try {
    if (base === "WETH") {
      return fromPriceFeedAnswer(
        (await publicClient.readContract({
          address: priceFeed,
          abi: priceFeedAbi,
          functionName: "latestAnswer",
          blockNumber: BigInt(blockNumber),
        })) as bigint,
      );
    }
    return fromPriceFeedAnswer(
      (await publicClient.readContract({
        address: priceFeed,
        abi: priceFeedAbi,
        functionName: "answerOf",
        args: [tokenInfo(base).address],
        blockNumber: BigInt(blockNumber),
      })) as bigint,
    );
  } catch {
    return 0;
  }
}
