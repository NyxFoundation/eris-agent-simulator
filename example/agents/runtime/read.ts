/**
 * read.ts: observation reconstruction via on-chain reads (ADR 0015 runtime; the read side of the old directShim).
 *
 * Each block, read the PriceFeed's fair price, each venue's state, and your own balances, and
 * assemble an AgentObservation of the same shape as the environment's (the assembly uses sdk's
 * observationFor = the same contract as the environment's scoring reconstruction). Fair price is
 * distributed on-chain (ADR 0006 §3), so the information is one block behind (applies to everyone equally; by design).
 */
import type { Address } from "viem";
import { activeStables, getBalances } from "@eris/sdk/chain.js";
import { MarketRegistryWatcher } from "@eris/sdk/agentMarkets.js";
import { baseTokens, tokenInfo } from "@eris/sdk/markets.js";
import { observationFor } from "@eris/sdk/observation.js";
import { PoolDiscovery } from "@eris/sdk/discoveredPools.js";
import { readFairPrice, readFairPriceFor } from "@eris/sdk/priceFeed.js";
import { readRunStart } from "@eris/sdk/runStart.js";
import { type EpochOrdinal, epochOrdinalFromEnv } from "@eris/sdk/epoch.js";
import {
  dayBlocksRemaining,
  type ManifestPeriod,
  scoredDayHours,
} from "@eris/sdk/periodClock.js";
import type { ProtocolAdapter, SimContext } from "@eris/sdk/protocols/types.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
} from "@eris/sdk/types.js";
import { blocksRemainingUnderBlockBudget } from "./blockBudget.js";
import { pinnedClient } from "./pinnedClient.js";
import {
  describeSelfHostedBudget,
  selfHostedBlocksRemaining,
} from "./runClock.js";

export type ChainSnapshot = {
  observation: AgentObservation;
  balances: BalanceSnapshot;
  stateById: Map<ProtocolId, unknown>;
  fairPrice: number;
};

export type LastGoodSections = Map<
  ProtocolId,
  { block: number; section: object }
>;

// How long a failed venue read waits before its one retry. Long enough for a block being mined to
// be mined (median 5.5 ms on the practice devnet's miner), short against the 2-second block.
const VENUE_READ_RETRY_MS = 100;

/// The adapter, with an observe() that never costs the block once the venue has been read once.
///
/// One venue's failed read used to take the whole observation with it, so a strategy that never
/// trades Aave stopped deciding whenever Aave's read reverted (practice devnet, 2026-10-24 onwards:
/// `getUserReserveData(USDC, self)` reverting with an arithmetic underflow, 5-30 blocks an hour: anvil's
/// mid-mine read race, pinnedClient.ts). A failed read is retried once; if it fails again,
/// the venue's last good section is served, marked `stale` with the block it was read at and the
/// error. With no good read yet there is nothing honest to serve, and the failure still takes the
/// block.
export function servingLastGood(
  adapter: ProtocolAdapter,
  bn: number,
  lastGood: LastGoodSections,
  warn: (line: string) => void = (line) => process.stderr.write(line),
  retryDelayMs = VENUE_READ_RETRY_MS,
): ProtocolAdapter {
  const observe: ProtocolAdapter["observe"] = async (...args) => {
    let section: unknown;
    try {
      section = await adapter.observe(...args).catch(async () => {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        return adapter.observe(...args);
      });
    } catch (error) {
      const last = lastGood.get(adapter.id);
      if (!last) throw error;
      const message = (
        error instanceof Error ? error.message : String(error)
      ).split("\n")[0];
      warn(
        `[read] block ${bn}: ${adapter.id} read failed twice, serving block ${last.block}'s section: ${message}\n`,
      );
      return {
        ...structuredClone(last.section),
        stale: { block: String(last.block), error: message },
      };
    }
    // Copied both ways: the observation goes to the strategy, which may mutate what it is given.
    if (section && typeof section === "object")
      lastGood.set(adapter.id, {
        block: bn,
        section: structuredClone(section),
      });
    else lastGood.delete(adapter.id);
    return section;
  };
  return Object.assign(Object.create(adapter) as ProtocolAdapter, { observe });
}

