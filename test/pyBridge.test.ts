import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "@eris/sdk/config.js";
import type { AgentLogEntry } from "@eris/sdk/agent.js";
import { PyBridge } from "../example/agents/runtime/pyBridge.js";
import { DecideTimeoutError } from "../example/agents/runtime/decideTimeout.js";
import {
  parseRevision,
  loadImproveAgent,
  buildRevisionSystem,
} from "../example/agents/runtime/improve.js";
import { AgentStateStore } from "../example/agents/runtime/state.js";
import { decide } from "../example/agents/my-arb/agent.js";
import { pythonObservation } from "./helpers/python.js";
import { StrategyRunner } from "../example/agents/runtime/strategyRunner.js";
import { Sender } from "../example/agents/runtime/send.js";
import { generatePrivateKey } from "viem/accounts";
import type { SimContext } from "@eris/sdk/protocols/types.js";

const context = {
  agentId: "py-test",
  address: "0x0000000000000000000000000000000000000001" as const,
  config: loadConfig(),
  rpcUrl: "http://127.0.0.1:1",
};
function fixture(t: test.TestContext, source: string, timeout = 5000) {
  const dir = mkdtempSync(join(tmpdir(), "eris-py-test-"));
  const path = join(dir, "strategy.py");
  writeFileSync(path, source);
  const logs: AgentLogEntry[] = [];
  const runner = new PyBridge(
    { kind: "python", path },
    { ...context, agentDir: dir },
    (entry) => logs.push(entry),
    timeout,
  );
  t.after(async () => {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { runner, logs, path, dir };
}
const loop = (body: string) =>
  `import sys, json, os\ncount = 0\nfor line in sys.stdin:\n    r = json.loads(line)\n    count += 1\n${body
    .split("\n")
    .map((line) => "    " + line)
    .join("\n")}\n`;

test("Python stays resident, preserves integer strings, and buffers submit/log channels", async (t) => {
  const { runner, logs } = fixture(
    t,
    loop(`print(json.dumps({"id": r["id"], "log": {"reason": "thinking"}}), flush=True)
print(json.dumps({"id": r["id"], "submit": {"type": "swap", "tokenIn": "USDC", "amountIn": r["obs"]["balances"]["usdcUnits"]}}), flush=True)
print(json.dumps({"id": r["id"], "action": {"type": "noop", "reason": str(count)}}), flush=True)`),
  );
  const first = await runner.decide(pythonObservation());
  assert.equal(first.submitted.length, 1);
  assert.equal(
    (first.submitted[0] as { amountIn: string }).amountIn,
    "9007199254740993000000",
  );
  assert.equal(logs[0].reason, "thinking");
  assert.deepEqual((await runner.decide(pythonObservation(2))).action, {
    type: "noop",
    reason: "2",
  });
});

test("SDK sample has the same decisions as my-arb across funding, venues and dust", async (t) => {
  const { runner } = fixture(
    t,
    readFileSync("example/agents/my-arb-py/strategy.py", "utf8"),
  );
  const observations = [
    pythonObservation(),
    pythonObservation(2),
    pythonObservation(3),
    pythonObservation(4),
  ];
  observations[1].balances.usdcUnits = "0";
  observations[2].balances = { ethWei: "0", wethWei: "0", usdcUnits: "0" };
  observations[3].balances.usdcUnits = "1000000";
  observations[3].balances.wethWei = "0";
  for (const obs of observations)
    assert.deepEqual((await runner.decide(obs)).action, decide(obs));
});

test("timeout kills CPU-bound Python and its child, discards submissions, and respawns selected code", async (t) => {
  const { runner, dir, path } = fixture(
    t,
    `import sys, json, os, subprocess\nr = json.loads(input())\nchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])\nopen("pids", "w").write(str(os.getpid()) + " " + str(child.pid))\nprint(json.dumps({"submit": {"type": "noop"}}), flush=True)\nwhile True: pass\n`,
    600,
  );
  await assert.rejects(runner.decide(pythonObservation()), DecideTimeoutError);
  const pids = readFileSync(join(dir, "pids"), "utf8").split(" ").map(Number);
  for (const pid of pids) {
    // A killed grandchild can remain a zombie briefly until PID 1 reaps it; it cannot run again.
    let stopped = false;
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") stopped = true;
        else throw error;
      }
      if (stopped) break;
      await delay(20);
    }
    assert.ok(stopped, `Python process ${pid} survived timeout`);
  }
  writeFileSync(path, loop('print("null", flush=True)'));
  assert.equal((await runner.decide(pythonObservation(2))).action, null);
});

for (const [name, body, pattern] of [
  ["malformed JSON", 'print("not-json", flush=True)', /protocol error/],
  ["crash", 'raise RuntimeError("broken strategy")', /broken strategy/],
  [
    "oversized output",
    'print("x" * (1024 * 1024 + 1), flush=True)',
    /exceeded 1 MiB/,
  ],
] as const)
  test(`Python ${name} is reported and the next call can recover`, async (t) => {
    const { runner, path } = fixture(t, loop(body));
    await assert.rejects(runner.decide(pythonObservation()), pattern);
    writeFileSync(path, loop('print("null", flush=True)'));
    assert.equal((await runner.decide(pythonObservation(2))).action, null);
  });

test("correlation prevents late callbacks from submitting against the next observation", async (t) => {
  const { runner } = fixture(
    t,
    loop(`print(json.dumps({"id": r["id"] - 1, "submit": {"type": "noop"}}), flush=True)
print(json.dumps({"id": r["id"], "action": None}), flush=True)`),
  );
  assert.deepEqual(await runner.decide(pythonObservation()), {
    action: null,
    submitted: [],
  });
  assert.deepEqual(await runner.decide(pythonObservation(2)), {
    action: null,
    submitted: [],
  });
});

