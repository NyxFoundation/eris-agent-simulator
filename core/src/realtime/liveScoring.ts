// Scoring at the epoch boundary, as it goes past (ADR 0021 §3).
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
// Reading the boundary *at* the boundary removes both at once, and costs one cross-section per epoch
// -- one block in twelve at the current calibration, on a loop that already reads every venue every
// block. The same reader is used (readValueSnapshotAtBlock), at the same block, with the same G7
// median window, so a boundary scored live and the same boundary scored afterwards produce the same
// number. That is the property that makes this a replacement rather than a second scoring path.
//
// It also gives the dashboard the one thing it could not have: standings during the run. Its
// "through round k" recomputation already exists (it is how replay avoids showing the future); what
// was missing was a series to recompute from before the run was over.
import type { Address, PublicClient } from "viem";
import type { RunLogger } from "../logger.js";
import type { ProtocolId } from "@eris/sdk/types.js";
import {
  MarkMedian,
  readValueSnapshotAtBlock,
  type EpochSeries,
  type ReconstructionAgent,
} from "./reconstruct.js";
import { LiveMarketSampler, type MarketSeriesRow } from "./marketSeries.js";

// One line per epoch boundary, appended as it is reached. The dashboard tails this the same way it
// tails events.jsonl; nothing has to wait for summary.json.
export const EPOCHS_FILENAME = "epochs.jsonl";
// One line per boundary of venue state, for the same reason (§3: "market series も同様に逐次追記へ").
// Sampled at the boundaries rather than every block: this is the view artifact, and a week of
// per-block venue rows is a file nobody can open.
export const MARKET_LIVE_FILENAME = "market.jsonl";

export type LiveEpochBoundary = {
  index: number;
  blockNumber: number;
  fairPriceUsdcPerWeth: number;
  /** agent id -> live mark at this boundary. Null where the cross-section did not report one. */
  values: Record<string, number | null>;
  elapsedMs: number;
};

export class LiveScorer {
  private readonly boundaries: number[] = [];
  private readonly valuesByAgent = new Map<string, Array<number | null>>();
  private readonly markMedian: MarkMedian;
  private readonly marketSampler: LiveMarketSampler | null;
  private nextBoundary: number;
  private failures = 0;

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
      epochBlocks: number;
      markMedianBlocks: number;
      /** Sample the venue-state row at each boundary too. */
      sampleMarket: boolean;
    },
  ) {
    for (const a of opts.agents) this.valuesByAgent.set(a.id, []);
    this.nextBoundary = opts.runStartBlock;
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
    return this.opts.epochBlocks >= 1;
  }

  /** Boundaries recorded so far. Two are needed before there is a return to score. */
  get count(): number {
    return this.boundaries.length;
  }

  // Called once per processed block. Catches up rather than matching an index exactly: the
  // coordinator's block handler skips notifications while it is busy, and a boundary that fell in a
  // skipped block would otherwise be lost -- the same failure that once swallowed a whole stress
  // event (pointEventsAt).
  async onBlock(blockNumber: number): Promise<void> {
    if (!this.enabled) return;
    while (this.nextBoundary <= blockNumber) {
      const at = this.nextBoundary;
      this.nextBoundary += this.opts.epochBlocks;
      await this.scoreBoundary(at);
    }
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
        ...(stablePricesOverride ? { stablePricesOverride } : {}),
      });
      const index = this.boundaries.length;
      this.boundaries.push(blockNumber);
      const values: Record<string, number | null> = {};
      const byId = new Map(snapshot.values.map((v) => [v.id, v.valueUsdc]));
      for (const agent of this.opts.agents) {
        const value = byId.get(agent.id) ?? null;
        this.valuesByAgent.get(agent.id)?.push(value);
        values[agent.id] = value;
      }
      const boundary: LiveEpochBoundary = {
        index,
        blockNumber,
        fairPriceUsdcPerWeth: snapshot.fairPriceUsdcPerWeth,
        values,
        elapsedMs: Date.now() - started,
      };
      this.opts.logger.append(EPOCHS_FILENAME, boundary);
      this.opts.logger.event({ type: "epoch_boundary", ...boundary });

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
        type: "epoch_boundary_failed",
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The series in the shape summary.json and the metrics tools already read. */
  series(): EpochSeries | undefined {
    if (this.boundaries.length < 2) return undefined;
    return {
      epochBlocks: this.opts.epochBlocks,
      epochs: this.boundaries.length - 1,
      boundaryBlocks: [...this.boundaries],
      valuesByAgent: Object.fromEntries(
        [...this.valuesByAgent].map(([id, values]) => [id, [...values]]),
      ),
    };
  }

  meta(): {
    source: "live-epoch-boundaries";
    boundaries: number;
    failedBoundaries: number;
    epochBlocks: number;
    markMedianBlocks: number;
  } {
    return {
      source: "live-epoch-boundaries",
      boundaries: this.boundaries.length,
      failedBoundaries: this.failures,
      epochBlocks: this.opts.epochBlocks,
      markMedianBlocks: this.opts.markMedianBlocks,
    };
  }
}

// Rows sampled live, in the shape market.json holds. Used when a run ends and the post-run market
// reconstruction is not available (a window longer than the node's history).
export type LiveMarketRow = MarketSeriesRow;
