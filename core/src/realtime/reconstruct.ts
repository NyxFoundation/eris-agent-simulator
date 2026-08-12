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
import {
  decodeStableProbes,
  marketPricedStables,
  medianStablePrices,
  PAR_STABLE_PRICES,
  readStablePrices,
  stableProbeReads,
  type StableMarket,
  type StablePrices,
} from "@eris/sdk/stables.js";
import { poolPriceUsdcPerWethFromSqrtX96 } from "@eris/sdk/protocols/uniswap.js";
import { getAdapter, hasAdapter } from "@eris/sdk/protocols/registry.js";
import type {
  AgentProtocolValue,
  ProtocolAdapter,
  UnpricedHoldingDetail,
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
  // Block stride between value cross-sections (config.scoreEvery). 1 = every block. Anything larger
  // means the series in events.jsonl is thinned, and a reader reconstructing a per-block return or
  // drawdown series from `blocks` alone would mis-scale by this factor.
  granularityBlocks: number;
  fromBlock: number;
  toBlock: number;
  // Number of cross-sections actually read, not the width of the window. With granularityBlocks > 1
  // the two differ; windowBlocks keeps the width available.
  blocks: number;
  windowBlocks: number;
  failedReads: number;
  // Which contract/function the failed reads were, so a value that dropped can be traced back to the
  // read that hid it. The bare counter above said something went wrong but never what (issue #44).
  failedReadTargets: FailedReadTarget[];
  elapsedMs: number;
  // The fixed reference fair used for α evaluation (USDC/WETH; the fair at run end).
  alphaRefFairUsdcPerWeth: number;
  // agent -> α (= value at the fixed reference fair, toBlock − fromBlock; β-removed trade-derived PnL).
  alphaByAgent: Record<string, number>;
  // agent -> realizable value at the run's last cross-section, for the agents where it differs
  // from the mark (issue #38: a redemption still in the queue when the run ends). Absent entries
  // mean the two agreed, which is the normal case.
  liquidatableValueByAgent: Record<string, number>;
  // Holdings excluded from the value series because they could not be priced (issue #41) or could not
  // be read (issue #44).
  unpricedHoldings: UnpricedHolding[];
  // The value cross-sections at epoch boundaries (ADR 0019 §1). Absent when the run is shorter than
  // one epoch or the series is disabled (run.epochBlocks: 0).
  //
  // Raw values, not returns or scores: the metric (floor, log returns, mean - lambda*std) is meant to
  // stay recomputable from stored data when lambda or the epoch length changes, the same way
  // standings.json is derived from matrix.json (ADR 0017 §4).
  epochSeries?: EpochSeries;
  // How the epoch boundaries were marked (ADR 0019 G7). Absent when nothing was medianed.
  markMedian?: MarkMedianMeta;
};

export type MarkMedianMeta = {
  windowBlocks: number;
  boundaries: number;
  // Which manipulable marks the median covers. Named explicitly because the ADR's G7 lists four
  // surfaces and this is not yet all of them.
  surfaces: string[];
  // stable symbol -> the largest gap seen between the boundary's live probe and the median it was
  // scored at, over all boundaries.
  maxDeviationBps: Record<string, number>;
};

export type EpochSeries = {
  epochBlocks: number;
  // Number of returns the series supports = boundaryBlocks.length - 1.
  epochs: number;
  boundaryBlocks: number[];
  // agent -> value at each boundary, aligned with boundaryBlocks. `null` marks a boundary whose
  // cross-section did not report that agent, so a gap is never read as a value of zero.
  valuesByAgent: Record<string, Array<number | null>>;
};

// A contract/function whose reads failed during the reconstruction, and how often.
export type FailedReadTarget = {
  address: Address;
  functionName: string;
  count: number;
};

function mergeFailedReads(
  into: Map<string, FailedReadTarget>,
  from: Iterable<FailedReadTarget>,
): void {
  for (const t of from) {
    const key = `${t.address.toLowerCase()}|${t.functionName}`;
    const existing = into.get(key);
    if (existing) existing.count += t.count;
    else into.set(key, { ...t });
  }
}

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
  // What the agent could actually realize at this cross-section: free inventory plus each venue's
  // exit value rather than its face mark. Equal to valueUsdc for every venue that exits at par,
  // which is all of them except the LST queue (issue #38) -- so past runs compare unchanged, and
  // the two only separate where a position genuinely cannot be liquidated for its mark.
  liquidatableValueUsdc: number;
};

