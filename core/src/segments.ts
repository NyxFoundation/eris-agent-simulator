// Rolling the run directory while the chain keeps going (ADR 0021 §6).
//
// The practice devnet does not stop for a week. Its artifacts cannot be one directory: events.jsonl
// and blocks.csv would grow past what anything can open, and a viewer would have to read a week to
// see this morning. So the *chain* stays continuous and the *output* is cut into segments -- a day
// each by default -- and each segment is an ordinary run directory: same files, same shape, readable
// by every tool that reads a run today.
//
// The dashboard already has the structure for this. A competition holds scenarios, and a scenario is
// one run directory beside the competition's index; a matrix writes that index, and this writes the
// same one with a segment per entry. So a week shows up as a list of days without the dashboard
// learning a new concept. `resetUnit` stays `continuous`, truthfully -- these are cuts of one world,
// not separate worlds -- which is also why `npm run metrics` will not mix them with scenario runs
// (ADR 0020 §1).
//
// The seam that is not free: an epoch boundary that falls inside a segment belongs to it, but the
// *return* into the first boundary of a segment comes from the last boundary of the one before. So
// each segment's series carries that previous boundary as its own boundary 0. Without it every
// segment would silently lose its first epoch, which over a week is seven of them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStringify } from "@eris/sdk/logger.js";
import {
  RunLogger,
  type BlockRowInput,
  type RunArtifactWriter,
} from "./logger.js";

/** The file inside a competition directory naming the segment that is current right now. */
export const CURRENT_SEGMENT_FILE = "current-segment";

export type SegmentIndexEntry = {
  /** Scenario shape, so the dashboard reads this with the code it already has. */
  regime: "segment";
  seed: number;
  /** What a reader should see instead of "segment#3": the day this covers. */
  label: string;
  runDir: string;
  fromBlock: number;
  toBlock: number;
  startedAt: string;
  endedAt?: string;
  agents: unknown[];
};

export class SegmentedRun implements RunArtifactWriter {
  private logger: RunLogger;
  private index: SegmentIndexEntry[] = [];
  private segment = 0;
  private segmentStartedAtMs: number;
  private segmentStartBlock = 0;
  // The directory's name, fixed when the directory is created. Derived from the start time once and
  // then held: the start time moves when the first block arrives (see noteFirstBlock), and a name
  // recomputed after that would stop matching the directory on disk the moment a period's setup
  // straddled midnight.
  private segmentDirId: string;

  constructor(
    private readonly opts: {
      /** runs/ */
      root: string;
      /** The competition directory under it; segments are its children. */
      competitionId: string;
      /** Wall-clock hours per segment. */
      hours: number;
      /** A display name for the whole period. */
      scenarioSet: string;
    },
  ) {
    mkdirSync(join(opts.root, opts.competitionId), { recursive: true });
    this.segmentStartedAtMs = Date.now();
    this.segmentDirId = this.newSegmentId();
    this.logger = new RunLogger(
      join(opts.root, opts.competitionId),
      this.segmentDirId,
    );
    this.writeIndex();
    this.writePointer();
  }

  /**
   * Where a running agent process reads the directory it should be writing its decision log into.
   *
   * An agent is spawned once and handed ERIS_RUN_DIR; a segment roll changes the directory under it
   * hours later. Without a pointer every log line for the rest of the period lands in the first
   * segment, and every segment after it shows a local agent with no lines -- which the dashboard
   * states as "it never logged a decision" (runsProvider.ts). That is false, and it is the one
   * reading a viewer cannot check.
   */
  get pointerPath(): string {
    return join(this.competitionDir, CURRENT_SEGMENT_FILE);
  }

  private writePointer(): void {
    // Written after the directory exists, so a reader never sees a path that is not there yet.
    writeFileSync(this.pointerPath, `${this.logger.runDir}\n`);
  }

  // Named by when it started rather than by its number: a viewer looking for Tuesday should not
  // have to count. Called once per directory; `segmentDirId` is what everything else reads.
  private newSegmentId(): string {
    const iso = new Date(this.segmentStartedAtMs).toISOString();
    return `${iso.slice(0, 10)}-s${String(this.segment).padStart(2, "0")}`;
  }

  // What a reader sees in the picker. Precision follows the segment length: a daily period reads as
  // dates, a shorter one has to say the time or every segment carries the same name. Identity is
  // never this -- the dashboard keys scenarios by runDir precisely because two segments can start in
  // the same minute.
  private segmentLabel(): string {
    const iso = new Date(this.segmentStartedAtMs).toISOString();
    if (this.opts.hours >= 24) return iso.slice(0, 10);
    if (this.opts.hours >= 1)
      return `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00Z`;
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
  }

  // ---- RunArtifactWriter, forwarded to whichever segment is current ----
  get runDir(): string {
    return this.logger.runDir;
  }
  event(event: Record<string, unknown>): void {
    this.logger.event(event);
  }
  blockRow(row: BlockRowInput): void {
    this.logger.blockRow(row);
  }
  summary(summary: Record<string, unknown>): void {
    this.logger.summary(summary);
  }
  artifact(filename: string, data: unknown): void {
    this.logger.artifact(filename, data);
  }
  append(filename: string, row: unknown): void {
    this.logger.append(filename, row);
  }

