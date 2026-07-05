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
import { parseAbi } from "viem";
import { erc20Abi, poolAbi } from "@eris/sdk/abis.js";
import { AAVE, MULTICALL3, TOKENS, UNISWAP } from "@eris/sdk/constants.js";
import { baseTokens, marketsFor, tokenInfo } from "@eris/sdk/markets.js";
import type { RunLogger } from "../logger.js";
import { valueUsdc } from "@eris/sdk/pnl.js";
import { aavePoolAbi } from "@eris/sdk/protocols/aave.js";
import {
  gmxAccountPositionsCall,
  gmxEthUsdPositionValueUsd,
} from "@eris/sdk/protocols/gmx.js";
import {
  lpPositionValueUsdcMulti,
  poolPriceUsdcPerWethFromSqrtX96,
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
  hasUniswap: boolean;
  hasAave: boolean;
  hasGmx: boolean;
}): number {
  return (
    1 + // ETH
    1 + // WETH
    opts.extraBaseCount + // extra base balances (WBTC etc.)
    opts.activeStables.length +
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

export type ValueSnapshot = {
  blockNumber: number;
  fairPriceUsdcPerWeth: number;
  // Pool price (from slot0) only when Uniswap is enabled. null if disabled.
  poolPriceUsdcPerWeth: number | null;
  failedReads: number;
  values: AgentValueSnapshot[];
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

  const perAgent = perAgentReads({
    extraBaseCount: extraBases.length,
    activeStables,
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

  // LP enumeration (2nd/3rd stage multicall): for agents holding an NFT, look up tokenId → positions
  const lpValueByAgent = new Map<string, number>();
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
      owners.forEach(({ agent }, j) => {
        const pos = positions[j];
        if (!pos || tokenIds[j] === undefined) return;
        const value = lpPositionValueUsdcMulti(
          pos as Parameters<typeof lpPositionValueUsdcMulti>[0],
          tickByPool,
          fairByBase,
        );
        lpValueByAgent.set(
          agent.id,
          (lpValueByAgent.get(agent.id) ?? 0) + value,
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
    const balance = { ethWei, wethWei, usdcUnits, bases };
    // Evaluate free inventory two ways: at live fair (β-inclusive) and at the fixed reference fair (β-removed).
    let total = valueUsdc(balance, fairByBase);
    let alphaTotal = valueUsdc(balance, refFairByBase);
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
  };
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
