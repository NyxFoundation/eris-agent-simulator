// What a live view knows about the chain's transactions, and — the part that keeps it honest —
// which blocks that knowledge covers.
//
// Two sources arrive at different times. blocks.csv is the coordinator's own record, written within
// a block of the head while a period is segmented (ADR 0021 §6) and in one pass at the end
// otherwise; it carries the real status, the priority fee and the decoded method. The chain's recent
// blocks, where the browser may read them, carry whatever the csv has not caught up to yet. The
// merge is "the record, then the chain past it", and a transaction in both is the record's.
//
// The coverage is not decoration. A round that starts before the first block held has no
// transaction count to report, and reporting 0 says the round was quiet — a different claim, and
// the one the explorer and the rounds bar were making for a whole practice period (issue #84 A/I).
//
// Kept free of imports so it can be tested under node, like worldVenues.ts.

/** The fields of a block row this module needs; the full shape lives in runArtifacts.ts. */
export interface MergeableRow {
  blockNumber: number;
  hash: string;
}

export interface LiveBlockView<T extends MergeableRow> {
  rows: T[];
  /**
   * The lowest block `rows` covers, or null when they cover none. Off the range that was fetched,
   * not off the first row: a block with no transaction in it is still covered, and a round full of
   * empty blocks must not read as a round nobody could see.
   */
  blocksFrom: number | null;
}

export function mergeLiveBlocks<T extends MergeableRow>(opts: {
  /** blocks.csv rows held in memory, oldest first (the newest are kept when capped). */
  csvRows: T[];
  /** The first block blocks.csv covered, when the whole file has been read. */
  csvFrom: number | null;
  /** True once the cap has cut the front off, so the retained rows are the coverage. */
  csvCapped: boolean;
  /** Rows synthesized from the chain's recent blocks. */
  chainRows: T[];
  /** The lowest block of the chain window that was read, or null when none was. */
  chainFrom: number | null;
}): LiveBlockView<T> {
  const { csvRows, csvFrom, csvCapped, chainRows, chainFrom } = opts;
  const csvHashes = new Set(csvRows.map((r) => r.hash.toLowerCase()));
  const lastCsvBlock = csvRows[csvRows.length - 1]?.blockNumber;
  const rows = [
    ...csvRows,
    ...chainRows.filter(
      (r) =>
        !csvHashes.has(r.hash.toLowerCase()) &&
        (lastCsvBlock === undefined || r.blockNumber > lastCsvBlock),
    ),
  ];
  const retainedFrom =
    csvRows.length > 0
      ? csvCapped
        ? csvRows[0].blockNumber
        : (csvFrom ?? csvRows[0].blockNumber)
      : null;
  const blocksFrom =
    retainedFrom !== null && chainFrom !== null
      ? Math.min(retainedFrom, chainFrom)
      : (retainedFrom ?? chainFrom);
  return { rows, blocksFrom };
}

/**
 * Whether a window starting at `fromBlock` is inside what the view covers. `blocksFrom` null on a
 * live run means nothing is covered; on an archived one there is no live window and everything is.
 *
 * The boundary is `fromBlock >= blocksFrom - 1` because a round's window is exclusive of its first
 * block: round k counts blocks after `fromBlock` up to `toBlock`.
 */
export function coversWindow(
  fromBlock: number,
  blocksFrom: number | null,
  live: boolean,
): boolean {
  if (!live) return true;
  if (blocksFrom === null) return false;
  return fromBlock >= blocksFrom - 1;
}
