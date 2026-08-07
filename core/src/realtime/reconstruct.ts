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
// ADR 0013: also scores extra bases' (WBTC etc.) spot balances and LP.
//
// Issue #41: this file no longer knows which venues exist. It reads prices and free inventory and
// drives each enabled adapter's staged valuation; adding a venue means registering an adapter.
import type { Address, PublicClient } from "viem";
import { parseAbi, parseAbiItem } from "viem";
import { erc20Abi, poolAbi } from "@eris/sdk/abis.js";
import { MULTICALL3, TOKENS } from "@eris/sdk/constants.js";
import { baseTokens, marketsFor, tokenInfo } from "@eris/sdk/markets.js";
import type { RunLogger } from "../logger.js";
import { valueUsdc } from "@eris/sdk/pnl.js";
import { poolPriceUsdcPerWethFromSqrtX96 } from "@eris/sdk/protocols/uniswap.js";
import { getAdapter, hasAdapter } from "@eris/sdk/protocols/registry.js";
import type {
  AgentProtocolValue,
  ProtocolAdapter,
  ValuationContext,
  ValuationRun,
} from "@eris/sdk/protocols/types.js";
import type { ProtocolId } from "@eris/sdk/types.js";
import { fromPriceFeedAnswer, priceFeedAbi } from "./priceFeed.js";

// Measured upper bound of anvil's historical state retention depth (~1,050; ADR 0006 Risks). Warn if likely to exceed it.
const HISTORY_DEPTH_LIMIT = 1000;

