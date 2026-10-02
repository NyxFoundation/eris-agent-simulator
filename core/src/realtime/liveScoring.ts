// Scoring at the interval boundary, as it goes past (ADR 0021 §3).
//
// Scoring used to be a post-run sweep: when the run ended, walk back over its blocks and rebuild
// every agent's value at each cross-section. That works for a run with an end, and it does not work
// for the practice devnet, for two reasons that arrive together.
//
//   There is no "after". The chain runs for the whole period without stopping, so a pass that begins
//   when the run finishes never begins.
//
//   And a node keeps only so much history. anvil holds roughly a thousand blocks; the sweep already
//   warns when a window outruns that, and the answer was always "make the run shorter". A week-long
//   chain cannot be made shorter.
//
// Reading the boundary *at* the boundary removes both at once, and costs one cross-section per
// interval -- one block in twelve at the current calibration, on a loop that already reads every
// venue every block. The same reader is used (readValueSnapshotAtBlock), at the same block, with the
// same G7 median window, so a boundary scored live and the same boundary scored afterwards produce
// the same number. That is the property that makes this a replacement rather than a second scoring
// path.
//
// It also gives the dashboard the one thing it could not have: standings during the run. Its
// "through interval k" recomputation already exists (it is how replay avoids showing the future); what
// was missing was a series to recompute from before the run was over.
import type { Address, PublicClient } from "viem";
import type { RunLogger } from "../logger.js";
import type { ProtocolId } from "@eris/sdk/types.js";
import {
  MarkMedian,
  endowmentValueAt,
  readValueSnapshotAtBlock,
  type ReconstructionAgent,
} from "./reconstruct.js";
import {
  INTERVAL_EVENTS,
  INTERVALS_FILENAME,
  type IntervalSeries,
  type IntervalSeriesMeta,
} from "../intervalSeries.js";
import { LiveMarketSampler, type MarketSeriesRow } from "./marketSeries.js";
import { nextIntervalBoundary } from "../epochExtent.js";
import {
  firstBoundaryV0,
  v0GapBeyondTolerance,
  type FirstBoundaryV0,
  type V0Source,
} from "../scoring/endowmentV0.js";

// One line per interval boundary (INTERVALS_FILENAME), appended as it is reached. The dashboard tails
// it the same way it tails events.jsonl; nothing has to wait for summary.json.
export { INTERVALS_FILENAME };
// One line per boundary of venue state, for the same reason (§3: "market series も同様に逐次追記へ").
// Sampled at the boundaries rather than every block: this is the view artifact, and a week of
// per-block venue rows is a file nobody can open.
export const MARKET_LIVE_FILENAME = "market.jsonl";

export type LiveIntervalBoundary = {
  index: number;
  blockNumber: number;
  fairPriceUsdcPerWeth: number;
  /** agent id -> live mark at this boundary. Null where the cross-section did not report one. */
  values: Record<string, number | null>;
  elapsedMs: number;
  // On the first boundary only (issue #207): which side of the endowment floor each agent's V_0
  // came from, what the chain actually showed there, and the endowment at this boundary's marks.
  // `values` above already carries the floored V_0; these are what a reader needs to check it.
  v0SourceByAgent?: Record<string, V0Source>;
  v0MeasuredByAgent?: Record<string, number | null>;
  v0EndowmentByAgent?: Record<string, number>;
};

export class LiveScorer {
  private readonly boundaries: number[] = [];
  private readonly valuesByAgent = new Map<string, Array<number | null>>();
  private readonly markMedian: MarkMedian;
  private readonly marketSampler: LiveMarketSampler | null;
  // The epoch's last block (epochExtent.ts): always a boundary, and nothing after it is one. Null
  // until known on a run with no block budget, which learns it from close().
  private endBlock: number | null;
  // The last boundary attempted (read or failed), or null before the first. The next one is derived
  // from it rather than stored, so that learning the end late re-clamps it.
  private lastAttempted: number | null = null;
  private failures = 0;
  // What the first boundary decided for each agent (issue #207), kept so summary.json can say how
  // V_0 was derived next to P. Keyed by agent; the block it was read at is firstBoundaryBlock.
  private readonly firstBoundaryByAgent = new Map<string, FirstBoundaryV0>();
  private firstBoundaryBlockNumber: number | null = null;

