// Every kind of episode the official regimes run, once a day, for the practice period.
//
// The period used to hold each kind once a *week*: six blocks of ten episodes, each block a sixth of
// the period (`windowFrac` is a fraction of the run). The standings rank each day's return (one
// segment = one epoch), so a week-based plan made the days unlike each other -- the day with the
// crash and the day without one are different tests -- and a participant who wanted to see how their
// agent handles a DAI depeg waited up to six days for one. One of each kind per day makes every
// day the same test, and the rehearsal (#148) ran the environment at five times that density with
// no failure of its own.
//
// `windowFrac` stays a fraction of the run, and the run is converted from `run.endsAt` when the
// coordinator starts, so the plan is written for a start time: slice k is the k-th 24 hours after
// it. Each slice keeps EDGE_MARGIN_HOURS clear at both ends, which is how far the actual start may
// miss the planned one and still leave every day with exactly one of each kind (the longest window
// is ~93 blocks, three minutes, so the margin is nothing to the placement). A final slice shorter than
// MIN_SLICE_HOURS gets no episodes: there is no room to place ten windows away from its edges.
//
// The magnitudes and shapes are the official regimes' (config/regimes/{crash,spike,cex-drift,
// informed-flow,whale,depeg,cdp-incident}.yaml), unchanged from the weekly plan.

export const EDGE_MARGIN_HOURS = 1.5;
export const MIN_SLICE_HOURS = 2 * EDGE_MARGIN_HOURS + 1;

type Episode = Record<string, unknown> & { type: string };

/** One day's episodes, without their window. `whaleVenue` alternates the second whale by day. */
export function dayTemplates(day: number): Episode[] {
  const whaleVenue = day % 2 === 0 ? "balancer" : "curve";
  return [
    {
      type: "crash",
      magnitudeRange: [0.15, 0.22],
      rampBlocks: 3,
      holdBlocks: 6,
      decayBlocks: 8,
    },
    {
      type: "liquidityPull",
      magnitudeRange: [0.4, 0.6],
      alignWith: "crash",
      rampBlocks: 3,
      holdBlocks: 6,
      decayBlocks: 12,
    },
    {
      type: "spike",
      magnitudeRange: [0.15, 0.22],
      rampBlocks: 3,
      holdBlocks: 6,
      decayBlocks: 8,
    },
    {
      type: "liquidityPull",
      magnitudeRange: [0.4, 0.6],
      alignWith: "spike",
      rampBlocks: 3,
      holdBlocks: 6,
      decayBlocks: 12,
    },
    {
      type: "cexDrift",
      magnitudeRange: [0.001, 0.002],
      kappaMultRange: [0.15, 0.3],
      rampBlocks: 6,
      holdBlocks: 24,
      decayBlocks: 12,
    },
    {
      type: "flowTrend",
      magnitudeRange: [2.0, 3.0],
      trendCorrelation: 1.0,
      persistBlocks: 12,
      rampBlocks: 6,
      holdBlocks: 30,
      decayBlocks: 10,
    },
    { type: "whale", magnitudeRange: [25, 60] },
    { type: "whale", magnitudeRange: [25, 60], venue: whaleVenue },
    {
      type: "depeg",
      stable: "DAI",
      magnitudeRange: [0.35, 0.6],
      rampBlocks: 12,
      holdBlocks: 36,
      decayBlocks: 45,
    },
    {
      type: "eusdDepeg",
      magnitudeRange: [0.4, 0.6],
      rampBlocks: 4,
      holdBlocks: 10,
      decayBlocks: 12,
    },
  ];
}

export const KINDS_PER_DAY = dayTemplates(0).length;

export type DayPlan = {
  day: number;
  fromHours: number;
  toHours: number;
  events: Episode[];
};

/**
 * The plan for a period of `hours`, cut into `segmentHours` slices from its start. Every episode's
 * `windowFrac` lies inside its slice, EDGE_MARGIN_HOURS clear of both ends.
 */
export function dailyEpisodePlan(hours: number, segmentHours = 24): DayPlan[] {
  if (!(hours > 0))
    throw new Error(`the period must have a positive length (got ${hours} h)`);
  if (!(segmentHours > 2 * EDGE_MARGIN_HOURS))
    throw new Error(
      `segmentHours ${segmentHours} leaves no room inside ${EDGE_MARGIN_HOURS} h margins`,
    );
  const plan: DayPlan[] = [];
  for (let day = 0; day * segmentHours < hours; day++) {
    const fromHours = day * segmentHours;
    const toHours = Math.min(hours, fromHours + segmentHours);
    if (toHours - fromHours < MIN_SLICE_HOURS) break;
    const lo = round6((fromHours + EDGE_MARGIN_HOURS) / hours);
    const hi = round6((toHours - EDGE_MARGIN_HOURS) / hours);
    plan.push({
      day,
      fromHours,
      toHours,
      events: dayTemplates(day).map((e) => withWindow(e, lo, hi)),
    });
  }
  return plan;
}

/** Where a running period is, read off its checkpoint (core/src/realtime/periodResume.ts). */
export type PeriodPosition = {
  runStartBlock: number;
  /** The run block the saved episodes' windowFrac are fractions of (stress.windowBaseBlocks). */
  windowBaseBlocks: number;
  /** Where the saved episodes end: the period's current end block, absolute. */
  endBlock: number;
  /** A block the chain was at, and when -- the projection's anchor. */
  atBlock: number;
  atMs: number;
  /** The day grid's origin: day k is [startedAt + k x segmentHours, + segmentHours). */
  startedAtMs: number;
  blockTimeSec: number;
};

