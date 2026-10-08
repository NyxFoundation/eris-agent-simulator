// Closing a practice segment whose coordinator died before the day rolled (2026-10-08).
//
// A segment gets its summary.json from the coordinator when the day rolls (closeSegment in
// realtime/coordinator.ts). When the coordinator dies mid-day, the day keeps what the live scorer
// wrote -- intervals.jsonl, one line per boundary with every agent's value -- but no summary, and the
// standings drop the day: a segment that is neither summarised nor live has no series
// (dashboard/src/data/standings.ts). This builds the summary the roll would have written, ending at
// the last boundary that was read, with the roll's own functions: the previous segment's last
// boundary carried in as boundary 0 (sliceIntervalSeries), P from the two ends (epochPnlFromSeries),
// and an agent with no V_0 recorded as unscored, never as 0 (segmentAgentRecord).
import { intervalSeriesFields } from "./intervalSeries.js";
import { epochPnlFromSeries } from "./scoring/epochPnl.js";
import {
  segmentAgentRecord,
  segmentIndexAgent,
  sliceIntervalSeries,
  type SegmentAgentIdentity,
  type SegmentAgentRecord,
} from "./segments.js";

/** One line of a segment's intervals.jsonl. */
export type BoundaryLine = {
  blockNumber: number;
  fairPriceUsdcPerWeth?: number;
  values: Record<string, number | null | undefined>;
};

export type CrashedSegmentInput = {
  /** What the roll writes: `<competitionId>/segment-<n>`. */
  runId: string;
  segment: number;
  /** The block the segment opened at (its matrix.json entry's fromBlock). */
  fromBlock: number;
  intervalBlocks: number;
  /** Copied from the previous segment's summary, so the two read alike. */
  mode: unknown;
  resetUnit: unknown;
  blockTimeSec: unknown;
  /** The previous segment's boundary series; its last boundary before fromBlock is boundary 0. */
  previous: {
    boundaryBlocks: number[];
    valuesByAgent: Record<string, Array<number | null>>;
  };
  /** This segment's intervals.jsonl, in order. */
  lines: BoundaryLine[];
  /** Every agent the coordinator knew when it died. */
  identities: SegmentAgentIdentity[];
  /** Why this summary was not written by the roll, for whoever reads the file. */
  note: string;
};

export function closeCrashedSegment(input: CrashedSegmentInput): {
  summary: Record<string, unknown>;
  records: SegmentAgentRecord[];
  indexAgents: Record<string, unknown>[];
  toBlock: number;
} {
  const prevLength = input.previous.boundaryBlocks.length;
  const ids = new Set<string>([
    ...Object.keys(input.previous.valuesByAgent),
    ...input.lines.flatMap((l) => Object.keys(l.values)),
    ...input.identities.map((a) => a.id),
  ]);
  const whole = {
    boundaryBlocks: [
      ...input.previous.boundaryBlocks,
      ...input.lines.map((l) => l.blockNumber),
    ],
    valuesByAgent: Object.fromEntries(
      [...ids].map((id) => [
        id,
        [
          ...(input.previous.valuesByAgent[id] ??
            new Array<number | null>(prevLength).fill(null)),
          ...input.lines.map((l) => {
            const v = l.values[id];
            return typeof v === "number" ? v : null;
          }),
        ],
      ]),
    ),
  };
  const last = input.lines[input.lines.length - 1];
  const toBlock = last ? last.blockNumber : input.fromBlock;
  const sliced = sliceIntervalSeries(whole, input.fromBlock, toBlock);
  const records = input.identities.map((a) => {
    const values = sliced.valuesByAgent[a.id] ?? [];
    // Boundary 0 is carried from the previous segment, so a V_0 here is always a measured one.
    return segmentAgentRecord(
      a,
      epochPnlFromSeries(values),
      typeof values[0] === "number" ? "measured" : undefined,
    );
  });
  const summary = {
    runId: input.runId,
    mode: input.mode,
    resetUnit: input.resetUnit,
    blockTimeSec: input.blockTimeSec,
    segment: input.segment,
    fromBlock: input.fromBlock,
    toBlock,
    finalFairPriceUsdcPerWeth: last?.fairPriceUsdcPerWeth,
    valueSeries: {
      source: "live-interval-boundaries",
      ...intervalSeriesFields({
        intervalBlocks: input.intervalBlocks,
        intervals: Math.max(0, sliced.boundaryBlocks.length - 1),
        ...sliced,
      }),
    },
    violations: [],
    agents: records,
    closedAfterCoordinatorExit: { note: input.note, lastBoundaryBlock: toBlock },
  };
  return { summary, records, indexAgents: records.map(segmentIndexAgent), toBlock };
}
