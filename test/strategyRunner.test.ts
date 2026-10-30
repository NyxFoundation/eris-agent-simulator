import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "@eris/sdk/config.js";
import type { AgentLogEntry } from "@eris/sdk/agent.js";
import type { AgentObservation } from "@eris/sdk/types.js";
import { StrategyRunner } from "../example/agents/runtime/strategyRunner.js";
import { DecideTimeoutError } from "../example/agents/runtime/decideTimeout.js";

const workerContext = {
  agentId: "worker-test",
  address: "0x0000000000000000000000000000000000000001" as const,
  config: loadConfig(),
  rpcUrl: "http://127.0.0.1:1",
};
const obs = (round: number) =>
  ({
    round,
    runId: "worker-test",
    nested: { amount: 123n },
  }) as unknown as AgentObservation;

function fixture(
  t: test.TestContext,
  source: string,
  timeoutMs = 100,
  // The module-load bound is its own number (issue #100); tests that exercise it pass one.
  startupTimeoutMs = 5000,
) {
  const dir = mkdtempSync(join(tmpdir(), "eris-worker-"));
  const path = join(dir, "agent.ts");
  writeFileSync(path, source);
  const logs: AgentLogEntry[] = [];
  const runner = new StrategyRunner(
    { kind: "module", path },
    workerContext,
    (entry) => logs.push(entry),
    timeoutMs,
    startupTimeoutMs,
  );
  t.after(async () => {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { runner, logs };
}

test("worker loads TS imports, preserves module state and clones bigint observations", async (t) => {
  const { runner } = fixture(
    t,
    `
    import { basename } from 'node:path';
    let count = 0;
    export const config = { intervalMs: 250, offsetMs: 25 };
    export function decide(obs, ctx) {
      return { type: 'noop', count: ++count, value: obs.nested.amount,
        wallet: 'walletClient' in ctx, latest: ctx.latestObservation().round, name: basename('/x/agent') };
    }
  `,
  );
  assert.deepEqual(await runner.start(), {
    mode: "decide",
    config: { intervalMs: 250, offsetMs: 25 },
  });
  assert.deepEqual((await runner.decide(obs(1))).action, {
    type: "noop",
    count: 1,
    value: 123n,
    wallet: false,
    latest: 1,
    name: "agent",
  });
  assert.equal(
    ((await runner.decide(obs(2))).action as { count: number }).count,
    2,
  );
});

for (const body of ["while (true) {}", "await new Promise(() => {})"]) {
  test(
    `a stuck shipped decision (${body}) leaves the parent alive and recovers next block`,
    { timeout: 15_000 },
    async (t) => {
      const { runner, logs } = fixture(
        t,
        `export async function decide(obs, ctx) {
      if (obs.round === 1) {
        ctx.log({ round: obs.round, reason: 'before timeout' });
        ctx.submit({ type: 'rawTx', tx: { to: ctx.address, data: '0x' } });
        ${body}
      }
      return { type: 'noop', reason: 'next block' };
    }`,
      );
      await runner.start();
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      try {
        await assert.rejects(
          runner.decide(obs(1)),
          (e: unknown) =>
            e instanceof DecideTimeoutError &&
            /^decide timeout:.*block 1 is no action/.test(e.message),
        );
      } finally {
        clearInterval(timer);
      }
      assert.ok(ticks > 0, "parent timers continue while strategy is stuck");
      assert.deepEqual(logs, [{ round: 1, reason: "before timeout" }]);
      assert.deepEqual(await runner.decide(obs(2)), {
        action: { type: "noop", reason: "next block" },
        submitted: [],
      });
    },
  );
}

test(
  "an installed looping revision survives worker replacement; another revision can recover a stuck call",
  { timeout: 15_000 },
  async (t) => {
    const { runner } = fixture(
      t,
      `export function decide() { return { type: 'noop', reason: 'shipped' }; }`,
    );
    await runner.start();
    runner.setSource({
      kind: "executor",
      source: `if (obs.round === 1) { while (true) {} } return { type: 'noop', reason: 'revision 1' };`,
    });
    await assert.rejects(runner.decide(obs(1)), DecideTimeoutError);
    assert.deepEqual((await runner.decide(obs(2))).action, {
      type: "noop",
      reason: "revision 1",
    });
    const stuck = runner.decide(obs(1));
    const rejection = assert.rejects(stuck, DecideTimeoutError);
    runner.setSource({
      kind: "executor",
      source: `return { type: 'noop', reason: 'revision 2' };`,
    });
    await rejection;
    assert.deepEqual((await runner.decide(obs(3))).action, {
      type: "noop",
      reason: "revision 2",
    });
  },
);

test("submissions and logs from a completed decision cannot leak into a later one", async (t) => {
  const { runner, logs } = fixture(
    t,
    `export async function decide(obs, ctx) {
    if (obs.round === 1) {
      ctx.submit({ type: 'noop', reason: 'on time' });
      setTimeout(() => {
        ctx.submit({ type: 'noop', reason: 'late' });
        ctx.log({ reason: 'late' });
      }, 40);
    } else await new Promise(resolve => setTimeout(resolve, 80));
    return { type: 'noop' };
  }`,
    1000,
  );
  assert.deepEqual((await runner.decide(obs(1))).submitted, [
    { type: "noop", reason: "on time" },
  ]);
  assert.deepEqual((await runner.decide(obs(2))).submitted, []);
  assert.deepEqual(logs, []);
});

for (const body of [
  "throw new Error('strategy bug')",
  "process.exit(0)",
  "return { bad: () => {} }",
]) {
  test(`worker failure is reported and the next decision remains available: ${body}`, async (t) => {
    const { runner } = fixture(
      t,
      `export function decide(obs, ctx) {
      if (obs.round === 1) { ctx.submit({type: 'noop'}); ${body}; }
      return { type: 'noop', reason: 'recovered' };
    }`,
    );
    await assert.rejects(
      runner.decide(obs(1)),
      /strategy bug|exited with code|could not be cloned/,
    );
    assert.deepEqual(await runner.decide(obs(2)), {
      action: { type: "noop", reason: "recovered" },
      submitted: [],
    });
  });
}

test("closing an outstanding call rejects it without leaving a worker running", async (t) => {
  const { runner } = fixture(
    t,
    `export async function decide() { await new Promise(() => {}); }`,
    5000,
  );
  await runner.start();
  const pending = assert.rejects(runner.decide(obs(1)), /disposed/);
  await delay(20);
  await runner.close();
  await pending;
  await assert.rejects(runner.decide(obs(2)), /closed/);
});

test("run(ctx) metadata remains available without executing the self-driven loop", async (t) => {
  const { runner } = fixture(
    t,
    `export function run() { throw new Error('must not run during discovery'); }`,
  );
  assert.deepEqual(await runner.start(), { mode: "run", config: undefined });
});

test(
  "synchronous module initialization is bounded before a decision starts",
  { timeout: 15_000 },
  async (t) => {
    const { runner } = fixture(
      t,
      `while (true) {} export function decide() { return null; }`,
      100,
      1500,
    );
    await assert.rejects(
      runner.start(),
      /strategy worker startup exceeded 1500ms/,
    );
    runner.setSource({
      kind: "executor",
      source: `return { type: 'noop', reason: 'replacement' };`,
    });
    assert.deepEqual((await runner.decide(obs(1))).action, {
      type: "noop",
      reason: "replacement",
    });
  },
);

test("an idle worker crash is logged and reloaded before the next decision", async (t) => {
  const { runner, logs } = fixture(
    t,
    `export function decide(obs) {
    if (obs.round === 1) setTimeout(() => process.exit(0), 10);
    return { type: 'noop', reason: 'alive' };
  }`,
  );
  await runner.decide(obs(1));
  for (let i = 0; i < 100 && logs.length === 0; i++) await delay(10);
  assert.match(
    logs[0]?.reason ?? "",
    /strategy worker failed:.*exited with code 0/,
  );
  assert.deepEqual((await runner.decide(obs(2))).action, {
    type: "noop",
    reason: "alive",
  });
});

// Issue #100 (#93 F-J): the module load has its own bound. Reusing the 5 s decision bound for it
// killed 13 of 31 agents at boot on a loaded host -- a compile that is slow, not stuck.
test(
  "a module that loads slower than the decision bound still starts (startup has its own bound)",
  { timeout: 15_000 },
  async (t) => {
    const { runner } = fixture(
      t,
      `const t0 = Date.now(); while (Date.now() - t0 < 300) {}
       export function decide() { return { type: 'noop', reason: 'loaded' }; }`,
      100,
      5000,
    );
    assert.deepEqual(await runner.start(), {
      mode: "decide",
      config: undefined,
    });
    assert.deepEqual((await runner.decide(obs(1))).action, {
      type: "noop",
      reason: "loaded",
    });
  },
);

// Issue #100 (#93 F-H): a strategy that fails every block used to cost a worker spawn every block.
test(
  "consecutive failures back off instead of replacing the worker every block, and a working revision resets it",
  { timeout: 30_000 },
  async (t) => {
    const { runner, logs } = fixture(
      t,
      `export function decide() { throw new Error('always'); }`,
      1000,
    );
    for (const round of [1, 2, 3])
      await assert.rejects(runner.decide(obs(round)), /always/);
    // The third failure opens a 1-block back-off, said once.
    assert.equal(
      logs.filter((l) => /failed 3 times in a row/.test(l.reason ?? "")).length,
      1,
    );
    assert.match(
      ((await runner.decide(obs(4))).action as { reason: string }).reason,
      /backing off after 3 consecutive failed decisions; next attempt at block 5/,
    );
    // Block 5 is attempted; it fails again, and the back-off doubles to 2 blocks.
    await assert.rejects(runner.decide(obs(5)), /always/);
    for (const round of [6, 7])
      assert.match(
        ((await runner.decide(obs(round))).action as { reason: string }).reason,
        /backing off after 4 consecutive/,
      );
    // A revision installed meanwhile is picked up at the next attempt and resets the counter.
    runner.setSource({
      kind: "executor",
      source: `return { type: 'noop', reason: 'fixed' };`,
    });
    assert.deepEqual((await runner.decide(obs(8))).action, {
      type: "noop",
      reason: "fixed",
    });
    assert.deepEqual((await runner.decide(obs(9))).action, {
      type: "noop",
      reason: "fixed",
    });
  },
);

// Issue #215: the worker's environment is the strategy's, not the parent's. The wallet key and the
// inference token are the parent's business (send.ts signs, the improvement loop calls the model);
// the strategy's own parameters from the roster must still arrive.
test("the worker sees the strategy's parameters but not the parent's secrets", async (t) => {
  const names = [
    "ERIS_AGENT_PRIVATE_KEY",
    "ERIS_INFERENCE_TOKEN",
    "OPENAI_API_KEY",
    "ERIS_ARB_SAFETY_BPS",
    "STAT_ARB_Z_ENTER",
    "CF_ACCESS_CLIENT_SECRET",
  ] as const;
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  process.env.ERIS_AGENT_PRIVATE_KEY = "0xdeadbeef";
  process.env.ERIS_INFERENCE_TOKEN = "hmac-token";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ERIS_ARB_SAFETY_BPS = "150";
  process.env.STAT_ARB_Z_ENTER = "1.5";
  process.env.CF_ACCESS_CLIENT_SECRET = "cf-secret";
  t.after(() => {
    for (const n of names) {
      if (before[n] === undefined) delete process.env[n];
      else process.env[n] = before[n];
    }
  });
  const { runner } = fixture(
    t,
    `const safety = Number(process.env.ERIS_ARB_SAFETY_BPS ?? "100");
     export function decide() {
       return {
         type: 'noop',
         safety,
         z: process.env.STAT_ARB_Z_ENTER ?? null,
         key: process.env.ERIS_AGENT_PRIVATE_KEY ?? null,
         token: process.env.ERIS_INFERENCE_TOKEN ?? null,
         apiKey: process.env.OPENAI_API_KEY ?? null,
         cf: process.env.CF_ACCESS_CLIENT_SECRET ?? null,
         path: typeof process.env.PATH,
       };
     }`,
    1000,
  );
  assert.deepEqual((await runner.decide(obs(1))).action, {
    type: "noop",
    safety: 150,
    z: "1.5",
    key: null,
    token: null,
    apiKey: null,
    cf: "cf-secret",
    path: "string",
  });
});

// Audit #4a, in the worker where installed revisions actually run: generated code that replaces a
// built-in the executor bridge uses must not be handed the worker's observation. The worker carries
// no key in its environment, but its process can load any builtin module (and read the process's own
// files), so a host object reachable from the vm is the worker's process.
test("a generated revision in the worker cannot reach the worker's process through the bridge", async (t) => {
  const { runner } = fixture(t, `export function decide() { return { type: 'noop' }; }`, 1000);
  runner.setSource({
    kind: "executor",
    source: `
      const kept = [];
      const keys = Object.keys;
      try { Object.keys = function (v) { kept[kept.length] = v; return keys(v); }; } catch (e) {}
      const round = ctx.latestObservation().round;
      let reached = "nothing kept";
      for (let i = 0; i < kept.length; i++) {
        try {
          const p = kept[i].constructor.constructor("return process")();
          reached = typeof p.getBuiltinModule;
        } catch (e) { reached = "refused"; }
      }
      return { type: 'noop', round, reached };
    `,
  });
  assert.deepEqual((await runner.decide(obs(3))).action, {
    type: "noop",
    round: 3,
    reached: "nothing kept",
  });
});

test("a generated revision in the worker cannot reach the worker's process through WebAssembly streaming", async (t) => {
  // Node answers WebAssembly.compileStreaming / instantiateStreaming, and rejects a source that is
  // not a Response with an error of its own realm: one `constructor.constructor` from the worker's
  // process. The namespace is not in the context.
  const { runner } = fixture(t, `export function decide() { return { type: 'noop' }; }`, 1000);
  runner.setSource({
    kind: "executor",
    source: `
      let reached = "nothing";
      const names = ["compileStreaming", "instantiateStreaming"];
      for (let i = 0; i < names.length; i++) {
        try { await WebAssembly[names[i]](1); } catch (e) {
          try { reached = typeof e.constructor.constructor("return process")().getBuiltinModule; } catch (x) {}
        }
      }
      return { type: 'noop', round: ctx.latestObservation().round, reached };
    `,
  });
  assert.deepEqual((await runner.decide(obs(3))).action, {
    type: "noop",
    round: 3,
    reached: "nothing",
  });
});

// A rejected promise nobody handles, or a throw from a callback the engine runs later, used to end in
// Node's own handling of the value: the worker serialized it for the parent with util.inspect, which
// calls a custom inspect function with the host's `inspect` as an argument. These payloads try that
// (if Symbol.for is there to make the symbol) and write a file if they reach the worker's process.
const inspectEscape = (proof: string) => `
  const x = { stack: "s" };
  try {
    x[Symbol.for("nodejs.util.inspect.custom")] = function (depth, options, inspect) {
      try {
        const p = inspect.constructor.constructor("return process")();
        p.getBuiltinModule("fs").writeFileSync(${JSON.stringify(proof)}, "reached the worker's process");
      } catch (e) {}
      return "x";
    };
  } catch (e) {}
`;

test("an unhandled rejection from a generated revision is not inspected and does not end the worker", async (t) => {
  const { runner, logs } = fixture(t, `export function decide() { return { type: 'noop' }; }`, 1000);
  const dir = mkdtempSync(join(tmpdir(), "eris-worker-proof-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proof = join(dir, "proof.txt");
  runner.setSource({
    kind: "executor",
    source: `${inspectEscape(proof)}
      Promise.reject(x);
      Promise.reject(new Error("a second one, same decision"));
      globalThis.calls = (globalThis.calls || 0) + 1;
      return { type: 'noop', calls: globalThis.calls };
    `,
  });
  assert.deepEqual((await runner.decide(obs(1))).action, { type: "noop", calls: 1 });
  for (let i = 0; i < 100 && logs.length === 0; i++) await delay(10);
  await delay(50);
  // Said once for the decision, as fixed text.
  assert.deepEqual(logs, [
    {
      round: 1,
      reason:
        "the generated strategy left a rejected promise unhandled; the value is not read, " +
        "and the strategy keeps running",
    },
  ]);
  // The same worker answers the next decision: its state is still there.
  assert.deepEqual((await runner.decide(obs(2))).action, { type: "noop", calls: 2 });
  assert.ok(!existsSync(proof), "the custom inspect function reached the worker's process");
});

test(
  "a throw from a FinalizationRegistry callback fails the worker with a fixed message, not the value",
  { timeout: 60_000 },
  async (t) => {
    const { runner, logs } = fixture(t, `export function decide() { return { type: 'noop' }; }`, 5000);
    const dir = mkdtempSync(join(tmpdir(), "eris-worker-proof-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const proof = join(dir, "proof.txt");
    // The engine runs the cleanup callback as a task of its own once a registered object has been
    // collected; Node reports a throw from it as an uncaught exception. Allocation drives the GC,
    // and it has to be enough for a full collection: Node 22 processes the registry only then.
    runner.setSource({
      kind: "executor",
      source: `
        if (obs.round >= 1000) return { type: 'noop', reason: 'after' };
        globalThis.registry = globalThis.registry || new FinalizationRegistry(() => {
          ${inspectEscape(proof)}
          throw x;
        });
        for (let i = 0; i < 20; i++) globalThis.registry.register({ i }, i);
        let junk = 0;
        for (let i = 0; i < 40; i++) junk += new Array(500000).fill(i).length;
        return { type: 'noop', junk };
      `,
    });
    const failures: string[] = [];
    for (let round = 1; round <= 60 && failures.length === 0; round++) {
      try {
        await runner.decide(obs(round));
      } catch (error) {
        failures.push((error as Error).message);
      }
      for (let i = 0; i < 30 && logs.length === 0; i++) await delay(10);
      for (const entry of logs) failures.push(entry.reason ?? "");
    }
    assert.ok(failures.length > 0, "the registry's callback never ran");
    assert.match(
      failures[0],
      /uncaught exception in the generated strategy \(the value is not read\)/,
    );
    assert.ok(!existsSync(proof), "the custom inspect function reached the worker's process");
    assert.deepEqual((await runner.decide(obs(1000))).action, { type: "noop", reason: "after" });
  },
);
