// Two runs started in the same millisecond must not share a directory (core/src/logger.ts
// claimRunDir).
//
// Run ids are the start time to the millisecond, and RunLogger's recursive mkdir reuses a directory
// that is already there. Observed 2026-10-22: two backtests side by side on one host named a run the
// same and both wrote into one runs/<runId>/ -- agent-view/<agent>/run-start.json included -- so one
// run's agents counted their blocks from the other's start. Nothing failed; the matrix looked complete.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { claimRunDir, RunLogger } from "../core/src/logger.js";
import { isRunIdSnapshot } from "../core/src/realtime/agentState.js";
import { SegmentedRun } from "../core/src/segments.js";

const tmp = mkdtempSync(join(tmpdir(), "run-dir-claim-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A run id the way the coordinator makes one: the start time with the punctuation replaced.
const ID = "2026-10-22T03-14-15-926Z";

let roots = 0;
const freshRoot = (): string => join(tmp, `runs-${roots++}`);

const eventsIn = (runDir: string): Array<Record<string, unknown>> =>
  readFileSync(join(runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("two runs started in the same millisecond get a directory each", () => {
  const root = freshRoot();
  const a = claimRunDir(root, ID);
  const b = claimRunDir(root, ID);
  assert.equal(a, ID, "the first run keeps the bare id");
  assert.equal(b, `${ID}-2`);

  // Each writes through its own logger and reads back only its own record.
  const la = new RunLogger(root, a);
  const lb = new RunLogger(root, b);
  assert.notEqual(la.runDir, lb.runDir);
  la.event({ type: "run_started_realtime", lane: "a" });
  lb.event({ type: "run_started_realtime", lane: "b" });
  assert.deepEqual(eventsIn(la.runDir).map((e) => e.lane), ["a"]);
  assert.deepEqual(eventsIn(lb.runDir).map((e) => e.lane), ["b"]);
});

test("a directory that is already there is never reused, empty or not", () => {
  const root = freshRoot();
  // What the other run has already written: its agents' record of where the run started.
  const view = join(root, ID, "agent-view", "agent-x");
  mkdirSync(view, { recursive: true });
  writeFileSync(join(view, "run-start.json"), '{"blockNumber":100}\n');
  // And a name another process has claimed but not written into yet.
  mkdirSync(join(root, `${ID}-2`));

  const id = claimRunDir(root, ID);
  assert.equal(id, `${ID}-3`);
  assert.deepEqual(readdirSync(join(root, id)), [], "the claimed directory starts empty");
  assert.equal(
    readFileSync(join(view, "run-start.json"), "utf8"),
    '{"blockNumber":100}\n',
    "the other run's files are untouched",
  );
});

test("separate processes racing for one name each get their own", async () => {
  const root = freshRoot();
  const logger = pathToFileURL(
    resolve(import.meta.dirname, "../core/src/logger.ts"),
  ).href;
  // Every child waits for the same instant before it claims, so the claims land together however
  // long each one took to start.
  const at = Date.now() + 2_000;
  const code =
    `const { claimRunDir } = await import(${JSON.stringify(logger)});\n` +
    `while (Date.now() < ${at}) {}\n` +
    `process.stdout.write(claimRunDir(${JSON.stringify(root)}, ${JSON.stringify(ID)}));\n`;
  const claim = (): Promise<string> =>
    new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", fail);
      child.on("close", (exit) =>
        exit === 0 ? done(out) : fail(new Error(`claim exited ${exit}`)),
      );
    });

  const ids = await Promise.all([claim(), claim(), claim(), claim()]);
  assert.equal(new Set(ids).size, ids.length, `claimed: ${ids.join(", ")}`);
  assert.deepEqual(readdirSync(root).sort(), [...ids].sort());
  assert.ok(ids.includes(ID), "one of them has the bare id");
});

test("only a taken name moves on to the next; any other failure is thrown as it is", () => {
  const root = freshRoot();
  // A missing parent is ENOENT, not "taken": walking through ninety-nine suffixes would hide it.
  assert.throws(() => claimRunDir(root, "no-such-parent/run"), { code: "ENOENT" });
});

test("the number of names tried is bounded", () => {
  const root = freshRoot();
  for (const id of [ID, `${ID}-2`, `${ID}-3`]) mkdirSync(join(root, id), { recursive: true });
  assert.throws(() => claimRunDir(root, ID, 3), /all taken/);
  assert.equal(claimRunDir(root, ID, 4), `${ID}-4`);
});

test("a resumed run reopens its own directory and keeps what is in it", () => {
  const root = freshRoot();
  const id = claimRunDir(root, ID);
  new RunLogger(root, id).event({ type: "run_started_realtime" });
  // The resume path (realtime/periodResume.ts) does not claim: it appends into the same directory.
  const resumed = new RunLogger(root, id, { append: true });
  resumed.event({ type: "period_resumed" });
  assert.equal(resumed.runDir, join(root, id));
  assert.deepEqual(
    eventsIn(resumed.runDir).map((e) => e.type),
    ["run_started_realtime", "period_resumed"],
  );
  assert.deepEqual(readdirSync(root), [id], "no second directory");
});

test("a claimed id opens as a segmented period's competition directory", () => {
  // The coordinator hands the claimed id to SegmentedRun (ADR 0021 §6), whose own mkdir finds the
  // directory already there and writes its segments inside it.
  const root = freshRoot();
  claimRunDir(root, ID);
  const id = claimRunDir(root, ID);
  const period = new SegmentedRun({
    root,
    competitionId: id,
    hours: 24,
    scenarioSet: id,
  });
  assert.equal(period.competitionDir, join(root, `${ID}-2`));
  assert.ok(period.runDir.startsWith(period.competitionDir + sep));
  assert.deepEqual(readdirSync(join(root, ID)), [], "the other period's directory is untouched");
});

test("a new backtest matrix directory is claimed the same way", () => {
  const runs = freshRoot();
  const base = `matrix-${ID}`;
  // Another backtest's matrix, already flushed once.
  mkdirSync(join(runs, base), { recursive: true });
  writeFileSync(join(runs, base, "matrix.json"), '{"schema":2}\n');

  const mine = claimRunDir(runs, base);
  const next = claimRunDir(runs, base);
  assert.deepEqual([mine, next], [`${base}-2`, `${base}-3`]);
  // infra/live-week/run-week.sh records the week's matrix by `find runs -name 'matrix-*'`.
  assert.ok(mine.startsWith("matrix-"));
  assert.equal(readFileSync(join(runs, base, "matrix.json"), "utf8"), '{"schema":2}\n');
});

test("a suffixed id still reads as a run id where run ids are matched", () => {
  // agentState prunes old epoch snapshots by recognising run-id names: a suffixed one must count,
  // or its snapshots would never be pruned.
  assert.equal(isRunIdSnapshot(`${ID}-2`), true);
});