/**
 * The episodes for the days an extension adds (periodResume.ts periodExtension): one of every kind
 * in each day-grid slice from where the saved episodes end to `endsAtMs`, EDGE_MARGIN_HOURS clear of
 * both ends of the slice (a slice cut short at either end the same way, and none under
 * MIN_SLICE_HOURS). Times become blocks at the cadence from the anchor -- not from the period's
 * start, which the chain has fallen behind by every hour it was stopped -- and blocks become
 * fractions of `windowBaseBlocks`, so the values run past 1.
 */
export function extensionEpisodePlan(
  pos: PeriodPosition,
  endsAtMs: number,
  segmentHours = 24,
): DayPlan[] {
  const hourMs = 3_600_000;
  const blockAt = (ms: number) =>
    pos.atBlock + (ms - pos.atMs) / 1000 / pos.blockTimeSec;
  const msAt = (block: number) =>
    pos.atMs + (block - pos.atBlock) * pos.blockTimeSec * 1000;
  const fromMs = Math.max(msAt(pos.endBlock), pos.atMs);
  if (!(endsAtMs > fromMs)) return [];
  const frac = (ms: number) =>
    round6((blockAt(ms) - pos.runStartBlock) / pos.windowBaseBlocks);
  const sliceMs = segmentHours * hourMs;
  const plan: DayPlan[] = [];
  const first = Math.floor((fromMs - pos.startedAtMs) / sliceMs);
  for (let day = first; pos.startedAtMs + day * sliceMs < endsAtMs; day++) {
    const from = Math.max(fromMs, pos.startedAtMs + day * sliceMs);
    const to = Math.min(endsAtMs, pos.startedAtMs + (day + 1) * sliceMs);
    if ((to - from) / hourMs < MIN_SLICE_HOURS) continue;
    const lo = frac(from + EDGE_MARGIN_HOURS * hourMs);
    const hi = frac(to - EDGE_MARGIN_HOURS * hourMs);
    plan.push({
      day,
      fromHours: round6((from - pos.startedAtMs) / hourMs),
      toHours: round6((to - pos.startedAtMs) / hourMs),
      events: dayTemplates(day).map((e) => withWindow(e, lo, hi)),
    });
  }
  return plan;
}

/**
 * Append event lines to the list under `stress:` / `events:`, after its last entry, and set
 * `stress.windowBaseBlocks`. Every line already there stays as it was: the saved episodes have to
 * be unchanged for the period to resume extended.
 */
export function appendStressEvents(
  text: string,
  eventLines: string[],
  windowBaseBlocks: number,
): string {
  const lines = text.split("\n");
  const stress = lines.findIndex((l) => l === "stress:");
  if (stress < 0) throw new Error("no top-level `stress:` in the config");
  const events = lines.findIndex((l, i) => i > stress && l === "  events:");
  if (events < 0) throw new Error("no `  events:` under `stress:`");
  let end = events + 1;
  while (end < lines.length && lines[end].startsWith("    ")) end++;
  const out = [...lines.slice(0, end), ...eventLines, ...lines.slice(end)];
  const base = `  windowBaseBlocks: ${windowBaseBlocks}`;
  const existing = out.findIndex(
    (l, i) => i > stress && /^ {2}windowBaseBlocks:/.test(l),
  );
  if (existing >= 0) out[existing] = base;
  else out.splice(stress + 1, 0, base);
  return out.join("\n");
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// `windowFrac` right after `type`/`magnitudeRange`, where the hand-written plan had it.
function withWindow(e: Episode, lo: number, hi: number): Episode {
  const { type, magnitudeRange, ...rest } = e;
  return { type, magnitudeRange, windowFrac: [lo, hi], ...rest };
}

/** YAML flow mappings, one event per line, with a `# day N` line before each day. */
export function renderEventLines(plan: DayPlan[], header: string[]): string[] {
  const lines = header.map((h) => `    # ${h}`);
  for (const d of plan) {
    lines.push(
      `    # day ${d.day + 1} (hours ${d.fromHours}-${d.toHours} of the period)`,
    );
    for (const e of d.events) lines.push(`    - ${flow(e)}`);
  }
  return lines;
}

function flow(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flow).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${flow(v)}`)
      .join(", ")} }`;
  return String(value);
}

/**
 * Replace the list under `stress:` / `events:` in a config's text, keeping every other line --
 * comments included -- as it was. The list is the run of lines indented four spaces (events and
 * their comments) that follows `  events:`.
 */
export function replaceStressEvents(
  text: string,
  eventLines: string[],
): string {
  const lines = text.split("\n");
  const stress = lines.findIndex((l) => l === "stress:");
  if (stress < 0) throw new Error("no top-level `stress:` in the config");
  const events = lines.findIndex((l, i) => i > stress && l === "  events:");
  if (events < 0) throw new Error("no `  events:` under `stress:`");
  let end = events + 1;
  while (end < lines.length && lines[end].startsWith("    ")) end++;
  return [
    ...lines.slice(0, events + 1),
    ...eventLines,
    ...lines.slice(end),
  ].join("\n");
}