  constructor(
    private readonly opts: {
      publicClient: PublicClient;
      logger: RunLogger;
      agents: ReconstructionAgent[];
      enabledIds: ProtocolId[];
      activeStables: Address[];
      priceFeed: Address;
      /** First competition block. Boundary 0 sits on it. */
      runStartBlock: number;
      /**
       * The epoch's end block, runStartBlock + runBlocks (epochExtent.ts), when the run has a block
       * budget. It is the last boundary even off the interval grid, and no boundary is read past it
       * however far the notified head has run ahead. Omit for a run bounded only by the wall clock;
       * close() supplies the end when it comes.
       */
      endBlock?: number | null;
      intervalBlocks: number;
      markMedianBlocks: number;
      /** Sample the venue-state row at each boundary too. */
      sampleMarket: boolean;
    },
  ) {
    for (const a of opts.agents) this.valuesByAgent.set(a.id, []);
    this.endBlock = opts.endBlock ?? null;
    this.markMedian = new MarkMedian({
      publicClient: opts.publicClient,
      activeStables: opts.activeStables,
      windowBlocks: opts.markMedianBlocks,
      floorBlock: opts.runStartBlock,
    });
    this.marketSampler = opts.sampleMarket
      ? new LiveMarketSampler({
          publicClient: opts.publicClient,
          enabledIds: opts.enabledIds,
          priceFeed: opts.priceFeed,
        })
      : null;
  }

  get enabled(): boolean {
    return this.opts.intervalBlocks >= 1;
  }

  /** Boundaries recorded so far. Two are needed before there is a return to score. */
  get count(): number {
    return this.boundaries.length;
  }

  /**
   * An agent registered after the run started (ADR 0021 §2: a registration that arrived
   * mid-period). Valued from the next boundary on. The boundaries already recorded get null, which
   * the series reads as "no value here" rather than as zero (issue #44) -- so a segment the agent
   * joined in the middle of has no P for it (there is no V_0 it was measured at), and the first
   * segment it starts on a boundary does. Idempotent, because the registrations file is re-read.
   */
  addAgent(agent: ReconstructionAgent): void {
    if (this.valuesByAgent.has(agent.id)) return;
    this.opts.agents.push(agent);
    this.valuesByAgent.set(
      agent.id,
      this.boundaries.map(() => null),
    );
  }

  // The next boundary to read, or null when the end has been read.
  private pendingBoundary(): number | null {
    if (this.lastAttempted === null)
      return this.endBlock !== null && this.opts.runStartBlock > this.endBlock
        ? null
        : this.opts.runStartBlock;
    return nextIntervalBoundary(
      this.lastAttempted,
      this.opts.intervalBlocks,
      this.endBlock,
    );
  }

  // Called once per processed block. Catches up rather than matching an index exactly: the
  // coordinator's block handler skips notifications while it is busy, and a boundary that fell in a
  // skipped block would otherwise be lost -- the same failure that once swallowed a whole stress
  // event (pointEventsAt). Never reads past the end block, whatever block it is told about.
  async onBlock(blockNumber: number): Promise<void> {
    if (!this.enabled) return;
    for (
      let at = this.pendingBoundary();
      at !== null && at <= blockNumber;
      at = this.pendingBoundary()
    ) {
      this.lastAttempted = at;
      await this.scoreBoundary(at);
    }
  }

  /**
   * The run is over at `finalBlock`: read every boundary still due through it, and `finalBlock`
   * itself as the last one. On a run with a block budget the end was known from the start and this
   * only catches a final pass that failed before its boundary read; on a run cut by the wall clock
   * it is where the epoch's last boundary comes from. Idempotent.
   */
  async close(finalBlock: number): Promise<void> {
    if (!this.enabled) return;
    if (this.endBlock === null || finalBlock < this.endBlock)
      this.endBlock = finalBlock;
    await this.onBlock(finalBlock);
  }