export class Reader {
  private readonly ctx: SimContext;
  // Rules §3.2 regime 7: the pools the environment adds mid-epoch, read off the factory the
  // coordinator names in ERIS_VULN_FACTORY. Absent in a run without one.
  private readonly discovery: PoolDiscovery | null;
  private readonly adapters: ProtocolAdapter[];
  private readonly enabledIds: ProtocolId[];
  private readonly priceFeed: Address;
  private readonly address: Address;
  private readonly runId: string;
  private readonly extraBaseSymbols: string[];
  private readonly history: AgentObservation["history"] = [];
  // Each venue's last good observe() section and the block it was read at, served (marked stale)
  // when a later block's read of that venue fails.
  private readonly lastGood: LastGoodSections = new Map();
  // The first block this agent saw: the fallback origin for how much of the run is left. The
  // environment cannot pass the run's start block in env (agent processes are spawned before
  // interval mining begins, so it does not exist yet); it declares it in the run directory once it
  // knows it (issue #117, `run-start.json`), and `declaredFirstBlock` takes over the moment that
  // file is read. Until then the budget is inferred from this block, and any jump in block numbers
  // after boot is charged against the run. A self-hosted agent has no run directory to read; its
  // declaration is the manifest's `period` (below), and this block is its origin only when the
  // manifest states a block count without saying where it starts.
  private firstBlock: number | null = null;
  private declaredFirstBlock: number | null = null;
  // The origin of a practice period's day grid, from the same declaration (absent in a file from
  // before it carried one).
  private declaredStartedAtMs: number | null = null;
  private declarationRead = false;
  private readonly runDir: string | undefined;
  private budgetOriginNoted = false;
  // Self-hosted (ADR 0021 §2): the manifest's statement of the run, which replaces both the env the
  // coordinator would have passed and the run-start.json it would have written. Absent for a
  // coordinator-spawned agent, whose path below is unchanged.
  private readonly period: ManifestPeriod | undefined;
  private dayNoted = false;
  // When this process started, and when it first managed to observe a block. The gap between them
  // is startup lag the run has already spent.
  private readonly startedAtMs = Date.now();
  private firstSeenAtMs: number | null = null;

  // Issue #40: absent when the run has no registry, which is the ordinary case for a run without
  // agent-created markets. `observation.registry` is then absent too, rather than empty — "nobody
  // deployed anything" and "this run has no registry" are different facts.
  private readonly registryWatcher: MarketRegistryWatcher | undefined;

  // Issue #167: which epoch of the schedule this run is, when it is one of a scenario matrix
  // (sdk/src/epoch.ts). Absent otherwise, and then absent from the observation too.
  private readonly epoch: EpochOrdinal | undefined = readEpochFromEnv();

  constructor(opts: {
    ctx: SimContext;
    adapters: ProtocolAdapter[];
    priceFeed: Address;
    address: Address;
    runId: string;
    extraBaseSymbols: string[];
    registry?: { address: Address; fromBlock: number };
    /** ERIS_RUN_DIR: where the coordinator declares the run's first block. Absent when self-hosted. */
    runDir?: string;
    /** The manifest's `period`, when self-hosted. Its presence is what selects that path. */
    period?: ManifestPeriod;
  }) {
    this.runDir = opts.runDir;
    this.period = opts.period;
    this.ctx = opts.ctx;
    this.adapters = opts.adapters;
    this.enabledIds = opts.adapters.map((a) => a.id);
    this.priceFeed = opts.priceFeed;
    this.address = opts.address;
    this.runId = opts.runId;
    this.extraBaseSymbols = opts.extraBaseSymbols;
    this.registryWatcher = opts.registry
      ? new MarketRegistryWatcher(
          opts.registry.address,
          opts.address,
          opts.registry.fromBlock,
          // Tokens the environment prices. A holding of anything else is worth zero wherever it
          // sits, so tracking where it went would report a number nobody scores.
          new Set(
            [
              ...baseTokens().map((t) => t.address),
              ...activeStables(),
            ].map((a) => a.toLowerCase()),
          ),
        )
      : undefined;
    const factory = process.env.ERIS_VULN_FACTORY;
    this.discovery = factory
      ? new PoolDiscovery(
          this.ctx.publicClient,
          factory as `0x${string}`,
          BigInt(process.env.ERIS_VULN_FROM_BLOCK ?? "0"),
        )
      : null;
  }

