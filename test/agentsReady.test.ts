// Issue #94: the epoch clock waits for the field. The chain-facing half (no block is produced
// while the coordinator waits) is a property of where the wait sits in coordinator.ts; what is
// checked here is the wait itself -- that it reads the runtime's own `runtime_start` line, that a
// process which died is not waited for, that the bound holds, and that the report says who was
// what.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentLogHasRuntimeStart,
  agentLogPath,
  waitForAgentsReady,
} from "../core/src/realtime/agentsReady.js";

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-agents-ready-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  return dir;
}

// The shape runtime/bot.ts writes through agentLog.ts: one JSON object per line, `event` on the
// mempool self-reports, `runtime_start` once the preflight passed and the block watcher is armed.
const preflightLine = (id: string): string =>
  JSON.stringify({ ts: "t", agentId: id, event: "preflight", ok: true }) + "\n";
const startLine = (id: string): string =>
  JSON.stringify({
    ts: "t",
    agentId: id,
    event: "runtime_start",
    mode: "decide",
    address: "0x1",
  }) + "\n";

test("agentLogHasRuntimeStart reads the runtime's line and nothing that merely mentions it", () => {
  const dir = runDir();
  const file = agentLogPath(dir, "a");
  assert.equal(agentLogHasRuntimeStart(file), false, "no file yet");
  writeFileSync(file, preflightLine("a"));
  assert.equal(agentLogHasRuntimeStart(file), false, "preflight only");
  // An error line quoting the word is not the event.
  appendFileSync(
    file,
    JSON.stringify({ event: "submit_failed", error: "runtime_start missing" }) +
      "\n",
  );
  assert.equal(agentLogHasRuntimeStart(file), false, "a mention is not the event");
  // A partial last line (the agent mid-write) is skipped, not a crash.
  appendFileSync(file, '{"event":"runtime_start"');
  assert.equal(agentLogHasRuntimeStart(file), false, "partial line");
  appendFileSync(file, ",\"mode\":\"decide\"}\n");
  assert.equal(agentLogHasRuntimeStart(file), true);
});

test("waits until every launched agent has written runtime_start, and measures from the spawn", async () => {
  const dir = runDir();
  let t = 1_000;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
    // b comes up at +300 ms, a at +800 ms.
    if (t >= 1_300 && t < 1_800) writeFileSync(agentLogPath(dir, "b"), startLine("b"));
    if (t >= 1_800) writeFileSync(agentLogPath(dir, "a"), preflightLine("a") + startLine("a"));
  };
  const report = await waitForAgentsReady({
    agents: [
      { id: "a", isAlive: () => true },
      { id: "b", isAlive: () => true },
    ],
    runDir: dir,
    spawnedAt: 500,
    timeoutMs: 60_000,
    pollMs: 100,
    now,
    sleep,
  });
  assert.equal(report.timedOut, false);
  assert.deepEqual(report.late, []);
  assert.deepEqual(report.exited, []);
  assert.deepEqual(
    report.ready.map((r) => r.id).sort(),
    ["a", "b"],
  );
  const byId = Object.fromEntries(report.ready.map((r) => [r.id, r.afterMs]));
  // afterMs is spawn-relative (spawnedAt 500): b seen at t=1300 -> 800, a at t=1800 -> 1300.
  assert.equal(byId.b, 800);
  assert.equal(byId.a, 1300);
  assert.equal(report.waitedMs, 800);
  // The wait released as soon as the last one was ready, well inside the bound.
  assert.ok(report.waitedMs < report.timeoutMs);
});

test("a process that exited is not waited for, and one that wrote its line before dying counts as ready", async () => {
  const dir = runDir();
  writeFileSync(agentLogPath(dir, "wrote-then-died"), startLine("wrote-then-died"));
  let t = 0;
  const report = await waitForAgentsReady({
    agents: [
      // Preflight refused (exit 1) before writing anything.
      { id: "refused", isAlive: () => false },
      { id: "wrote-then-died", isAlive: () => false },
      { id: "up", isAlive: () => true },
    ],
    runDir: dir,
    spawnedAt: 0,
    timeoutMs: 10_000,
    pollMs: 100,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (t >= 200) writeFileSync(agentLogPath(dir, "up"), startLine("up"));
    },
  });
  assert.equal(report.timedOut, false);
  assert.deepEqual(report.exited, ["refused"]);
  assert.deepEqual(report.ready.map((r) => r.id).sort(), ["up", "wrote-then-died"]);
  assert.deepEqual(report.late, []);
  // Released at the first poll that saw `up`, not held for `refused`.
  assert.equal(report.waitedMs, 200);
});

test("the bound holds: whoever is still booting is late, and the clock is not held past it", async () => {
  const dir = runDir();
  writeFileSync(agentLogPath(dir, "fast"), startLine("fast"));
  let t = 0;
  let sleeps = 0;
  const report = await waitForAgentsReady({
    agents: [
      { id: "fast", isAlive: () => true },
      { id: "slow", isAlive: () => true },
    ],
    runDir: dir,
    spawnedAt: 0,
    timeoutMs: 1_000,
    pollMs: 300,
    now: () => t,
    sleep: async (ms) => {
      sleeps++;
      // The last sleep is clipped to the deadline rather than overshooting it.
      assert.ok(ms <= 300);
      t += ms;
    },
  });
  assert.equal(report.timedOut, true);
  assert.deepEqual(report.late, ["slow"]);
  assert.deepEqual(report.ready.map((r) => r.id), ["fast"]);
  assert.equal(report.waitedMs, 1_000);
  assert.equal(report.timeoutMs, 1_000);
  assert.equal(sleeps, 4, "300 + 300 + 300 + 100");
});

test("nothing to wait for returns at once", async () => {
  const dir = runDir();
  const report = await waitForAgentsReady({
    agents: [],
    runDir: dir,
    spawnedAt: 0,
    timeoutMs: 60_000,
    now: () => 0,
    sleep: async () => {
      assert.fail("must not sleep with no agents");
    },
  });
  assert.equal(report.waitedMs, 0);
  assert.equal(report.timedOut, false);
});