  private async scoreBoundary(blockNumber: number): Promise<void> {
    const started = Date.now();
    try {
      // G7 (ADR 0019 §5): the same median window as the post-run path, over blocks that are recent
      // here rather than historical. Nothing about the rule changes with when it is applied.
      const stablePricesOverride = await this.markMedian.at(blockNumber);
      const snapshot = await readValueSnapshotAtBlock({
        publicClient: this.opts.publicClient,
        agents: this.opts.agents,
        enabledIds: this.opts.enabledIds,
        activeStables: this.opts.activeStables,
        priceFeed: this.opts.priceFeed,
        blockNumber,
        // On a chain that does not stop there is no run end to mark a queued exit against, so the
        // horizon is this boundary: an LST redemption that has not finalized is not reachable yet
        // (issue #38). The post-run path uses toBlock for the same reason -- it is the last moment
        // that exists.
        horizonBlock: blockNumber,
        medianWindow: this.markMedian.window(blockNumber),
        ...(stablePricesOverride ? { stablePricesOverride } : {}),
      });
      const index = this.boundaries.length;
      this.boundaries.push(blockNumber);
      const values: Record<string, number | null> = {};
      const byId = new Map(snapshot.values.map((v) => [v.id, v.valueUsdc]));
      // The first boundary is V_0, and there the measured value is floored at the endowment
      // (issue #207; scoring/endowmentV0.ts). Every later boundary is the measured value.
      const first = index === 0 ? this.firstBoundaryDetail() : null;
      for (const agent of this.opts.agents) {
        const measured = byId.get(agent.id) ?? null;
        const value = first
          ? first.record(
              agent.id,
              firstBoundaryV0(
                measured,
                agent.endowment
                  ? endowmentValueAt(agent.endowment, snapshot)
                  : undefined,
              ),
            )
          : measured;
        this.valuesByAgent.get(agent.id)?.push(value);
        values[agent.id] = value;
      }
      if (first) this.firstBoundaryBlockNumber = blockNumber;
      const boundary: LiveIntervalBoundary = {
        index,
        blockNumber,
        fairPriceUsdcPerWeth: snapshot.fairPriceUsdcPerWeth,
        values,
        elapsedMs: Date.now() - started,
        ...(first ? first.fields() : {}),
      };
      if (first) first.warn(blockNumber);
      this.opts.logger.append(INTERVALS_FILENAME, boundary);
      this.opts.logger.event({ type: INTERVAL_EVENTS.boundary, ...boundary });

      if (this.marketSampler) {
        const row = await this.marketSampler.sample(blockNumber);
        if (row) this.opts.logger.append(MARKET_LIVE_FILENAME, row);
      }
    } catch (error) {
      // A boundary that could not be read is skipped, not filled in. The value series treats a null
      // as "no value here" rather than as zero (ADR 0019 / issue #44), and inventing one would put a
      // fabricated return into the score. The boundary block itself is not pushed, so the series
      // stays aligned with the boundaries that were actually read.
      this.failures++;
      this.opts.logger.event({
        type: INTERVAL_EVENTS.boundaryFailed,
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The block the first boundary was read at, or null before it was. */
  get firstBoundaryBlock(): number | null {
    return this.firstBoundaryBlockNumber;
  }

  /** How V_0 was derived for this agent at the first boundary; undefined if it was not there. */
  firstBoundary(agentId: string): FirstBoundaryV0 | undefined {
    return this.firstBoundaryByAgent.get(agentId);
  }

  // The bookkeeping of the first boundary, kept out of scoreBoundary so the per-boundary loop
  // stays the same shape for every boundary.
  private firstBoundaryDetail() {
    const sources: Record<string, V0Source> = {};
    const measured: Record<string, number | null> = {};
    const endowments: Record<string, number> = {};
    const gaps: Array<{ agentId: string; gap: number }> = [];
    return {
      record: (agentId: string, v0: FirstBoundaryV0): number | null => {
        this.firstBoundaryByAgent.set(agentId, v0);
        sources[agentId] = v0.source;
        measured[agentId] = v0.measuredUsdc;
        if (v0.endowmentUsdc !== undefined) {
          endowments[agentId] = v0.endowmentUsdc;
          if (v0.measuredUsdc !== null) {
            const gap = v0GapBeyondTolerance(
              v0.measuredUsdc,
              v0.endowmentUsdc,
            );
            if (gap !== null) gaps.push({ agentId, gap });
          }
        }
        return v0.valueUsdc;
      },
      fields: () => ({
        v0SourceByAgent: sources,
        v0MeasuredByAgent: measured,
        v0EndowmentByAgent: endowments,
      }),
      // Said at the moment it is seen, not only in summary.json: an operator watching the run
      // should learn that a basket left before the bell while the epoch is still on.
      warn: (blockNumber: number) => {
        if (gaps.length === 0) return;
        this.opts.logger.event({
          type: "interval_v0_endowment_gap",
          blockNumber,
          agents: gaps,
          note:
            "measured − endowment at the first boundary, beyond tolerance. Negative: value left the " +
            "account before the epoch's first boundary and V_0 was taken at the endowment. Positive: " +
            "value the environment did not fund was there, and V_0 was taken as measured (issue #207)",
        });
        const said = gaps.map(
          ({ agentId, gap }) =>
            `${agentId} ${gap >= 0 ? "+" : ""}${gap.toFixed(0)} USDC vs endowment`,
        );
        console.error(
          `[scoring] V_0 at block ${blockNumber}: ${said.join(", ")}`,
        );
      },
    };
  }

  /** The series in the shape summary.json and the metrics tools already read. */
  series(): IntervalSeries | undefined {
    if (this.boundaries.length < 2) return undefined;
    return {
      intervalBlocks: this.opts.intervalBlocks,
      intervals: this.boundaries.length - 1,
      boundaryBlocks: [...this.boundaries],
      valuesByAgent: Object.fromEntries(
        [...this.valuesByAgent].map(([id, values]) => [id, [...values]]),
      ),
    };
  }

  meta(): IntervalSeriesMeta {
    return {
      source: "live-interval-boundaries",
      boundaries: this.boundaries.length,
      failedBoundaries: this.failures,
      intervalBlocks: this.opts.intervalBlocks,
      markMedianBlocks: this.opts.markMedianBlocks,
    };
  }
}

// Rows sampled live, in the shape market.json holds. Used when a run ends and the post-run market
// reconstruction is not available (a window longer than the node's history).
export type LiveMarketRow = MarketSeriesRow;