const multicall3Abi = parseAbi([
  "function getEthBalance(address addr) view returns (uint256)",
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

// The adapters behind the run's enabled protocol ids. Adding a venue means registering an adapter,
// not editing this file (issue #41).
function adaptersForIds(ids: ProtocolId[]): ProtocolAdapter[] {
  return ids.filter(hasAdapter).map(getAdapter);
}

// Drive every enabled adapter's staged valuation, merging each stage's reads across adapters into a
// single multicall (issue #41). The scorer no longer knows which venues exist: it reads prices and
// free inventory, and the adapters contribute everything else.
//
// Stage 0 also carries the scorer's own reads, so an adapter's first stage costs no extra round trip.
// ctx.fairByBase() is only populated once stage 0 returns -- an adapter that returns before its first
// yield must not depend on it.
async function runValuations(opts: {
  runs: Array<{ id: ProtocolId; gen: ValuationRun }>;
  scorerReads: MulticallContract[];
  call: MulticallFn;
  blockNumber: bigint;
  onStageZero: (results: unknown[]) => void;
}): Promise<Map<ProtocolId, Record<string, AgentProtocolValue>>> {
  const pending = opts.runs.map((r) => ({
    ...r,
    done: false,
    input: undefined as unknown[] | undefined,
  }));
  const values = new Map<ProtocolId, Record<string, AgentProtocolValue>>();
  let stage = 0;
  while (true) {
    const spans: Array<{ index: number; start: number; length: number }> = [];
    const batch: MulticallContract[] = stage === 0 ? [...opts.scorerReads] : [];
    for (let i = 0; i < pending.length; i++) {
      const run = pending[i];
      if (run.done) continue;
      const step = await run.gen.next(run.input as never);
      if (step.done) {
        run.done = true;
        values.set(run.id, step.value);
        continue;
      }
      spans.push({ index: i, start: batch.length, length: step.value.length });
      batch.push(...(step.value as MulticallContract[]));
    }
    if (batch.length === 0) break;
    const results = await opts.call(batch, opts.blockNumber);
    if (stage === 0) opts.onStageZero(results);
    for (const span of spans) {
      pending[span.index].input = results.slice(
        span.start,
        span.start + span.length,
      );
    }
    stage++;
    if (spans.length === 0) break;
  }
  return values;
}

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
  let failedReads = 0;

  const call: MulticallFn = async (contracts, blockNumber) => {
    if (contracts.length === 0) return [];
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

  // ADR 0013: extra bases (other than WETH). Under the fork default this is empty.
  const extraBases = baseTokens()
    .map((t) => t.symbol)
    .filter((s) => s !== "WETH");

  // ---- the scorer's own reads: prices and free inventory ----
  const head: MulticallContract[] = [
    { address: priceFeed, abi: priceFeedAbi, functionName: "latestAnswer" },
    ...extraBases.map((b) => ({
      address: priceFeed,
      abi: priceFeedAbi,
      functionName: "answerOf",
      args: [tokenInfo(b).address],
    })),
  ];
  // Diagnostic only (post-run analysis of how well the pool tracked fair); it is not part of any
  // agent's value, which is why the scorer reads it rather than the adapter.
  const wethPool = enabledIds.includes("uniswap")
    ? marketsFor("uniswap").find((m) => m.base === "WETH")?.uniswap?.pool
    : undefined;
  const poolPriceIndex = wethPool ? head.length : -1;
  if (wethPool)
    head.push({ address: wethPool, abi: poolAbi, functionName: "slot0" });

  const spotBase = head.length;
  const spotPerAgent = 2 + extraBases.length + activeStables.length;
  for (const agent of agents) {
    head.push(
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
  }

  const blockNumber = BigInt(opts.blockNumber);
  let headResults: unknown[] = [];
  let fairByBase: Record<string, number> = {};
  const ctx: ValuationContext = {
    publicClient,
    blockNumber: opts.blockNumber,
    agents,
    activeStables,
    fairByBase: () => fairByBase,
  };
  const protocolValues = await runValuations({
    runs: adaptersForIds(enabledIds)
      .filter((a) => a.valueAtBlock)
      .map((a) => ({
        id: a.id,
        gen: (a.valueAtBlock as (c: ValuationContext) => ValuationRun)(ctx),
      })),
    scorerReads: head,
    call,
    blockNumber,
    onStageZero: (results) => {
      headResults = results;
      const fairPrice = fromPriceFeedAnswer((results[0] as bigint) ?? 0n);
      fairByBase = { WETH: fairPrice };
      extraBases.forEach((b, i) => {
        fairByBase[b] = fromPriceFeedAnswer((results[1 + i] as bigint) ?? 0n);
      });
    },
  });

  const fairPrice = fairByBase.WETH ?? 0;
  let poolPriceUsdcPerWeth: number | null = null;
  if (poolPriceIndex >= 0) {
    const slot0 = headResults[poolPriceIndex] as
      readonly [bigint, number] | undefined;
    if (slot0) poolPriceUsdcPerWeth = poolPriceUsdcPerWethFromSqrtX96(slot0[0]);
  }

  // α evaluation values free base inventory at the fixed reference fair (if unspecified, same as live fair = α=total value).
  const refFairByBase = opts.refFairByBase ?? fairByBase;
  const values: AgentValueSnapshot[] = [];
  const unpriced: UnpricedHolding[] = [];
  agents.forEach((agent, i) => {
    let idx = spotBase + i * spotPerAgent;
    const ethWei = (headResults[idx++] as bigint) ?? 0n;
    const wethWei = (headResults[idx++] as bigint) ?? 0n;
    const bases: Record<string, bigint> = { WETH: wethWei };
    for (const b of extraBases) bases[b] = (headResults[idx++] as bigint) ?? 0n;
    let usdcUnits = 0n;
    for (let s = 0; s < activeStables.length; s++) {
      usdcUnits += (headResults[idx++] as bigint) ?? 0n;
    }
    const balance = { ethWei, wethWei, usdcUnits, bases };
    // Evaluate free inventory two ways: at live fair (β-inclusive) and at the fixed reference fair (β-removed).
    let total = valueUsdc(balance, fairByBase);
    let alphaTotal = valueUsdc(balance, refFairByBase);
    // Protocol positions are a live mark in both evaluations (β removal applies to free inventory only).
    for (const [id, byAgent] of protocolValues) {
      const value = byAgent[agent.id];
      if (!value) continue;
      total += value.valueUsdc;
      alphaTotal += value.valueUsdc;
      for (const holding of value.unpriced) {
        unpriced.push({
          agentId: agent.id,
          source: holding.source || id,
          token: holding.token,
          amountRaw: holding.amountRaw,
        });
      }
    }
    values.push({ id: agent.id, valueUsdc: total, alphaValueUsdc: alphaTotal });
  });

  return {
    blockNumber: opts.blockNumber,
    fairPriceUsdcPerWeth: fairPrice,
    poolPriceUsdcPerWeth,
    failedReads,
    values,
    unpriced,
  };
}

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

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
  // Free inventory the scorer itself sums.
  for (const t of baseTokens()) accounted.add(t.address.toLowerCase());
  for (const s of opts.activeStables) accounted.add(s.toLowerCase());
  // Everything else is the adapters' knowledge: a venue that issues a token it does not value leaves
  // it out here, so the hole stays visible instead of being silently excused.
  for (const adapter of adaptersForIds(opts.enabledIds)) {
    if (!adapter.accountedTokens) continue;
    try {
      for (const t of await adapter.accountedTokens(publicClient))
        accounted.add(t.toLowerCase());
    } catch {
      // A venue we cannot interrogate only costs us false positives, never false negatives.
    }
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

type MulticallFn = (
  contracts: MulticallContract[],
  blockNumber: bigint,
) => Promise<unknown[]>;

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
