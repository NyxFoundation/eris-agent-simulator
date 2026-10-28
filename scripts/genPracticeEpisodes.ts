// `npm run gen:practice-episodes` -- write the practice period's episodes, one of every kind per day
// (core/src/practiceEpisodes.ts has why).
//
//   npm run gen:practice-episodes -- --start 2026-10-01T10:00:00+09:00   the period from that start to run.endsAt
//   npm run gen:practice-episodes -- --hours 26                           a rehearsal of that length
//   npm run gen:practice-episodes -- --extend runs/<period>/resume/state.json
//                                                  append the days a later run.endsAt adds to a running period
//   [--config config/practice.yaml] [--print]
//
// Run it for the start the coordinator is about to have: `windowFrac` is a fraction of the run and
// the run is measured from the moment the coordinator starts, so a plan written for 10:00 and started
// at 11:00 is an hour off everywhere. Up to EDGE_MARGIN_HOURS off still leaves every day with exactly
// one of each kind.
//
// --extend is for a period that is already running and whose run.endsAt the config now moves later
// (core/src/realtime/periodResume.ts, "extending a period"). It keeps every episode line as it is,
// appends the added days', and sets stress.windowBaseBlocks. The checkpoint (copy it off the box:
// runs/<period>/resume/state.json) says where the chain is and when, which is what the new windows
// are placed from: the chain is behind the wall clock by every hour it was stopped.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  appendStressEvents,
  dailyEpisodePlan,
  EDGE_MARGIN_HOURS,
  extensionEpisodePlan,
  KINDS_PER_DAY,
  renderEventLines,
  replaceStressEvents,
} from "../core/src/practiceEpisodes.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? "");
}

const path = flag("config") ?? "config/practice.yaml";
const text = readFileSync(path, "utf8");
const run = ((parse(text) as { run?: Record<string, unknown> }).run ??
  {}) as Record<string, unknown>;
const segmentHours = Number(run.segmentHours ?? 24);

const extendFlag = flag("extend");
if (extendFlag !== undefined) {
  const statePath =
    existsSync(extendFlag) && statSync(extendFlag).isDirectory()
      ? join(extendFlag, "resume", "state.json")
      : extendFlag;
  const cp = JSON.parse(readFileSync(statePath, "utf8")) as {
    runStartBlock: number;
    runBlocks: number;
    lastProcessedBlock: number;
    writtenAt: string;
    runStartedAtMs: number;
    world: Record<string, unknown>;
  };
  const endsAt = run.endsAt;
  if (typeof endsAt !== "string")
    throw new Error(`${path} has no run.endsAt: an extension moves the period's end date`);
  const savedEndsAt = cp.world.runEndsAt;
  if (typeof savedEndsAt !== "string" || !(Date.parse(endsAt) > Date.parse(savedEndsAt)))
    throw new Error(
      `run.endsAt ${endsAt} is not later than the period's (${String(savedEndsAt)}): set the new end in ${path} first`,
    );
  const windowBaseBlocks =
    typeof cp.world.stressWindowBaseBlocks === "number"
      ? cp.world.stressWindowBaseBlocks
      : cp.runBlocks;
  const blockTimeSec = Number(run.blockTimeSec ?? 2);
  const plan = extensionEpisodePlan(
    {
      runStartBlock: cp.runStartBlock,
      windowBaseBlocks,
      endBlock: cp.runStartBlock + cp.runBlocks,
      atBlock: cp.lastProcessedBlock,
      atMs: Date.parse(cp.writtenAt),
      startedAtMs: cp.runStartedAtMs,
      blockTimeSec,
    },
    Date.parse(endsAt),
    segmentHours,
  );
  const lines = renderEventLines(plan, [
    `Appended by \`npm run gen:practice-episodes -- --extend\` for the extension to ${endsAt}: the period was at`,
    `block ${cp.lastProcessedBlock} at ${cp.writtenAt}, its episodes ended at block ${cp.runStartBlock + cp.runBlocks}.`,
    `windowFrac below is a fraction of stress.windowBaseBlocks (${windowBaseBlocks}), not of the run.`,
  ]);
  const out = appendStressEvents(text, lines, windowBaseBlocks);
  if (process.argv.includes("--print")) process.stdout.write(out);
  else writeFileSync(path, out);
  console.error(
    `[gen:practice-episodes] ${path}: appended ${plan.length} day(s) x ${KINDS_PER_DAY} episodes ` +
      `(day ${(plan[0]?.day ?? 0) + 1}-${(plan.at(-1)?.day ?? 0) + 1}), stress.windowBaseBlocks ${windowBaseBlocks}`,
  );
  process.exit(0);
}

let hours: number;
let basis: string;
const hoursFlag = flag("hours");
if (hoursFlag !== undefined) {
  hours = Number(hoursFlag);
  basis = `a run of ${hours} h (--hours)`;
} else {
  const endsAt = run.endsAt;
  if (typeof endsAt !== "string")
    throw new Error(
      `${path} has no run.endsAt; pass --hours for a run stated in blocks`,
    );
  const startFlag = flag("start");
  if (!startFlag)
    throw new Error(
      "pass --start <ISO 8601 with a time zone>: the moment the coordinator will start",
    );
  const start = Date.parse(startFlag);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end))
    throw new Error(
      `cannot read --start ${startFlag} / run.endsAt ${endsAt} as dates`,
    );
  hours = (end - start) / 3_600_000;
  basis = `a start at ${startFlag}, run.endsAt ${endsAt} (${hours.toFixed(2)} h)`;
}

const plan = dailyEpisodePlan(hours, segmentHours);
const header = [
  `Generated by \`npm run gen:practice-episodes\` for ${basis}.`,
  `${plan.length} day(s) x ${KINDS_PER_DAY} episodes. Edit core/src/practiceEpisodes.ts, not these lines;`,
  `start the coordinator within ${EDGE_MARGIN_HOURS} h of the start above, or regenerate.`,
];
const out = replaceStressEvents(text, renderEventLines(plan, header));
if (process.argv.includes("--print")) {
  process.stdout.write(out);
} else {
  writeFileSync(path, out);
  console.error(
    `[gen:practice-episodes] ${path}: ${plan.length} day(s) x ${KINDS_PER_DAY} episodes for ${basis}`,
  );
}