test("Python revisions compile without execution, reject cheatcodes, persist, resume and revert", async (t) => {
  const original = loop(
    'print(json.dumps({"type": "noop", "reason": "original"}), flush=True)',
  );
  const { runner, dir } = fixture(t, original);
  const source = loop(
    'print(json.dumps({"type": "noop", "reason": "revised"}), flush=True)',
  );
  assert.equal((await runner.prepareSource("def broken(:")).ok, false);
  assert.equal(
    (await runner.prepareSource('rpc("anvil_setBalance")')).ok,
    false,
  );
  // Syntax checking must not import/execute a model's top-level code.
  assert.equal(
    (await runner.prepareSource('raise RuntimeError("not during compile")')).ok,
    true,
  );
  const prepared = await runner.prepareSource(source);
  assert.ok(prepared.ok);
  runner.setSource(prepared.source);
  assert.deepEqual((await runner.decide(pythonObservation())).action, {
    type: "noop",
    reason: "revised",
  });
  const store = AgentStateStore.open({
    dir: join(dir, "state"),
    onProblem: assert.fail,
  })!;
  store.save({
    schema: 1,
    epochs: ["one"],
    versions: [
      {
        version: 1,
        language: "python",
        source,
        notes: "change",
        installedAtBlock: 1,
        valueAtInstall: 1,
        epochId: "one",
      },
    ],
  });
  const loaded = store.load();
  assert.ok(loaded.ok === true);
  assert.equal(loaded.state.versions[0].language, "python");
  const resumed = await runner.prepareSource(loaded.state.versions[0].source);
  assert.ok(resumed.ok);
  runner.setSource(resumed.source);
  assert.deepEqual((await runner.decide(pythonObservation(2))).action, {
    type: "noop",
    reason: "revised",
  });
  const reverted = await runner.prepareSource(original);
  assert.ok(reverted.ok);
  runner.setSource(reverted.source);
  assert.deepEqual((await runner.decide(pythonObservation(3))).action, {
    type: "noop",
    reason: "original",
  });
});

test("Python revision parsing is language-specific and prompt vocabulary is generated", () => {
  const policy = loadImproveAgent(resolve("example/agents/my-arb-py"));
  assert.equal(policy.language, "python");
  assert.ok(
    parseRevision({ notes: "change", executorPy: "print(1)" }, "python").ok,
  );
  assert.ok(parseRevision({ notes: "keep", executorPy: null }, "python").ok);
  assert.ok(parseRevision({ notes: "revert", revertTo: 1 }, "python").ok);
  for (const reply of [
    { executorTs: "return null" },
    { executorPy: "" },
    { executorPy: "x", revertTo: 1 },
  ])
    assert.equal(parseRevision({ notes: "bad", ...reply }, "python").ok, false);
  assert.equal(parseRevision({ notes: "bad", executorPy: "x" }).ok, false);
  const prompt = buildRevisionSystem(policy, "def decide(obs, ctx): pass", [
    "uniswap",
    "lending",
  ]);
  assert.match(prompt, /executorPy/);
  assert.doesNotMatch(prompt, /executorTs|standard JavaScript/);
  assert.match(prompt, /lending_borrow\(/);
  assert.match(prompt, /swap\(\*, token_in: str/);
  assert.match(prompt, /base: str \| None = None/);
});

test("Python and TypeScript actions produce identical bad_action and rejected records", async (t) => {
  const { runner: python, dir } = fixture(
    t,
    loop(`print(json.dumps({"submit": {"type": "invented"}}), flush=True)
print(json.dumps({"type": "rawTx", "tx": {"data": "0x6000"}}), flush=True)`),
  );
  const path = join(dir, "agent.ts");
  writeFileSync(
    path,
    `export function decide(obs, ctx) { ctx.submit({type:'invented'}); return {type:'rawTx',tx:{data:'0x6000'}}; }`,
  );
  const typescript = new StrategyRunner(
    { kind: "module", path },
    context,
    () => {},
  );
  t.after(() => typescript.close());
  const records = [];
  for (const runner of [typescript, python]) {
    const events: Record<string, unknown>[] = [];
    const sender = new Sender({
      ctx: { config: context.config } as SimContext,
      adapters: [],
      privateKey: generatePrivateKey(),
      logMempool: (e) => events.push(e),
    });
    const result = await runner.decide(pythonObservation());
    for (const action of [...result.submitted, result.action])
      if (action) sender.submit(action, null, null, new Map());
    assert.deepEqual(
      events.map((e) => e.event),
      ["bad_action", "rejected"],
    );
    records.push(events);
  }
  assert.deepEqual(records[0], records[1]);
});

test("missing Python fails promptly and compile timeout is bounded without running a strategy", async (t) => {
  const { dir, path } = fixture(t, 'print("null")');
  const absent = new PyBridge(
    { kind: "python", path },
    context,
    () => {},
    5000,
    join(dir, "missing"),
  );
  t.after(() => absent.close());
  await assert.rejects(absent.decide(pythonObservation()), /ENOENT/);
  const slow = join(dir, "slow-python");
  writeFileSync(slow, "#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n");
  chmodSync(slow, 0o700);
  const compiler = new PyBridge(
    { kind: "python", path },
    context,
    () => {},
    5000,
    slow,
  );
  t.after(() => compiler.close());
  const start = performance.now();
  const result = await compiler.prepareSource("pass");
  assert.ok(!result.ok);
  assert.match(result.reason, /compile exceeded 1000ms/);
  assert.ok(performance.now() - start < 3000);
});
