// What an agent writes to the host is held to a quota by the coordinator (issue #214 item 1).
//
// The runtime's own caps (state.ts, agentLog.ts) are self-limits a submitted runtime bypasses with
// one writeFileSync, and a host at ENOSPC takes the coordinator down. The rule is tested without a
// disk and the measurement without a coordinator.
import test from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentDiskWatch,
  agentLogFiles,
  diskVerdict,
  measureAgentDisk,
  STOPPED_GROWTH_SLACK_BYTES,
  type AgentDiskSample,
} from "../core/src/realtime/agentDisk.js";

const MiB = 1024 * 1024;
const quota = { stateBytes: 100 * MiB, logBytes: 10 * MiB };
const sample = (over: Partial<AgentDiskSample> = {}): AgentDiskSample => ({
  stateBytes: 0,
  logBytes: 0,
  ...over,
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eris-agent-disk-"));
}

test("diskVerdict: under the warning fraction is ok, over it warns, over the quota exceeds", () => {
  assert.equal(diskVerdict(sample({ stateBytes: 79 * MiB }), quota).level, "ok");
  const warn = diskVerdict(sample({ stateBytes: 81 * MiB }), quota);
  assert.equal(warn.level, "warning");
  assert.match(warn.findings[0], /state directory 81\.0 MiB at 81% of the 100\.0 MiB quota/);
  const over = diskVerdict(sample({ logBytes: 11 * MiB }), quota);
  assert.equal(over.level, "exceeded");
  assert.match(over.findings[0], /log files 11\.0 MiB over the 10\.0 MiB quota/);
  // Both places are reported when both are over; the level is the worse of the two.
  const both = diskVerdict(sample({ stateBytes: 90 * MiB, logBytes: 11 * MiB }), quota);
  assert.equal(both.level, "exceeded");
  assert.equal(both.findings.length, 2);
});

test("diskVerdict: no state directory and a zero quota are both 'nothing to check'", () => {
  assert.equal(diskVerdict(sample({ stateBytes: null }), quota).level, "ok");
  assert.equal(
    diskVerdict(sample({ stateBytes: 500 * MiB }), { ...quota, stateBytes: 0 }).level,
    "ok",
  );
});

test("diskVerdict: a truncated state walk is a warning even under the byte quota", () => {
  // More entries than the walk admits is more than the epoch-start snapshot admits, so the operator
  // hears it now rather than when the next epoch refuses the directory.
  const verdict = diskVerdict(
    sample({
      stateBytes: 1 * MiB,
      stateUsage: {
        apparentBytes: MiB,
        allocatedBytes: MiB,
        entries: 20_000,
        depth: 3,
        truncated: true,
        irregular: [],
        irregularCount: 0,
      },
    }),
    quota,
  );
  assert.equal(verdict.level, "warning");
  assert.match(verdict.findings[0], /walk stopped at 20000 entries/);
});

test("measureAgentDisk: counts the state tree and the log files, and a missing file as 0", () => {
  const run = tmp();
  mkdirSync(join(run, "agents"));
  const files = agentLogFiles(run, "venue-arb");
  assert.deepEqual(
    files.map((f) => f.slice(run.length)),
    ["/agents/venue-arb.jsonl", "/agents/venue-arb.llm.jsonl"],
  );
  writeFileSync(files[0], "x".repeat(1000));
  const state = tmp();
  mkdirSync(join(state, "sub"));
  writeFileSync(join(state, "versions.json"), "y".repeat(300));
  writeFileSync(join(state, "sub", "notes"), "z".repeat(200));
  const s = measureAgentDisk({ stateDir: state, logFiles: files });
  // The larger of apparent and allocated: 1,000 bytes apparent, one filesystem block allocated.
  assert.ok(s.logBytes >= 1000 && s.logBytes <= 64 * 1024, `logBytes ${s.logBytes}`);
  // Apparent 500 bytes; allocated is at least a block each on a real filesystem, and the quota is
  // held to the larger of the two.
  assert.ok((s.stateBytes ?? 0) >= 500);
  assert.equal(s.stateUsage?.entries, 3);
  assert.equal(measureAgentDisk({ logFiles: files }).stateBytes, null);
});

test("measureAgentDisk: a sparse file counts at its apparent size", () => {
  const state = tmp();
  const fd = openSync(join(state, "big"), "w");
  ftruncateSync(fd, 8 * MiB);
  closeSync(fd);
  const s = measureAgentDisk({ stateDir: state, logFiles: [] });
  assert.equal(s.stateBytes, 8 * MiB);
});

test("AgentDiskWatch: a warning is one event per crossing, and an exceeded agent is reported once", () => {
  const bytes = new Map<string, number>([["a", 0], ["b", 0]]);
  const watch = new AgentDiskWatch(quota, (t) =>
    sample({ stateBytes: bytes.get(t.id) ?? 0 }),
  );
  const targets = [
    { id: "a", logFiles: [] },
    { id: "b", logFiles: [] },
  ];
  const reports = () =>
    watch.tick(targets).outcomes.map((o) => `${o.id}:${o.report}`);
  assert.deepEqual(reports(), ["a:none", "b:none"]);
  bytes.set("a", 85 * MiB);
  assert.deepEqual(reports(), ["a:warning", "b:none"]);
  // Still over the fraction: not reported again.
  assert.deepEqual(reports(), ["a:none", "b:none"]);
  // Back under, then over again: reported again, because it is a new crossing.
  bytes.set("a", 10 * MiB);
  assert.deepEqual(reports(), ["a:none", "b:none"]);
  bytes.set("a", 85 * MiB);
  assert.deepEqual(reports(), ["a:warning", "b:none"]);
  // Past the quota: reported once. It stays in the rotation (issue #223) and is silent while its
  // files are not growing -- "stopped" is read back, not assumed.
  bytes.set("b", 101 * MiB);
  assert.deepEqual(reports(), ["a:none", "b:exceeded"]);
  assert.deepEqual(reports(), ["a:none", "b:none"]);
});

test("AgentDiskWatch: one tick measures what its budget allows, and the next resumes (issue #223)", () => {
  // DISK_WALK_LIMITS *admits* 20,000 entries and diskVerdict only warns about a truncated walk, so an
  // agent sitting on 20,001 one-byte files is walked in full on every tick for the rest of the run.
  // Measured 2026-10-03: 101 ms a walk (245 ms on the reviewer's box), so 32 agents of that shape was
  // 3-8 s of synchronous work inside a loop that owes the chain a block every two seconds.
  const targets = Array.from({ length: 32 }, (_, i) => ({
    id: `a${i}`,
    logFiles: [],
  }));
  let clock = 0;
  const watch = new AgentDiskWatch(
    quota,
    () => {
      clock += 101;
      return sample({ stateBytes: MiB });
    },
    { budgetMs: 200, now: () => clock },
  );
  const first = watch.tick(targets);
  assert.equal(first.rotation, 32);
  assert.deepEqual(
    first.outcomes.map((o) => o.id),
    ["a0", "a1"],
  );
  assert.ok(
    first.elapsedMs <= 200 + 101,
    `a tick cost ${first.elapsedMs} ms: the budget plus the one walk that overran it is the bound`,
  );
  assert.equal(first.sweep, undefined, "a pass over this field is not one tick");
  // The next tick continues where this one stopped rather than starting the field over.
  assert.deepEqual(
    watch.tick(targets).outcomes.map((o) => o.id),
    ["a2", "a3"],
  );
  let ticks = 2;
  for (;;) {
    const tick = watch.tick(targets);
    ticks++;
    if (tick.sweep !== undefined) {
      assert.equal(tick.sweep.ticks, 16, "the pass is reported with its own length");
      break;
    }
    assert.ok(ticks < 64, "the pass never closed");
  }
  assert.equal(ticks, 16, "32 agents at 2 a tick");
});

test("AgentDiskWatch: an honest field is still swept in a single tick", () => {
  // The budget must not slow the ordinary case down: a quota is noticed as fast as it was before.
  let clock = 0;
  const watch = new AgentDiskWatch(
    quota,
    () => {
      clock += 1;
      return sample();
    },
    { budgetMs: 200, now: () => clock },
  );
  const tick = watch.tick(
    Array.from({ length: 32 }, (_, i) => ({ id: `a${i}`, logFiles: [] })),
  );
  assert.equal(tick.outcomes.length, 32);
  assert.deepEqual(tick.sweep, { ticks: 1 });
});

test("AgentDiskWatch: two real expensive directories are split across ticks (issue #223)", () => {
  // The same thing off a real disk and a real clock, so the budget is held against the measurement
  // this actually guards and not only against an injected one.
  const dirs = [tmp(), tmp()];
  for (const dir of dirs)
    for (let i = 0; i < 2_000; i++) writeFileSync(join(dir, `f${i}`), "x");
  const targets = dirs.map((stateDir, i) => ({
    id: `a${i}`,
    stateDir,
    logFiles: [],
  }));
  const watch = new AgentDiskWatch(quota, undefined, { budgetMs: 1 });
  const first = watch.tick(targets);
  assert.deepEqual(
    first.outcomes.map((o) => o.id),
    ["a0"],
  );
  assert.equal(first.outcomes[0].sample.stateUsage?.entries, 2_000);
  const second = watch.tick(targets);
  assert.deepEqual(
    second.outcomes.map((o) => o.id),
    ["a1"],
  );
  assert.deepEqual(second.sweep, { ticks: 2 });
});

test("AgentDiskWatch: a stopped agent that keeps writing is reported, not forgotten (issue #223)", () => {
  // close() reaches the process the coordinator spawned. Under the docker sandbox that is the
  // `docker run` client, and the container outlives it -- so a runtime holding SIGTERM keeps writing
  // to the disk the quota exists to protect. Before this the id was dropped from the rotation at the
  // moment it was stopped, and nothing looked at that directory again.
  let bytes = 101 * MiB;
  const watch = new AgentDiskWatch(quota, () => sample({ stateBytes: bytes }));
  const targets = [{ id: "b", logFiles: [] }];
  const report = () => watch.tick(targets).outcomes[0];
  assert.equal(report().report, "exceeded");
  // A last flush from a runtime that did stop is not a container that outlived its stop.
  bytes += STOPPED_GROWTH_SLACK_BYTES - 1;
  assert.equal(report().report, "none");
  bytes += 40 * MiB;
  const growing = report();
  assert.equal(growing.report, "still-writing");
  assert.ok(
    (growing.grewBytes ?? 0) >= 40 * MiB,
    `grew ${growing.grewBytes} bytes`,
  );
  // Re-based: the next report is about growth since this one, not since the stop.
  assert.equal(report().report, "none");
  bytes += 40 * MiB;
  assert.equal(report().report, "still-writing");
});