  // Reconstruct the observation from this block's chain snapshot.
  async snapshot(bn: number): Promise<ChainSnapshot> {
    // Every read of this block's observation is read at this block, not at `latest` (pinnedClient.ts),
    // so a read that straddles the next block, or is retried after it, still answers for this one.
    const publicClient = pinnedClient(this.ctx.publicClient, bn);
    // Parallelize independent reads (2-second block hot path; only keep the fairPrice -> readState dependency)
    const [fairPrice, balances] = await Promise.all([
      readFairPrice(publicClient, this.priceFeed),
      getBalances(publicClient, this.address),
    ]);
    // ADR 0013: read the extra bases' fair prices from the PriceFeed into ctx.fairPrices. This lets
    // observationFor fill observation.fairPricesUsd for all bases (so the agent can observe WBTC).
    // adapter.observe looks at ctx.fairPrices?.[base], so it must be set before observationFor.
    // With extraBaseSymbols=[] (the fork default), fairPrices={WETH} is byte-identical to the legacy path.
    const fairPrices: Record<string, number> = { WETH: fairPrice };
    if (this.extraBaseSymbols.length > 0) {
      const extra = await Promise.all(
        this.extraBaseSymbols.map((b) =>
          readFairPriceFor(publicClient, this.priceFeed, tokenInfo(b).address),
        ),
      );
      this.extraBaseSymbols.forEach((b, i) => {
        fairPrices[b] = extra[i];
      });
    }
    this.ctx.fairPrices = fairPrices;
    const ctx: SimContext = { ...this.ctx, publicClient };
    // Issue #40: the registry read is several round trips (the entry list, every entry's current
    // codehash, the oracle owners, the block's transfers) and the block is two seconds long, so it
    // is issued alongside the venue reads rather than after them.
    const registryPromise = this.registryWatcher?.observe(publicClient, bn);
    const states = await Promise.all(
      this.adapters.map((adapter) => adapter.readState(ctx, fairPrice)),
    );
    const stateById = new Map<ProtocolId, unknown>(
      this.adapters.map((adapter, i) => [adapter.id, states[i]]),
    );
    const uni = stateById.get("uniswap") as
      { priceUsdcPerWeth?: number } | undefined;
    this.history.push({
      round: bn,
      poolPriceUsdcPerWeth: uni?.priceUsdcPerWeth ?? fairPrice,
      fairPriceUsdcPerWeth: fairPrice,
    });
    if (this.history.length > 20)
      this.history.splice(0, this.history.length - 20);
    const registry = await registryPromise;
    const observation = await observationFor(
      ctx,
      this.adapters.map((adapter) =>
        servingLastGood(adapter, bn, this.lastGood),
      ),
      stateById,
      this.runId,
      bn,
      BigInt(bn),
      this.address,
      fairPrice,
      balances,
      this.history,
      this.ctx.config,
      this.enabledIds,
      registry,
    );
    this.firstBlock ??= bn;
    this.firstSeenAtMs ??= Date.now();
    if (this.period) this.observeSelfHostedClock(observation, bn);
    else this.observeCoordinatorClock(observation, bn);
    this.observeEpoch(observation);
    if (this.discovery) {
      try {
        observation.discoveredPools = await this.discovery.observe(BigInt(bn));
      } catch (error) {
        // A failed scan must not cost the block: the rest of the observation is intact and the
        // pools will be picked up on the next one. Said, not swallowed.
        process.stderr.write(
          `[read] discovered-pool scan failed at block ${bn}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    return { observation, balances, stateById, fairPrice };
  }

  // The same ordinal on every block: it does not change within an epoch.
  private observeEpoch(observation: AgentObservation): void {
    if (this.epoch) observation.epoch = { ...this.epoch };
  }

  // The coordinator's declaration of the run's first block (issue #117), once it exists. It arrives
  // after the agent has booted (it is written when the chain has settled and counting starts), so
  // it is looked for each block until it is there: one existsSync per block until then, nothing
  // afterwards.
  private pollDeclaration(): boolean {
    if (this.declarationRead) return true;
    const declared = readRunStart(this.runDir);
    if (!declared) return false;
    this.declarationRead = true;
    this.declaredFirstBlock = declared.runStartBlock;
    if (declared.startedAt !== undefined)
      this.declaredStartedAtMs = Date.parse(declared.startedAt);
    process.stderr.write(
      `[read] run start declared by the coordinator: block ${declared.runStartBlock}, ` +
        `${declared.runBlocks} blocks (blocksRemaining is counted from it)\n`,
    );
    return true;
  }

  // Inferred case only: counting from the first block *this* agent saw overstates the remaining run
  // by however long the process took to boot -- and an agent told the run is longer than it is
  // starts exits it cannot finish. The startup lag is charged against the budget.
  private startupLagBlocks(): number {
    return Math.max(
      0,
      Math.round(
        ((this.firstSeenAtMs ?? this.startedAtMs) - this.startedAtMs) /
          1000 /
          Math.max(1, this.ctx.config.blockTimeSec),
      ),
    );
  }

  // A coordinator-spawned agent: the budget from env / run-start.json / config, as before.
  private observeCoordinatorClock(
    observation: AgentObservation,
    bn: number,
  ): void {
    // The environment passes its resolved block budget, which is what a CLI --blocks override
    // changed; the YAML the child reloads still says whatever the file says.
    const runBlocks = Number(
      process.env.ERIS_RUN_BLOCKS ?? this.ctx.config.runBlocks,
    );
    const budgets: number[] = [];
    if (runBlocks > 0) {
      if (!this.pollDeclaration() && !this.budgetOriginNoted) {
        this.budgetOriginNoted = true;
        process.stderr.write(
          `[read] blocksRemaining is inferred from the first block this process saw (${bn}) ` +
            `until the coordinator's run-start.json appears` +
            (this.runDir ? "" : " (no ERIS_RUN_DIR: it never will)") +
            "\n",
        );
      }
      const budget = blocksRemainingUnderBlockBudget({
        bn,
        runBlocks,
        declaredFirstBlock: this.declaredFirstBlock,
        firstSeenBlock: this.firstBlock ?? bn,
        startupLagBlocks: this.startupLagBlocks(),
      });
      if (budget !== null) budgets.push(budget);
    }
    // A run without a block limit still ends on the wall clock, and nothing above accounts for it.
    const runSeconds = this.ctx.config.runSeconds;
    if (runSeconds > 0) {
      const elapsedSec = (Date.now() - this.startedAtMs) / 1000;
      budgets.push(
        Math.floor(
          (runSeconds - elapsedSec) / Math.max(1, this.ctx.config.blockTimeSec),
        ),
      );
    }
    if (budgets.length > 0) {
      // Whichever terminator comes first is the one that ends the run.
      observation.blocksRemaining = Math.max(0, Math.min(...budgets));
    }
    const dayHours = scoredDayHours(this.ctx.config);
    if (dayHours > 0) {
      this.pollDeclaration();
      this.setDayBlocksRemaining(
        observation,
        dayHours,
        this.declaredStartedAtMs,
        "until the coordinator's run-start.json says when the period's clock started" +
          (this.runDir ? "" : " (no ERIS_RUN_DIR: it never will)"),
      );
    }
  }