  /** The competition directory the segments live in. */
  get competitionDir(): string {
    return join(this.opts.root, this.opts.competitionId);
  }

  get currentSegment(): number {
    return this.segment;
  }

  get currentSegmentStartBlock(): number {
    return this.segmentStartBlock;
  }

  /**
   * The first segment starts when the competition's first block is known -- which is also when its
   * clock starts. Setup is minutes on a real chain (issue #33 (1)), and counting that against the
   * first segment's window makes the first day short; long enough setup rolled a segment before the
   * run had a block at all, leaving an empty directory whose index entry claimed to span 607..606.
   */
  noteFirstBlock(blockNumber: number): void {
    if (this.segmentStartBlock !== 0) return;
    this.segmentStartBlock = blockNumber;
    this.segmentStartedAtMs = Date.now();
    this.writeIndex();
  }

  dueToRoll(nowMs = Date.now()): boolean {
    // Never before the run has a block: a segment with no blocks in it is not a day of the period.
    if (this.segmentStartBlock === 0) return false;
    return nowMs - this.segmentStartedAtMs >= this.opts.hours * 3_600_000;
  }

  /**
   * Close the current segment and open the next. The caller writes the closing segment's summary
   * first (it owns the scoring), and gets back the new segment's directory.
   */
  roll(atBlock: number, agents: unknown[]): string {
    this.closeIndexEntry(atBlock, agents);
    this.segment++;
    this.segmentStartedAtMs = Date.now();
    this.segmentStartBlock = atBlock;
    this.segmentDirId = this.newSegmentId();
    this.logger = new RunLogger(this.competitionDir, this.segmentDirId);
    this.writeIndex();
    this.writePointer();
    return this.logger.runDir;
  }

  /** Close the final segment (run end). */
  finish(atBlock: number, agents: unknown[]): void {
    this.closeIndexEntry(atBlock, agents);
  }

  private closeIndexEntry(atBlock: number, agents: unknown[]): void {
    const id = this.segmentDirId;
    const existing = this.index.find((e) => e.runDir.endsWith(id));
    const entry: SegmentIndexEntry = {
      regime: "segment",
      seed: this.segment,
      label: this.segmentLabel(),
      runDir: `runs/${this.opts.competitionId}/${id}`,
      fromBlock: this.segmentStartBlock,
      toBlock: atBlock,
      startedAt: new Date(this.segmentStartedAtMs).toISOString(),
      endedAt: new Date().toISOString(),
      agents,
    };
    if (existing) Object.assign(existing, entry);
    else this.index.push(entry);
    this.writeIndex();
  }

  // Rewritten on every change rather than appended, because it is an index: a half-written list of
  // days is worse than a list that is one day behind, and it is a few kilobytes.
  private writeIndex(): void {
    const id = this.segmentDirId;
    if (!this.index.some((e) => e.runDir.endsWith(id)))
      this.index.push({
        regime: "segment",
        seed: this.segment,
        label: this.segmentLabel(),
        runDir: `runs/${this.opts.competitionId}/${id}`,
        fromBlock: this.segmentStartBlock,
        toBlock: this.segmentStartBlock,
        startedAt: new Date(this.segmentStartedAtMs).toISOString(),
        agents: [],
      });
    writeFileSync(
      join(this.competitionDir, "matrix.json"),
      `${safeStringify(
        {
          schema: 1,
          createdAt: new Date().toISOString(),
          scenarioSet: this.opts.scenarioSet,
          // Truthfully continuous: these are cuts of one world, not separate ones (ADR 0020 §1).
          resetUnit: "continuous",
          segmentHours: this.opts.hours,
          scenariosPlanned: this.index.length,
          scenarios: this.index,
        },
        2,
      )}\n`,
    );
  }
}

/**
 * The boundaries of one segment, taken out of the whole run's epoch series.
 *
 * The boundary immediately *before* the segment starts is included as its boundary 0. A segment's
 * first epoch is the interval that ends inside it, and its return needs the value at both ends -- so
 * cutting strictly on the segment's own blocks would drop one epoch per segment.
 */
export function sliceEpochSeries<T>(
  series: { boundaryBlocks: number[]; valuesByAgent: Record<string, T[]> },
  fromBlock: number,
  toBlock: number,
): { boundaryBlocks: number[]; valuesByAgent: Record<string, T[]> } {
  const indices: number[] = [];
  let carried = -1;
  series.boundaryBlocks.forEach((block, i) => {
    if (block < fromBlock) carried = i;
    else if (block <= toBlock) indices.push(i);
  });
  // Only when the segment does not already start *on* a boundary. A roll that lands on one -- the
  // common case, since the check runs right after the boundary read -- already has its opening
  // value, and carrying another would hand the previous segment's last return to this one as well:
  // the same epoch scored twice, in two different segments.
  const startsOnBoundary = series.boundaryBlocks[indices[0]] === fromBlock;
  if (carried >= 0 && !startsOnBoundary) indices.unshift(carried);
  return {
    boundaryBlocks: indices.map((i) => series.boundaryBlocks[i]),
    valuesByAgent: Object.fromEntries(
      Object.entries(series.valuesByAgent).map(([id, values]) => [
        id,
        indices.map((i) => values[i]),
      ]),
    ),
  };
}
