// Following the plan's timetable (`backtest --follow-schedule`, ADR 0026).
//
// `npm run competition -- plan … --starts-at <ISO> (--every-minutes <N> | --ends-at <ISO>)` stamps
// every epoch with the time the operator intends to start it. The runner used to copy those times
// into matrix.json for the dashboard's "next epoch starts at" and then run the epochs back to back,
// so a 60-epoch plan spread over the live week ran all 60 in its first half-day and left the
// dashboard pointing at starts in the past for the other six days. With --follow-schedule the
// runner waits for each epoch's start instead, and one unattended process runs the week.
//
// What the runner does before an epoch is a function of the planned start and the clock, and it is
// kept here so it can be tested without either:
//
//   the start is ahead   wait until it, then start
//   the start has passed start now, and say how late (the previous epoch overran its slot, or a
//                        --resume is catching up after a stop). Nothing is re-flowed: a late epoch
//                        does not push the ones after it, each still waits for its own time
//
// A --resume composes with it unchanged: the runner skips a complete epoch before it looks at the
// clock, so only the epochs it will actually run are waited for.
import { setLongTimeout } from "../realtime/longTimeout.js";

export type TimedEpoch = { s: number; startsAt?: string };

/**
 * Refuse a plan the runner cannot follow, before anvil starts. Every epoch needs a start -- one
 * without would run straight after the one before it, which is not what a timetable says -- and
 * the starts have to be in the order the runner takes the epochs (list order), or one listed
 * before an earlier time would hold every epoch after it back.
 */
export function assertFollowable(epochs: ReadonlyArray<TimedEpoch>): void {
  const untimed = epochs.filter((e) => e.startsAt === undefined).map((e) => e.s);
  if (untimed.length === epochs.length)
    throw new Error(
      "--follow-schedule: the scenario set has no timetable. Generate the plan with " +
        "`npm run competition -- plan … --starts-at <ISO 8601> (--every-minutes <N> | --ends-at <ISO 8601>)`",
    );
  if (untimed.length > 0)
    throw new Error(
      `--follow-schedule: every epoch needs a startsAt; s=${untimed.join(",")} ha${untimed.length === 1 ? "s" : "ve"} none`,
    );
  let previous: { s: number; at: number } | undefined;
  for (const e of epochs) {
    const at = Date.parse(e.startsAt as string);
    if (Number.isNaN(at))
      throw new Error(`--follow-schedule: s=${e.s} startsAt is not a date: ${e.startsAt}`);
    if (previous && at < previous.at)
      throw new Error(
        `--follow-schedule: s=${e.s} starts at ${e.startsAt}, before s=${previous.s} listed ahead ` +
          "of it. The runner takes the epochs in list order, so the starts have to be in that order too",
      );
    previous = { s: e.s, at };
  }
}

/**
 * How long to wait before an epoch planned for `startsAt`, or how late it already is. Exactly one of
 * the two is positive, or both are 0 when the clock is on the planned millisecond.
 */
export function startDelay(
  startsAt: string,
  nowMs: number,
): { waitMs: number; lateMs: number } {
  const at = Date.parse(startsAt);
  if (Number.isNaN(at)) throw new Error(`startsAt is not a date: ${startsAt}`);
  return { waitMs: Math.max(0, at - nowMs), lateMs: Math.max(0, nowMs - at) };
}

/** "2d 3h 04m", "2h 48m", "12m 05s", "7s": whole seconds, the two largest units. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** A late start under this is "on time": the wake-up from a wait lands a few ms past the mark. */
export const ON_TIME_MS = 1_000;

/**
 * The line the runner prints before an epoch under --follow-schedule, or undefined when it starts on
 * time with nothing to say.
 */
export function describeStart(
  epoch: { s: number; label: string; startsAt: string },
  nowMs: number,
): string | undefined {
  const { waitMs, lateMs } = startDelay(epoch.startsAt, nowMs);
  if (waitMs > 0)
    return (
      `s=${epoch.s} ${epoch.label}: waiting ${formatDuration(waitMs)} for its planned start ` +
      `${epoch.startsAt} (--follow-schedule)`
    );
  if (lateMs >= ON_TIME_MS)
    return (
      `s=${epoch.s} ${epoch.label}: planned for ${epoch.startsAt}, starting now, ` +
      `${formatDuration(lateMs)} late`
    );
  return undefined;
}

/** Resolve after `ms`. Chained timers, so a plan started more than 24.8 days ahead still waits. */
export function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    setLongTimeout(resolve, ms);
  });
}
