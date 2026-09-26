// Evidence of executed schedule entries, separate from the schedule's intended windows (#118 M).
import { stressEnvelope, type ResolvedStressEvent } from "./events.js";

type Evidence = {
  stage: "price_submitted" | "storage_written" | "flow_context_queued" | "tx_submitted" | "applied";
  hashes?: string[];
  priceBefore?: number;
  unoverlaidPrice?: number;
  fairPrice?: number;
  overlayMultiplier?: number;
  realizedMagnitude?: number;
  driftAdd?: number;
  kappaMult?: number;
  sizeMult?: number;
};

export class StressAudit {
  private readonly seen = new Map<number, {
    applications: number; firstBlock: number; lastBlock: number; peakMagnitude?: number;
  }>();

  constructor(
    private readonly events: readonly ResolvedStressEvent[],
    private readonly emit: (event: Record<string, unknown>) => void,
  ) {}

  record(event: ResolvedStressEvent, blockIndex: number, blockNumber: number, evidence: Evidence): void {
    const eventIndex = this.events.indexOf(event);
    if (eventIndex < 0) throw new Error("stress audit received an event outside its schedule");
    const previous = this.seen.get(eventIndex);
    this.seen.set(eventIndex, {
      applications: (previous?.applications ?? 0) + 1,
      firstBlock: previous?.firstBlock ?? blockNumber,
      lastBlock: blockNumber,
      ...(evidence.realizedMagnitude !== undefined ? {
        peakMagnitude: Math.max(previous?.peakMagnitude ?? 0, Math.abs(evidence.realizedMagnitude)),
      } : previous?.peakMagnitude !== undefined ? { peakMagnitude: previous.peakMagnitude } : {}),
    });
    this.emit({
      type: "stress_event_applied", eventIndex, eventType: event.type, base: event.base,
      ...(event.stable ? { stable: event.stable } : {}),
      blockIndex, blockNumber, ...evidence,
    });
  }

  active(
    blockIndex: number,
    accept: (event: ResolvedStressEvent) => boolean,
  ): ResolvedStressEvent[] {
    // Inside the window only: a shock that recovered part of its gap leaves a residual on every
    // block after it (recoverFrac), and that is the price the run now has, not an application.
    return this.events.filter(event => accept(event) && blockIndex < event.endBlock &&
      stressEnvelope(event, blockIndex) > 0);
  }

  price(
    base: string, blockIndex: number, blockNumber: number,
    prices: { before: number; unoverlaid: number; fair: number },
    publication: { stage: "price_submitted" | "storage_written"; hashes?: string[] },
  ): void {
    for (const event of this.active(blockIndex, e => e.base === base &&
      (e.type === "crash" || e.type === "spike" || e.type === "cexDrift"))) {
      const magnitude = event.magnitude * stressEnvelope(event, blockIndex);
      this.record(event, blockIndex, blockNumber, {
        ...publication, priceBefore: prices.before, unoverlaidPrice: prices.unoverlaid, fairPrice: prices.fair,
        ...(event.type === "cexDrift" ? {
          // The total price move also contains OU noise and any overlapping overlays. This is
          // the actual drift input, not an attribution of all of that movement to this event.
          driftAdd: (event.side === "sell" ? -1 : 1) * magnitude,
          kappaMult: 1 + ((event.kappaMult ?? 1) - 1) * stressEnvelope(event, blockIndex),
        } : {
          realizedMagnitude: magnitude,
          overlayMultiplier: 1 + (event.type === "crash" ? -1 : 1) * magnitude,
        }),
      });
    }
  }

  summaries(): Record<string, unknown>[] {
    return this.events.map((event, eventIndex) => {
      const observed = this.seen.get(eventIndex);
      const belowPeak = observed?.peakMagnitude !== undefined &&
        observed.peakMagnitude + 1e-12 < event.magnitude;
      return {
        eventIndex, eventType: event.type, base: event.base,
        startBlock: event.startBlock, endBlock: event.endBlock,
        configuredMagnitude: event.magnitude,
        status: !observed ? "not_observed" : belowPeak ? "partial" : "observed",
        applications: observed?.applications ?? 0,
        ...(observed ? {
          firstBlock: observed.firstBlock, lastBlock: observed.lastBlock,
          ...(observed.peakMagnitude !== undefined ? { peakMagnitude: observed.peakMagnitude } : {}),
        } : {}),
      };
    });
  }

  finish(): void {
    for (const summary of this.summaries()) {
      this.emit({ type: "stress_event_summary", ...summary });
      if (summary.status !== "observed") this.emit({
        type: "stress_application_warning", ...summary,
        reason: summary.status === "not_observed"
          ? "scheduled event has no application evidence; its window may have been skipped or execution failed"
          : "price overlay did not reach its configured peak in the published updates",
      });
    }
  }
}