  // A self-hosted agent: the manifest's `period` is the declaration (runClock.ts).
  private observeSelfHostedClock(
    observation: AgentObservation,
    bn: number,
  ): void {
    const period = this.period as ManifestPeriod;
    if (!this.budgetOriginNoted) {
      this.budgetOriginNoted = true;
      process.stderr.write(`[read] ${describeSelfHostedBudget(period)}\n`);
    }
    const remaining = selfHostedBlocksRemaining({
      period,
      bn,
      nowMs: Date.now(),
      // The manifest's cadence: botMain applies chain.blockTimeSec over the loaded config.
      blockTimeSec: this.ctx.config.blockTimeSec,
      firstSeenBlock: this.firstBlock ?? bn,
      startupLagBlocks: this.startupLagBlocks(),
      processStartedAtMs: this.startedAtMs,
    });
    if (remaining !== undefined) observation.blocksRemaining = remaining;
    if (period.dayHours > 0)
      this.setDayBlocksRemaining(
        observation,
        period.dayHours,
        period.startedAt !== undefined ? Date.parse(period.startedAt) : null,
        "the manifest does not say when the period's clock started -- it was built before the " +
          "period did. Ask the operator for the running period's manifest",
      );
  }

  // Blocks until the scored day ends (sdk/src/periodClock.ts), from this machine's clock. The last
  // day ends with the run, which can come before the grid's next point.
  private setDayBlocksRemaining(
    observation: AgentObservation,
    dayHours: number,
    originMs: number | null,
    missing: string,
  ): void {
    if (originMs === null) {
      if (!this.dayNoted) {
        this.dayNoted = true;
        process.stderr.write(`[read] dayBlocksRemaining is left out ${missing}\n`);
      }
      return;
    }
    const day = dayBlocksRemaining({
      startedAtMs: originMs,
      dayHours,
      nowMs: Date.now(),
      blockTimeSec: this.ctx.config.blockTimeSec,
    });
    observation.dayBlocksRemaining =
      observation.blocksRemaining !== undefined
        ? Math.min(day, observation.blocksRemaining)
        : day;
  }
}

// Half an ordinal, or a malformed one, is the environment's bug. Said, and left out of the
// observation, rather than costing the agent its epoch.
function readEpochFromEnv(): EpochOrdinal | undefined {
  try {
    return epochOrdinalFromEnv(process.env);
  } catch (error) {
    process.stderr.write(
      `[read] ${error instanceof Error ? error.message : String(error)}; obs.epoch is left out\n`,
    );
    return undefined;
  }
}
