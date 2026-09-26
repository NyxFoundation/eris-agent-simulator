// The evaluation-interval series and the names it is stored under (issue #140).
//
// The rules have two units. An *epoch* is one run: the world is reset, every agent starts together,
// and each agent gets one P = V_K − V_0 (rules §4.4.1). An *evaluation interval* (§0.1) cuts the
// epoch every N blocks so that interim progress can be shown; the score reads only the first and
// last boundary. Under ADR 0019 the boundary interval was itself the scoring unit and was named
// "epoch"; ADR 0017 / 0020 / 0023 moved the scoring unit to the whole run and the name stayed, so the
// code said `epoch` for both. The interval one is now `interval`, and `epoch` means the rules' epoch.
//
// The old names are still read, and still written beside the new ones, until the results are
// published (December). Two things make that necessary: the hosted dashboard follows `main` while
// the practice coordinator changes only on a restart, and a participant's runtime reads the manifest
// it was given. So every artifact written here carries both keys, and every reader takes either.
//
// Pure: the dashboard imports this through the `@core` alias.

/** The interval boundaries of one run and every agent's value at each (the scoring input). */
export type IntervalSeries = {
  intervalBlocks: number;
  // Number of intervals the series spans = boundaryBlocks.length - 1.
  intervals: number;
  boundaryBlocks: number[];
  // agent -> value at each boundary, aligned with boundaryBlocks. `null` marks a boundary whose
  // cross-section did not report that agent, so a gap is never read as a value of zero.
  valuesByAgent: Record<string, Array<number | null>>;
};

/** The same series under the names it had before issue #140. Written beside, never read first. */
export type LegacyEpochSeries = {
  epochBlocks: number;
  epochs: number;
  boundaryBlocks: number[];
  valuesByAgent: Record<string, Array<number | null>>;
};

/** How the live scorer read the boundaries (summary.json `valueSeries.intervalSeriesMeta`). */
export type IntervalSeriesMeta = {
  source: "live-interval-boundaries";
  boundaries: number;
  failedBoundaries: number;
  intervalBlocks: number;
  markMedianBlocks: number;
};

type LegacyEpochSeriesMeta = Omit<
  IntervalSeriesMeta,
  "source" | "intervalBlocks"
> & { source: "live-epoch-boundaries"; epochBlocks: number };

// One line per interval boundary, appended as the live scorer reaches it.
export const INTERVALS_FILENAME = "intervals.jsonl";
// What a coordinator from before issue #140 appends instead. Read when the new file is absent.
export const LEGACY_INTERVALS_FILENAME = "epochs.jsonl";

/** Event types the live scorer and the summary writer emit, and what they were called before. */
export const INTERVAL_EVENTS = {
  boundary: "interval_boundary",
  boundaryFailed: "interval_boundary_failed",
  seriesScored: "interval_series_scored",
  seriesAgreement: "interval_series_agreement",
} as const;
export const LEGACY_INTERVAL_EVENTS = {
  boundary: "epoch_boundary",
  boundaryFailed: "epoch_boundary_failed",
  seriesScored: "epoch_series_scored",
  seriesAgreement: "epoch_series_agreement",
} as const;

/** True for an interval-boundary event under either name. */
export function isIntervalBoundaryEvent(type: unknown): boolean {
  return (
    type === INTERVAL_EVENTS.boundary ||
    type === LEGACY_INTERVAL_EVENTS.boundary
  );
}

/**
 * The fields summary.json's `valueSeries` carries for the series: the new keys, and the old ones
 * beside them with the old inner names, so a reader built before issue #140 finds what it expects.
 */
export function intervalSeriesFields(
  series: IntervalSeries,
  meta?: IntervalSeriesMeta,
): {
  intervalSeries: IntervalSeries;
  intervalSeriesMeta?: IntervalSeriesMeta;
  epochSeries: LegacyEpochSeries;
  epochSeriesMeta?: LegacyEpochSeriesMeta;
} {
  const { intervalBlocks, intervals, ...rest } = series;
  return {
    intervalSeries: series,
    ...(meta ? { intervalSeriesMeta: meta } : {}),
    epochSeries: { epochBlocks: intervalBlocks, epochs: intervals, ...rest },
    ...(meta
      ? {
          epochSeriesMeta: {
            source: "live-epoch-boundaries",
            boundaries: meta.boundaries,
            failedBoundaries: meta.failedBoundaries,
            epochBlocks: meta.intervalBlocks,
            markMedianBlocks: meta.markMedianBlocks,
          },
        }
      : {}),
  };
}

/**
 * The interval series out of a summary.json `valueSeries`, under whichever name it was written.
 * The new key wins when both are present (a writer after issue #140 writes both, identically).
 */
export function intervalSeriesOf(
  valueSeries: unknown,
): IntervalSeries | undefined {
  if (!valueSeries || typeof valueSeries !== "object") return undefined;
  const v = valueSeries as {
    intervalSeries?: Partial<IntervalSeries>;
    epochSeries?: Partial<LegacyEpochSeries>;
  };
  const current = v.intervalSeries;
  if (current && Array.isArray(current.boundaryBlocks))
    return {
      intervalBlocks: Number(current.intervalBlocks ?? 0),
      intervals: Number(
        current.intervals ?? Math.max(0, current.boundaryBlocks.length - 1),
      ),
      boundaryBlocks: current.boundaryBlocks,
      valuesByAgent: current.valuesByAgent ?? {},
    };
  const legacy = v.epochSeries;
  if (legacy && Array.isArray(legacy.boundaryBlocks))
    return {
      intervalBlocks: Number(legacy.epochBlocks ?? 0),
      intervals: Number(
        legacy.epochs ?? Math.max(0, legacy.boundaryBlocks.length - 1),
      ),
      boundaryBlocks: legacy.boundaryBlocks,
      valuesByAgent: legacy.valuesByAgent ?? {},
    };
  return undefined;
}

/**
 * Blocks per interval as a `run_started_realtime` event or a manifest `round` recorded it, under
 * either name. 0 when neither is there (the run recorded no series).
 */
export function intervalBlocksOf(record: unknown): number {
  if (!record || typeof record !== "object") return 0;
  const r = record as { intervalBlocks?: unknown; epochBlocks?: unknown };
  const n = Number(r.intervalBlocks ?? r.epochBlocks ?? 0);
  return Number.isFinite(n) ? n : 0;
}