// A holding excluded from an agent's value: the scorer cannot price it, nothing sums it (issue #41),
// or the read that would have revealed it failed (issue #44). Either way a zero in summary.json is
// indistinguishable from a trading loss, so the exclusion is reported instead of being applied silently.
export type UnpricedHolding = UnpricedHoldingDetail & { agentId: string };

export type ValueSnapshot = {
  blockNumber: number;
  fairPriceUsdcPerWeth: number;
  // Pool price (from slot0) only when Uniswap is enabled. null if disabled.
  poolPriceUsdcPerWeth: number | null;
  failedReads: number;
  failedReadTargets: FailedReadTarget[];
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
  // Last block of the run window. Venues whose exit takes time mark against it: an LST redemption
  // queued at this cross-section is only worth par if it finalizes before the run ends (issue #38).
  // Defaults to blockNumber, i.e. "nothing further is reachable" -- the conservative reading.
  horizonBlock?: number;
  // Fixed reference fair for α evaluation (base symbol -> USD). If unspecified, α = total value.
  refFairByBase?: Record<string, number>;
  // Stable prices to value this cross-section at, replacing the ones probed at this block (ADR 0019
  // G7: epoch boundaries are marked at the median over the blocks before them, so a one-block push
  // into a thin pool does not become the score). The probe at this block still runs -- the caller
  // compares the two to report how far the mark was moved.
  stablePricesOverride?: StablePrices;
}): Promise<ValueSnapshot> {
  const { publicClient, agents, enabledIds, activeStables, priceFeed } = opts;
  let failedReads = 0;
  const failedReadTargets = new Map<string, FailedReadTarget>();

  const call: MulticallFn = async (contracts, blockNumber) => {
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
        // Name the read, not just the fact that one failed: the whole point of #44 is being able to
        // say which holding went missing.
        mergeFailedReads(failedReadTargets, [
          {
            address: contracts[i].address,
            functionName: contracts[i].functionName,
            count: 1,
          },
        ]);
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

  // Issue #27: what each market-priced stable is actually worth at this cross-section. Two reads
  // per stable (both executable directions) and one owner for the answer -- every venue that names
  // a stable leg reads it back off ctx rather than probing the same pool again.
  const stableMarkets = marketPricedStables(activeStables);
  const stableProbeBase = head.length;
  head.push(...(stableProbeReads(stableMarkets) as MulticallContract[]));

  // Per-agent spot reads, described once so that both the request and the decode below work off the
  // same list. A failed read can then name the holding it hid instead of decoding to zero (issue #44).
  const spotLayout: SpotRead[] = [
    { kind: "eth" },
    { kind: "base", symbol: "WETH", token: TOKENS.WETH.address },
    ...extraBases.map((symbol) => ({
      kind: "base" as const,
      symbol,
      token: tokenInfo(symbol).address,
    })),
    ...activeStables.map((token) => ({ kind: "stable" as const, token })),
  ];
  const spotBase = head.length;
  for (const agent of agents) {
    head.push(
      ...spotLayout.map((read) =>
        read.kind === "eth"
          ? {
              address: MULTICALL3,
              abi: multicall3Abi,
              functionName: "getEthBalance",
              args: [agent.address],
            }
          : {
              address: read.token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [agent.address],
            },
      ),
    );
  }

  const blockNumber = BigInt(opts.blockNumber);
  let headResults: unknown[] = [];
  let fairByBase: Record<string, number> = {};
  let stablePrices: StablePrices = PAR_STABLE_PRICES;
  const ctx: ValuationContext = {
    publicClient,
    blockNumber: opts.blockNumber,
    horizonBlock: opts.horizonBlock ?? opts.blockNumber,
    agents,
    activeStables,
    fairByBase: () => fairByBase,
    stablePrices: () => stablePrices,
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
      // A zero WETH fair prices every base-denominated holding — spot, LP and perp alike — at
      // nothing, so the whole cross-section reads as a cliff in the value series. There is no
      // reading of the chain under which that is the right answer, so refuse the block rather than
      // score it (issue #44).
      const answer = results[0];
      if (typeof answer !== "bigint")
        throw new Error(fairPriceFailure(opts.blockNumber, "read failed"));
      const fairPrice = fromPriceFeedAnswer(answer);
      if (!(fairPrice > 0))
        throw new Error(fairPriceFailure(opts.blockNumber, "returned 0"));
      fairByBase = { WETH: fairPrice };
      // Extra bases are different: answerOf returns 0 for a base the run never priced, which is a
      // real "no entry" rather than a broken read. Holdings of it are reported as unpriced below.
      extraBases.forEach((b, i) => {
        fairByBase[b] = fromPriceFeedAnswer((results[1 + i] as bigint) ?? 0n);
      });
      // A stable whose pool refuses to quote resolves to par here and is named in `unquoted`, which
      // the per-agent decode below turns into a reported holding. Unlike a missing WETH fair this
      // is not a reason to refuse the block: par is a defensible number, it just is not a measured
      // one, and saying so is the whole point (issue #27).
      const probed = decodeStableProbes(
        stableMarkets,
        results.slice(
          stableProbeBase,
          stableProbeBase + stableMarkets.length * 2,
        ),
      );
      // The override has to win before any adapter reads ctx.stablePrices(): the Liquity venue prices
      // its Trove debt and Stability Pool deposit off the same seam, so a boundary marked at the
      // median for spot eUSD and at the live push for the debt would be two rules at once.
      stablePrices = opts.stablePricesOverride ?? probed;
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
  // Stables the run priced from a market that would not quote at this block. Reported per agent
  // that actually holds one, so the diagnostic names a value someone's number depends on.
  const unquotedStables = new Map<string, StableMarket>(
    stablePrices.unquoted.map((m) => [m.token.toLowerCase(), m]),
  );
  agents.forEach((agent, i) => {
    const spotStart = spotBase + i * spotLayout.length;
    let ethWei = 0n;
    const stables: Record<string, bigint> = {};
    const bases: Record<string, bigint> = {};
    spotLayout.forEach((read, k) => {
      const raw = headResults[spotStart + k];
      if (typeof raw !== "bigint") {
        // The balance is unknown, not zero. Keep the zero (there is nothing better to sum) but say
        // so, otherwise the agent's inventory silently evaporates for this block (issue #44).
        unpriced.push({
          agentId: agent.id,
          source: spotSource(read),
          ...(read.kind === "eth" ? {} : { token: read.token }),
          amountRaw: "",
          reason: "read-failed",
          read:
            read.kind === "eth"
              ? "Multicall3.getEthBalance"
              : "ERC20.balanceOf",
        });
        if (read.kind === "base") bases[read.symbol] = 0n;
        return;
      }
      if (read.kind === "eth") ethWei = raw;
      else if (read.kind === "base") bases[read.symbol] = raw;
      else stables[read.token.toLowerCase()] = raw;
    });
    const wethWei = bases.WETH ?? 0n;
    // Native USDC alone, matching getBalances since issue #27. The other stables are valued from
    // the `stables` breakdown at their own prices rather than summed in here at face value.
    const usdcUnits = stables[TOKENS.USDC.address.toLowerCase()] ?? 0n;
    for (const [token, units] of Object.entries(stables)) {
      const market = unquotedStables.get(token);
      if (!market || units <= 0n) continue;
      unpriced.push({
        agentId: agent.id,
        source: `spot-${market.symbol}`,
        token: market.token,
        amountRaw: units.toString(),
        reason: "par-fallback",
        read: "CurveStableSwapNG.get_dy",
      });
    }
    // A base the run never wrote a price for values at zero the same way an unreadable balance does,
    // so a holding of one is reported rather than quietly counted as nothing (WETH cannot land here:
    // a missing WETH fair already failed the block above).
    for (const [symbol, wei] of Object.entries(bases)) {
      if (wei > 0n && !(fairByBase[symbol] > 0)) {
        unpriced.push({
          agentId: agent.id,
          source: `spot-${symbol}`,
          token: tokenInfo(symbol).address,
          amountRaw: wei.toString(),
          reason: "unpriced",
        });
      }
    }
    const balance = { ethWei, wethWei, usdcUnits, bases, stables };
    // Evaluate free inventory two ways: at live fair (β-inclusive) and at the fixed reference fair (β-removed).
    //
    // The stable leg is marked live in *both* (issue #27). Unlike a base's fair price, a stable's
    // discount is not exogenous drift: it is a dislocation against a price the protocol itself
    // enforces, and closing it is the trade the venue exists for. Evaluating it at a fixed reference
    // would cancel exactly the thing being measured. Nothing is endowed in a market-priced stable
    // (fundWallet grants only the par ones), so every unit of the exposure was chosen.
    let total = valueUsdc(balance, fairByBase, stablePrices);
    let alphaTotal = valueUsdc(balance, refFairByBase, stablePrices);
    // Free inventory is realizable by definition, so the liquidatable series starts from the same
    // live mark and only the venues diverge.
    let liquidatableTotal = valueUsdc(balance, fairByBase, stablePrices);
    // Protocol positions are a live mark in both evaluations (β removal applies to free inventory only).
    for (const [id, byAgent] of protocolValues) {
      const value = byAgent[agent.id];
      if (!value) continue;
      total += value.valueUsdc;
      alphaTotal += value.valueUsdc;
      liquidatableTotal += value.liquidatableValueUsdc;
      for (const holding of value.unpriced) {
        unpriced.push({
          ...holding,
          agentId: agent.id,
          source: holding.source || id,
        });
      }
    }
    values.push({
      id: agent.id,
      valueUsdc: total,
      alphaValueUsdc: alphaTotal,
      liquidatableValueUsdc: liquidatableTotal,
    });
  });

  return {
    blockNumber: opts.blockNumber,
    fairPriceUsdcPerWeth: fairPrice,
    poolPriceUsdcPerWeth,
    failedReads,
    failedReadTargets: [...failedReadTargets.values()],
    values,
    unpriced,
  };
}

// Per-agent spot read, described so the decode can name what a failed read hid.
type SpotRead =
  | { kind: "eth" }
  | { kind: "base"; symbol: string; token: Address }
  | { kind: "stable"; token: Address };

function spotSource(read: SpotRead): string {
  if (read.kind === "eth") return "spot-eth";
  if (read.kind === "base") return `spot-${read.symbol}`;
  return "spot-stable";
}

function fairPriceFailure(blockNumber: number, what: string): string {
  return (
    `[reconstruct] fair price unusable at block ${blockNumber} (PriceFeed.latestAnswer ${what}); ` +
    "refusing to score a cross-section where every base-denominated holding would read as zero. " +
    `anvil retains only ~${HISTORY_DEPTH_LIMIT} blocks of history, so this usually means the run ` +
    "window outran it (ADR 0006 §4)"
  );
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

// Blocks to read a value cross-section at. `every` > 1 thins the series to cut reconstruction cost
// when replaying a scenario matrix (ADR 0017 §3).
//
// fromBlock and toBlock are always included, which is what keeps thinning score-neutral:
// alphaByAgent is alphaLast - alphaFirst, so only those two cross-sections reach summary.json.
// Everything dropped in between is equity-curve resolution in events.jsonl, nothing else.
export function scoringBlocks(
  fromBlock: number,
  toBlock: number,
  every: number,
): number[] {
  const step = Math.max(1, Math.floor(every));
  const blocks: number[] = [];
  for (let b = fromBlock; b < toBlock; b += step) blocks.push(b);
  blocks.push(toBlock);
  return blocks;
}

// Blocks the epoch series is sampled at (ADR 0019 §1/§8). E epochs need E+1 boundaries, so the run's
// start is boundary 0 and the returned array is one longer than the epoch count.
//
// A trailing partial epoch is dropped rather than scored short: a window shorter than the others
// produces a smaller log return by construction, which the metric would read as the agent slowing
// down. Dropping it costs at most `epochBlocks - 1` blocks of a run that was not sized for the epoch
// length in the first place.
//
// These are *not* forced to coincide with scoringBlocks: with `scoreEvery > 1` the thinned series can
// skip a boundary, so the caller reads the union of the two.
export function epochBoundaryBlocks(
  fromBlock: number,
  toBlock: number,
  epochBlocks: number,
): number[] {
  const step = Math.floor(epochBlocks);
  if (!Number.isFinite(step) || step < 1) return [];
  const epochs = Math.floor((toBlock - fromBlock) / step);
  if (epochs < 1) return [];
  return Array.from({ length: epochs + 1 }, (_, i) => fromBlock + i * step);
}

// G7 (ADR 0019 §5): mark each epoch boundary at the median of the blocks leading up to it, so that
// pushing a pool for one block does not become the score. It has to hold for most of the window to
// count, which turns a spread-cost round trip into a position.
//
// Scope today is the market-priced stables. That is one seam, not one venue: spot registry stables
// (#27) and the Liquity venue's Trove debt / Stability Pool deposit both price off ctx.stablePrices()
// (protocols/liquity.ts). The other two surfaces the ADR names -- the LST market price and LP share
// reserves -- compute their price inside their own adapter's staged reads (protocols/lst.ts issues
// its own get_dy), so they are still marked live. Recorded rather than left implicit: a partial G7
// that reads as a complete one is the failure mode this rule exists to prevent.
class MarkMedian {
  private readonly maxDeviationBps = new Map<string, number>();
  private boundaries = 0;

  constructor(
    private readonly opts: {
      publicClient: PublicClient;
      activeStables: Address[];
      windowBlocks: number;
      // The run's first block: earlier boundaries get a shorter window rather than reads of blocks
      // that predate the run.
      floorBlock: number;
    },
  ) {}

  private get enabled(): boolean {
    return (
      this.opts.windowBlocks > 1 &&
      marketPricedStables(this.opts.activeStables).length > 0
    );
  }

  // The prices to value the boundary at, or undefined to keep the live mark (nothing to median).
  async at(block: number): Promise<StablePrices | undefined> {
    if (!this.enabled) return undefined;
    const first = Math.max(
      this.opts.floorBlock,
      block - this.opts.windowBlocks + 1,
    );
    const window: number[] = [];
    for (let b = first; b <= block; b++) window.push(b);
    if (window.length <= 1) return undefined;
    // N x 2 reads per stable per boundary. The client folds them into multicalls, and only the ~43
    // boundaries pay it -- the equity curve does not.
    const samples = await Promise.all(
      window.map((b) =>
        readStablePrices(
          this.opts.publicClient,
          this.opts.activeStables,
          BigInt(b),
        ),
      ),
    );
    const median = medianStablePrices(samples);
    const live = samples[samples.length - 1];
    for (const quote of median.quotes) {
      const livePrice = live.byToken[quote.token.toLowerCase()] ?? 0;
      if (!(livePrice > 0) || !(quote.priceUsdc > 0)) continue;
      const bps = (Math.abs(quote.priceUsdc - livePrice) / livePrice) * 10_000;
      this.maxDeviationBps.set(
        quote.symbol,
        Math.max(this.maxDeviationBps.get(quote.symbol) ?? 0, bps),
      );
    }
    this.boundaries++;
    return median;
  }

  // Reported so a run says how much the rule actually moved: a large gap between the live mark and
  // the median is either a volatile peg or somebody leaning on the pool at the boundary, and both
  // are things the operator wants to see rather than infer.
  summary(): MarkMedianMeta | undefined {
    if (this.boundaries === 0) return undefined;
    return {
      windowBlocks: this.opts.windowBlocks,
      boundaries: this.boundaries,
      surfaces: ["stables"],
      maxDeviationBps: Object.fromEntries(this.maxDeviationBps),
    };
  }
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
  // Read a cross-section only every Nth block (config.scoreEvery). Score-neutral; see scoringBlocks.
  scoreEvery?: number;
  // Epoch length for the ADR 0019 value series (config.epochBlocks). 0 = do not produce the series.
  epochBlocks?: number;
  // G7 window: how many blocks each epoch boundary's manipulable marks are medianed over, the
  // boundary block included (config.markMedianBlocks). <= 1 marks boundaries live.
  markMedianBlocks?: number;
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
    scoreEvery = 1,
    epochBlocks = 0,
    markMedianBlocks = 0,
  } = opts;
  const started = Date.now();
  let failedReads = 0;
  const failedReadTargets = new Map<string, FailedReadTarget>();

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
    horizonBlock: toBlock,
  });
  failedReads += refSnapshot.failedReads;
  mergeFailedReads(failedReadTargets, refSnapshot.failedReadTargets);
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
  // Realizable value at the run's last cross-section, and the mark from that same cross-section to
  // compare it against (issue #38). Reported alongside the mark rather than replacing it.
  const liquidatableLast = new Map<string, number>();
  const markedLast = new Map<string, number>();
  // Holdings the scorer could not price (issue #41) or could not read (issue #44). Deduplicated
  // across the run window (they persist block to block) and emitted once at the end, so a zero in
  // summary.json is never mistaken for a trading loss. amountRaw is the last one seen.
  const unpriced = new Map<string, UnpricedHolding>();
  // The reason is part of the key: the same holding can be unreadable at one block and unpriceable
  // at another, and collapsing those into one entry would hide half the story.
  const unpricedKey = (h: UnpricedHolding) =>
    `${h.agentId}|${h.source}|${h.token?.toLowerCase() ?? ""}|${h.reason ?? "unpriced"}`;
  // Epoch boundaries are read even when the rest of the series is thinned: they are the score, the
  // thinned cross-sections are only the equity curve.
  const boundaryBlocks = epochBoundaryBlocks(fromBlock, toBlock, epochBlocks);
  const boundaryIndex = new Map(boundaryBlocks.map((b, i) => [b, i]));
  const epochValuesByAgent = new Map<string, Array<number | null>>(
    agents.map((a) => [
      a.id,
      Array.from({ length: boundaryBlocks.length }, () => null),
    ]),
  );
  const blocks = [
    ...new Set([
      ...scoringBlocks(fromBlock, toBlock, scoreEvery),
      ...boundaryBlocks,
    ]),
  ].sort((a, b) => a - b);
  if (scoreEvery > 1)
    logger.event({
      type: "scoring_thinned",
      scoreEvery,
      crossSections: blocks.length,
      windowBlocks: toBlock - fromBlock + 1,
    });
  // G7 (ADR 0019 §5): only the epoch boundaries are medianed. The cross-sections in between are the
  // equity curve, and smoothing those would hide real intra-epoch moves without protecting any score.
  const markMedian = new MarkMedian({
    publicClient,
    activeStables,
    windowBlocks: markMedianBlocks,
    floorBlock: fromBlock,
  });
  for (const b of blocks) {
    const stablePricesOverride = boundaryIndex.has(b)
      ? await markMedian.at(b)
      : undefined;
    const snapshot = await readValueSnapshotAtBlock({
      publicClient,
      agents,
      enabledIds,
      activeStables,
      priceFeed,
      blockNumber: b,
      horizonBlock: toBlock,
      refFairByBase,
      ...(stablePricesOverride ? { stablePricesOverride } : {}),
    });
    failedReads += snapshot.failedReads;
    mergeFailedReads(failedReadTargets, snapshot.failedReadTargets);
    for (const h of snapshot.unpriced) unpriced.set(unpricedKey(h), h);
    for (const {
      id,
      valueUsdc: total,
      alphaValueUsdc,
      liquidatableValueUsdc,
    } of snapshot.values) {
      if (!alphaFirst.has(id)) alphaFirst.set(id, alphaValueUsdc);
      alphaLast.set(id, alphaValueUsdc);
      liquidatableLast.set(id, liquidatableValueUsdc);
      markedLast.set(id, total);
      // ADR 0019 §3: the epoch series is the ordinary live mark, not alphaValueUsdc. Its β removal is
      // partial (free inventory is held at the reference fair while protocol positions stay live), so
      // scoring on it would price the same bet differently depending on the instrument.
      const epochAt = boundaryIndex.get(b);
      const epochValues = epochValuesByAgent.get(id);
      if (epochAt !== undefined && epochValues) epochValues[epochAt] = total;
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
          inventory: {
            valueUsdc: total,
            alphaValueUsdc,
            // Only worth a field when it says something the mark does not.
            ...(liquidatableValueUsdc !== total
              ? { liquidatableValueUsdc }
              : {}),
          },
        },
      });
    }
  }

  const alphaByAgent: Record<string, number> = {};
  for (const { id } of agents)
    alphaByAgent[id] = (alphaLast.get(id) ?? 0) - (alphaFirst.get(id) ?? 0);
  // Only agents whose realizable value actually diverged from the mark. Comparing against the
  // mark from the *same* cross-section matters: the coordinator's end-of-run PnL is computed at a
  // different block by a different path, so comparing against that would flag every agent.
  const liquidatableValueByAgent: Record<string, number> = {};
  for (const { id } of agents) {
    const liquidatable = liquidatableLast.get(id);
    const marked = markedLast.get(id);
    if (
      liquidatable !== undefined &&
      marked !== undefined &&
      Math.abs(liquidatable - marked) > 1e-9
    ) {
      liquidatableValueByAgent[id] = liquidatable;
    }
  }

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
    unpriced.set(unpricedKey(holding), holding);
  }

  // Default the reason once, here, so every site upstream can leave it off when it only ever reports
  // unpriceable holdings while the emitted event still always says which kind it is.
  const unpricedHoldings = [...unpriced.values()].map((h) => ({
    ...h,
    reason: h.reason ?? ("unpriced" as const),
  }));
  if (unpricedHoldings.length > 0) {
    logger.event({
      type: "scoring_unpriced_holdings",
      holdings: unpricedHoldings,
      failedReadTargets: [...failedReadTargets.values()],
    });
    const unreadable = unpricedHoldings.filter(
      (h) => h.reason === "read-failed",
    ).length;
    // par-fallback holdings are counted in the value, at $1, because their market would not quote
    // (issue #27) -- reported for the opposite reason to the others, so they are counted apart.
    const atPar = unpricedHoldings.filter(
      (h) => h.reason === "par-fallback",
    ).length;
    const excluded = unpricedHoldings.length - atPar;
    console.warn(
      `[reconstruct] ${excluded} holding(s) excluded from agent value ` +
        `(${excluded - unreadable} unpriceable, ${unreadable} unreadable)` +
        (atPar > 0
          ? `, ${atPar} stable holding(s) marked at par because their market did not quote`
          : "") +
        "; see scoring_unpriced_holdings in events.jsonl — a zero here is not a trading loss, " +
        "and a dollar is not a measurement",
    );
  }

  const epochSeries: EpochSeries | undefined =
    boundaryBlocks.length > 1
      ? {
          epochBlocks: Math.floor(epochBlocks),
          epochs: boundaryBlocks.length - 1,
          boundaryBlocks,
          valuesByAgent: Object.fromEntries(epochValuesByAgent),
        }
      : undefined;
  if (epochSeries) {
    const gaps = Object.values(epochSeries.valuesByAgent).reduce(
      (n, series) => n + series.filter((v) => v === null).length,
      0,
    );
    if (gaps > 0)
      console.warn(
        `[reconstruct] epoch series has ${gaps} missing boundary value(s); ` +
          "a null is a boundary that reported no value, not a value of zero",
      );
  }

  return {
    source: "post-run-reconstruction",
    granularityBlocks: scoreEvery,
    fromBlock,
    toBlock,
    blocks: blocks.length,
    windowBlocks: toBlock - fromBlock + 1,
    failedReads,
    failedReadTargets: [...failedReadTargets.values()],
    elapsedMs: Date.now() - started,
    alphaRefFairUsdcPerWeth: refFairByBase.WETH,
    alphaByAgent,
    liquidatableValueByAgent,
    unpricedHoldings,
    ...(epochSeries ? { epochSeries } : {}),
    ...(markMedian.summary() ? { markMedian: markMedian.summary() } : {}),
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
      const weth = fromPriceFeedAnswer(
        (await publicClient.readContract({
          address: priceFeed,
          abi: priceFeedAbi,
          functionName: "latestAnswer",
          blockNumber: BigInt(blockNumber),
        })) as bigint,
      );
      // This one number is the reference every α in the run is measured against, so swallowing a
      // failure here would zero the entire α series at once rather than one block of it (issue #44).
      if (!(weth > 0)) throw new Error("latestAnswer returned 0");
      return weth;
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
  } catch (err) {
    if (base === "WETH")
      throw new Error(
        `[reconstruct] reference fair price unusable at block ${blockNumber}: ${err instanceof Error ? err.message : err}`,
      );
    // A base the run never priced is a real "no entry", and holdings of it are reported per block.
    return 0;
  }
}
