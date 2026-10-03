// The runs API is the one door between a run directory and a browser (dashboard/server/runsApi.ts).
// In audience mode -- the dashboard is public during the trial period and the live week -- it has to
// withhold what rules §3.3 / §7.2 publish only after the results (seeds, the scenario of an epoch,
// the not-yet-opened stress windows), what §3.2 leaves to the participant to find out (which
// regime-7 pool is rigged), and what is the participants' own (decision logs, pending bids,
// stderr). These tests stand a real server up over a fabricated run directory and read back what
// a browser would get, because the leak this guards against is a property of the serving, not of a
// helper that could be tested in isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  competitionsFromEnv,
  createRunsApi,
  HOLD,
  modeFromEnv,
  redactBlocksRow,
  redactEvent,
  redactEventLine,
  TX_MINED_MARGIN,
} from "../dashboard/server/runsApi.js";

function fixtureRuns(): string {
  const root = mkdtempSync(join(tmpdir(), "eris-runs-api-"));
  // A finished scenario run inside a matrix.
  const run = join(root, "2026-11-01T10-00-00-000Z");
  mkdirSync(join(run, "agents"), { recursive: true });
  mkdirSync(join(run, "disclosures"), { recursive: true });
  const events = [
    {
      type: "run_started_realtime",
      runId: "r",
      seed: 4242,
      flowSeed: 7,
      scenarioRegime: "crash",
      rpcUrl: "http://127.0.0.1:8545",
      epochBlocks: 12,
    },
    {
      type: "stress_schedule",
      runStartBlock: 100,
      events: [
        { type: "crash", magnitude: 0.14, startBlock: 30, endBlock: 47 },
        { type: "whale", magnitude: 12, startBlock: 300, endBlock: 301 },
      ],
    },
    {
      type: "stress_calibration_warning",
      note: "crash 0.14 breaches HF0 1.10",
    },
    {
      type: "pool_created",
      pool: "0xabc",
      rigged: true,
      rugBps: 5000,
      rugThresholdUnits: "1000000",
      baitBps: 30,
      feeBps: 30,
    },
    { type: "vulnerability_exploited", pool: "0xabc", agent: "a1" },
    {
      type: "agent_process_exited",
      agentId: "a1",
      code: 137,
      stderrTail: "OOM",
    },
    { type: "stress_liquidation", blockNumber: 140, victim: "0xdef" },
    // Window 0 (crash, 130..147) has closed by block 200; window 1 (whale, 400..401) has not.
    { type: "stress_event_applied", eventIndex: 0, eventType: "crash", blockNumber: 135 },
    { type: "stress_event_applied", eventIndex: 1, eventType: "whale", blockNumber: 199 },
    { type: "stress_event_summary", eventIndex: 0, eventType: "crash", status: "observed" },
    { type: "stress_event_summary", eventIndex: 1, eventType: "whale", status: "observed" },
    {
      type: "stress_token_launch_setup",
      launches: [
        { eventIndex: 0, index: 0, symbol: "T0", startBlock: 30, endBlock: 47 },
        { eventIndex: 1, index: 0, symbol: "T1", startBlock: 300, endBlock: 301 },
      ],
    },
    { type: "stress_token_launch_funded", eventIndex: 1, index: 0, waveUsdcUnits: "0" },
    { type: "stress_whale_funded", address: "0xw", usdcUnits: "1", events: 1 },
    { type: "stress_whale", blockNumber: 400, magnitude: 12 },
  ];
  writeFileSync(
    join(run, "events.jsonl"),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  // round,blockNumber,... -- the run has reached block 200: the crash (100+47) is history, the
  // whale (100+301) is not.
  writeFileSync(
    join(run, "blocks.csv"),
    "round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex,method,gasUsed\n" +
      "150,150,0,0x1,0xa,0,success,oracle,system,,,,setPrice,50000\n" +
      "200,200,0,0x2,0xb,0,success,a1,agent,swap,,,exactInputSingle,120000\n",
  );
  writeFileSync(
    join(run, "summary.json"),
    JSON.stringify({
      runId: "r",
      seed: 4242,
      flowSeed: 7,
      resetUnit: "continuous",
      stressEvents: [{ eventIndex: 0, eventType: "crash", status: "observed" }],
      agents: [
        {
          id: "a1",
          address: "0xb",
          netPnlUsdc: 1,
          stderrTail: "secret stderr",
        },
      ],
    }),
  );
  writeFileSync(join(run, "agents", "a1.jsonl"), '{"reason":"my strategy"}\n');
  writeFileSync(join(run, "agents", "a1.llm.jsonl"), '{"prompt":"x"}\n');
  writeFileSync(join(run, "disclosures", "0xabc.json"), '{"source":"..."}\n');
  writeFileSync(join(run, "market.json"), '{"ok":true}\n');

  // One epoch of a scenario matrix, still running: no summary.json, resetUnit in the header only.
  const epoch = join(root, "2026-11-02T10-00-00-000Z");
  mkdirSync(epoch, { recursive: true });
  writeFileSync(
    join(epoch, "events.jsonl"),
    [
      { type: "run_started_realtime", runId: "e", seed: 99, resetUnit: "scenario", epochBlocks: 12 },
      {
        type: "stress_schedule",
        runStartBlock: 100,
        events: [{ type: "crash", magnitude: 0.14, startBlock: 30, endBlock: 47 }],
      },
      { type: "stress_liquidation", blockNumber: 140, victim: "0xdef" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(epoch, "blocks.csv"),
    "round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex,method,gasUsed\n" +
      "300,300,0,0x9,0xa,0,success,oracle,system,,,,setPrice,50000\n",
  );

  const matrix = join(root, "matrix-2026-11-01");
  mkdirSync(matrix);
  writeFileSync(
    join(matrix, "matrix.json"),
    JSON.stringify({
      schema: 2,
      resetUnit: "scenario",
      k: 40,
      scenariosPlanned: 40,
      scenarios: [
        {
          s: 3,
          regime: "crash",
          seed: 4242,
          runDir: "runs/2026-11-01T10-00-00-000Z",
          agents: [
            { id: "a1", netPnlUsdc: 1, flags: ["process exited early: 137"] },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(matrix, "standings.json"),
    JSON.stringify({
      k: 40,
      epochs: [{ s: 3, regime: "crash", seed: 4242 }],
      // Flag lines as written before they were keyed by ordinal: the scenario at the head.
      agents: [
        {
          id: "a1",
          flags: [
            "crash#4242: process exited early: 137",
            "calm#7: process exited early: 1",
          ],
        },
      ],
    }),
  );

  // A practice period: segments keep their labels (they are days, not scenarios).
  const period = join(root, "practice-period");
  mkdirSync(period);
  writeFileSync(
    join(period, "matrix.json"),
    JSON.stringify({
      schema: 1,
      resetUnit: "continuous",
      scenarios: [
        {
          regime: "segment",
          seed: 0,
          label: "2026-09-25",
          runDir: "runs/practice-period/day0",
          agents: [],
        },
      ],
    }),
  );
  return root;
}

async function serve(
  root: string,
  audience: boolean,
  competitions?: string[],
) {
  const handle = createRunsApi(root, {
    audience,
    standings: !audience,
    ...(competitions ? { competitions } : {}),
  });
  const server = createServer((req, res) => {
    const [p, q] = (req.url ?? "/").split("?");
    if (!handle(p, q, req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  return {
    get,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("audience mode withholds the participants' files and everything not on the list", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, true);
  try {
    const run = "2026-11-01T10-00-00-000Z";
    assert.equal((await get(`/${run}/agents/a1.jsonl`)).status, 404);
    assert.equal((await get(`/${run}/agents/a1.llm.jsonl`)).status, 404);
    assert.equal((await get(`/${run}/disclosures/0xabc.json`)).status, 404);
    assert.equal(
      (await get(`/${run}/tail/agents/a1.jsonl?offset=0`)).status,
      404,
    );
    assert.equal((await get(`/${run}/market.json`)).status, 200);
    assert.equal((await get(`/${run}/blocks.csv`)).status, 200);
    const mode = JSON.parse((await get("/mode.json")).text);
    assert.deepEqual(mode, { audience: true, standings: false });
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the interval series is public under its name and under the old one (issue #140)", async () => {
  // The hosted dashboard follows main while the practice coordinator writes the old name until it
  // restarts, so the public view has to serve both -- and say "missing" for the one that is not
  // there, which is how the client picks the one that is.
  const root = fixtureRuns();
  const run = "2026-11-01T10-00-00-000Z";
  const line = `${JSON.stringify({ index: 0, blockNumber: 100, values: { a1: 1 } })}\n`;
  writeFileSync(join(root, run, "epochs.jsonl"), line);
  const { get, close } = await serve(root, true);
  try {
    assert.equal((await get(`/${run}/epochs.jsonl`)).status, 200);
    const legacy = JSON.parse(
      (await get(`/${run}/tail/epochs.jsonl?offset=0`)).text,
    );
    assert.equal(legacy.text, line);
    const absent = JSON.parse(
      (await get(`/${run}/tail/intervals.jsonl?offset=0`)).text,
    );
    assert.equal(absent.missing, true);
    writeFileSync(join(root, run, "intervals.jsonl"), line);
    assert.equal((await get(`/${run}/intervals.jsonl`)).status, 200);
    const current = JSON.parse(
      (await get(`/${run}/tail/intervals.jsonl?offset=0`)).text,
    );
    assert.equal(current.text, line);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("audience mode strips seeds, future windows, rigged ground truth and stderr from events.jsonl", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, true);
  try {
    const run = "2026-11-01T10-00-00-000Z";
    for (const path of [
      `/${run}/events.jsonl`,
      `/${run}/tail/events.jsonl?offset=0`,
    ]) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      const text = path.includes("/tail/")
        ? (JSON.parse(res.text) as { text: string }).text
        : res.text;
      const events = text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const types = events.map((e) => e.type);
      assert.ok(!types.includes("stress_calibration_warning"), path);
      assert.ok(!types.includes("vulnerability_exploited"), path);
      const started = events.find((e) => e.type === "run_started_realtime")!;
      assert.equal(started.seed, undefined);
      assert.equal(started.flowSeed, undefined);
      // #187: the regime the streams are named by is the epoch's regime (rules §3.3).
      assert.equal(started.scenarioRegime, undefined);
      assert.equal(started.rpcUrl, "http://127.0.0.1:8545");
      const schedule = events.find((e) => e.type === "stress_schedule")!;
      const windows = schedule.events as { type: string }[];
      assert.deepEqual(
        windows.map((w) => w.type),
        ["crash"],
        "only the window that has closed by block 200",
      );
      // Not on the allowlist (issue #210): no page reads them, and pool_created carried the rigged
      // flag, agent_process_exited a participant's stderr.
      assert.ok(!types.includes("pool_created"), path);
      assert.ok(!types.includes("agent_process_exited"), path);
      assert.ok(!text.includes("rigged") && !text.includes("OOM"), path);
      assert.ok(types.includes("stress_liquidation"), "realized events stay");
      // Every other stress event follows the schedule's rule: its window must have closed.
      const indexes = (type: string) =>
        events.filter((e) => e.type === type).map((e) => e.eventIndex);
      assert.deepEqual(indexes("stress_event_applied"), [0], "the open whale's next price is not served");
      assert.deepEqual(indexes("stress_event_summary"), [0]);
      assert.deepEqual(indexes("stress_token_launch_funded"), [], "dud-or-not of a future launch");
      const launch = events.find((e) => e.type === "stress_token_launch_setup")!;
      assert.deepEqual(
        (launch.launches as { symbol: string }[]).map((l) => l.symbol),
        ["T0"],
      );
      assert.ok(!types.includes("stress_whale_funded"), "a plan with no window of its own");
      assert.ok(!types.includes("stress_whale"), "not mined yet");
    }
    const summary = JSON.parse((await get(`/${run}/summary.json`)).text);
    assert.equal(summary.stressEvents, undefined, "the per-window audit names every window's kind");
    // A scenario matrix's epoch: the window closed at block 147 and the run is at 300, and still
    // nothing of the plan is served -- its kind would name the regime (rules §3.3).
    const epoch = await get("/2026-11-02T10-00-00-000Z/events.jsonl");
    const epochTypes = epoch.text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { type: string }).type);
    assert.ok(!epochTypes.includes("stress_schedule"), "no schedule for a scenario epoch");
    // Nor any other stress event: a victim liquidation, a whale, a token launch each name a regime.
    assert.ok(
      !epochTypes.some((t) => t.startsWith("stress_")),
      `no stress events for a scenario epoch: ${epochTypes.join(",")}`,
    );
    assert.ok(!epoch.text.includes('"seed"'));
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("audience mode hides regime and seed of a scenario matrix but not a practice period's days", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, true);
  try {
    const matrix = JSON.parse(
      (await get("/matrix-2026-11-01/matrix.json")).text,
    );
    assert.equal(matrix.scenarios[0].regime, "hidden");
    // Null, not 0: a redacted seed, a practice segment's placeholder and a real seed 0 are three
    // different things, and only the server knows which one it is serving (issue #84 E).
    assert.equal(matrix.scenarios[0].seed, null);
    assert.equal(matrix.scenarios[0].s, 3);
    assert.deepEqual(
      matrix.scenarios[0].agents[0].flags,
      ["process exited early: 137"],
      "flags stay: §4.4.2 facts",
    );
    assert.equal(matrix.scenariosPlanned, 40);
    const standings = JSON.parse(
      (await get("/matrix-2026-11-01/standings.json")).text,
    );
    assert.equal(standings.epochs[0].regime, "hidden");
    assert.equal(standings.epochs[0].seed, null);
    // Any agent can raise a flag, so the flag lines must not name the scenario either.
    assert.deepEqual(standings.agents[0].flags, [
      "s=3: process exited early: 137",
      "s=?: process exited early: 1",
    ]);
    assert.doesNotMatch(JSON.stringify(standings), /crash|4242|calm#7/);
    const period = JSON.parse((await get("/practice-period/matrix.json")).text);
    assert.equal(period.scenarios[0].label, "2026-09-25");
    assert.equal(period.scenarios[0].regime, "segment");
    const summary = JSON.parse(
      (await get("/2026-11-01T10-00-00-000Z/summary.json")).text,
    );
    assert.equal(summary.seed, undefined);
    assert.equal(summary.agents[0].stderrTail, undefined);
    assert.equal(summary.agents[0].netPnlUsdc, 1);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator mode serves everything as before, with cache headers", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, false);
  try {
    const run = "2026-11-01T10-00-00-000Z";
    assert.equal((await get(`/${run}/agents/a1.jsonl`)).status, 200);
    const events = await get(`/${run}/events.jsonl`);
    assert.ok(events.text.includes('"seed":4242'));
    assert.ok(events.text.includes("stress_calibration_warning"));
    assert.equal(
      events.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    const matrix = await get("/matrix-2026-11-01/matrix.json");
    assert.equal(JSON.parse(matrix.text).scenarios[0].regime, "crash");
    assert.equal(matrix.headers.get("cache-control"), "public, max-age=5");
    assert.equal(
      (await get("/index.json")).headers.get("cache-control"),
      "public, max-age=5",
    );
    assert.deepEqual(JSON.parse((await get("/mode.json")).text), {
      audience: false,
      standings: true,
    });
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("redactEventLine: past windows for a continuous world, nothing for a scenario epoch", () => {
  const line = JSON.stringify({
    type: "stress_schedule",
    runStartBlock: 100,
    events: [{ type: "crash", startBlock: 30, endBlock: 47 }],
  });
  const past = (currentBlock: number | null) =>
    ({ kind: "past", currentBlock }) as const;
  assert.equal(redactEventLine(line, past(null)), null);
  assert.equal(redactEventLine(line, past(146)), null, "endBlock not yet reached");
  assert.ok(redactEventLine(line, past(147))?.includes('"crash"'));
  assert.equal(redactEventLine(line, { kind: "none" }), null, "a scenario epoch: never");
  assert.equal(redactEventLine("not json", past(1)), null, "fail closed: a line that cannot be read");
});

test("redactEventLine: a stress event is served once its window has closed", () => {
  const windows = [
    { start: 130, end: 147 },
    { start: 180, end: 220 },
  ];
  const past = (currentBlock: number | null, w: typeof windows | null = windows) =>
    ({ kind: "past", currentBlock, windows: w }) as const;
  const applied = (eventIndex: number, blockNumber: number) =>
    JSON.stringify({ type: "stress_event_applied", eventIndex, blockNumber });
  // Written when the oracle tx is sent: at block 200 the applied price for 201 is in the file.
  assert.equal(redactEventLine(applied(1, 201), past(200)), null);
  assert.equal(redactEventLine(applied(1, 201), past(220))?.includes('"eventIndex":1'), true);
  assert.ok(redactEventLine(applied(0, 140), past(200)));
  assert.equal(redactEventLine(applied(7, 140), past(200)), null, "an index the schedule lacks");
  assert.equal(redactEventLine(applied(0, 140), past(200, null)), null, "no schedule: no attribution");
  assert.equal(redactEventLine(applied(0, 140), { kind: "none" }), null);

  const block = (blockNumber: number) =>
    JSON.stringify({ type: "stress_victim_hf", blockNumber, healthFactor: "0.98" });
  assert.equal(redactEventLine(block(190), past(200)), null, "inside a window that is still open");
  assert.ok(redactEventLine(block(140), past(200)), "inside a closed window");
  assert.ok(redactEventLine(block(160), past(200)), "between windows, already mined");
  assert.equal(redactEventLine(block(205), past(200)), null, "not mined yet");

  const plan = JSON.stringify({ type: "stress_liquidity_pull_setup", owner: "0x1", venues: ["uniswap"] });
  assert.equal(redactEventLine(plan, past(10_000)), null, "plan/setup events are never served");
});

test("redactEventLine: the operator's agent sandbox warning is not served to the audience", () => {
  const line = JSON.stringify({
    type: "agent_sandbox_warning",
    sharedNetwork: [{ id: "a", network: "host" }],
  });
  assert.equal(redactEventLine(line, { kind: "none" }), null);
  assert.equal(redactEventLine(line, { kind: "past", currentBlock: 10 }), null);
});

// Issue #210: events.jsonl is served to the audience from an allowlist. A type nobody has argued onto
// it is not served -- the bug class was "a new event the denylist did not know".
test("redactEvent: the audience gets only the listed event types", () => {
  const past = { kind: "past", currentBlock: 500, windows: [], chainHeight: 500 } as const;
  const none = { kind: "none", chainHeight: 500 } as const;
  const line = (type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type, blockNumber: 400, ...extra });
  for (const policy of [past, none]) {
    assert.equal(redactEventLine(line("some_future_event"), policy), null, "unknown type");
    assert.equal(redactEventLine(line("flow_balances"), policy), null, "the environment's inventory");
    assert.equal(redactEventLine(line("initial_endowment"), policy), null);
    assert.ok(redactEventLine(line("round_timing"), policy), "the clock stays");
    assert.ok(redactEventLine(line("lst_block"), policy), "venue state stays");
  }
  // The vuln regime's lifecycle and the venue facts only some regimes produce: in a scenario epoch
  // each names the regime (rules §3.3).
  for (const type of [
    "vuln_factory_deployed",
    "pool_created",
    "vulnerability_disclosed",
    "safe_pool_captured",
    "liquity_liquidation",
    "liquity_redemption",
    "lst_slash",
  ])
    assert.equal(redactEventLine(line(type), none), null, `${type} in a scenario epoch`);
  // A continuous world keeps the on-chain facts (history by the time they are written), not the
  // vuln answer key.
  for (const type of ["liquity_liquidation", "liquity_redemption", "lst_slash"])
    assert.ok(redactEventLine(line(type), past), `${type} in a continuous world`);
  for (const type of ["pool_created", "vulnerability_disclosed", "safe_pool_captured"])
    assert.equal(redactEventLine(line(type), past), null, `${type} in a continuous world`);
});

test("redactEvent: an environment submission is held until it has been mined", () => {
  const tx = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "tx_submitted",
      hash: "0xh",
      ownerId: "flow-whale:uninformed",
      role: "uninformed-flow",
      priorityFeeWei: "1",
      actionType: "swap",
      ...extra,
    });
  const past = (chainHeight: number | null) =>
    ({ kind: "past", currentBlock: chainHeight, windows: [], chainHeight }) as const;
  // Sent while the head was 100: minable in 101 at the earliest, shown from 100 + margin.
  assert.equal(TX_MINED_MARGIN, 2);
  assert.equal(redactEvent(tx({ headBlock: 100 }), past(null)), HOLD, "nothing known mined");
  assert.equal(redactEvent(tx({ headBlock: 100 }), past(100)), HOLD, "pending");
  assert.equal(redactEvent(tx({ headBlock: 100 }), past(101)), HOLD, "the block it could be in");
  const shown = redactEvent(tx({ headBlock: 100 }), past(102));
  assert.equal(typeof shown, "string");
  assert.equal(JSON.parse(shown as string).ownerId, "flow-whale:uninformed", "continuous keeps the name");
  assert.ok(redactEvent(tx({ headBlock: 100 }), past(Number.POSITIVE_INFINITY)), "a finished run");
  // A coordinator from before headBlock: dated by the newest block-processing line before it.
  const cursor = { lastBlock: null as number | null };
  assert.ok(redactEvent(JSON.stringify({ type: "round_timing", blockNumber: 100 }), past(102), cursor));
  assert.equal(redactEvent(tx({}), past(102), cursor), HOLD, "100 + 1 + margin is 103");
  assert.ok(redactEvent(tx({}), past(103), { lastBlock: 100 }));
  assert.equal(redactEvent(tx({}), past(10_000), { lastBlock: null }), HOLD, "undatable while live");
  // A whole-file reader cannot come back for it: dropped there.
  assert.equal(redactEventLine(tx({ headBlock: 100 }), past(101)), null);
  // In a scenario epoch the owner that names the regime is collapsed.
  const none = { kind: "none", chainHeight: 102 } as const;
  const epoch = JSON.parse(redactEvent(tx({ headBlock: 100 }), none) as string);
  assert.equal(epoch.ownerId, "flow");
  assert.equal(epoch.hash, "0xh");
  const launch = JSON.parse(
    redactEvent(tx({ headBlock: 100, ownerId: "flow-launch-wave:0:1" }), none) as string,
  );
  assert.equal(launch.ownerId, "flow");
  const background = JSON.parse(
    redactEvent(tx({ headBlock: 100, ownerId: "flow-uniswap:informed", role: "informed-flow" }), none) as string,
  );
  assert.equal(background.ownerId, "flow-uniswap:informed", "background flow is every regime's");
  const failed = JSON.stringify({ type: "tx_submit_failed", headBlock: 100, ownerId: "flow-whale:uninformed" });
  assert.equal(redactEvent(failed, { kind: "none", chainHeight: 101 }), HOLD);
  assert.equal(JSON.parse(redactEvent(failed, none) as string).ownerId, "flow");
});

test("redactBlocksRow: a scenario epoch's regime-naming senders become their class", () => {
  const row = (owner: string, role: string) =>
    `301,301,3,0xh,0xf,0,success,${owner},${role},swap,,,exactInputSingle,90000,1`;
  assert.equal(redactBlocksRow(row("flow-whale:uninformed", "uninformed-flow")), row("flow", "uninformed-flow"));
  assert.equal(redactBlocksRow(row("flow-launch:0:0", "uninformed-flow")), row("flow", "uninformed-flow"));
  assert.equal(redactBlocksRow(row("liquidity", "system")), row("system", "system"));
  assert.equal(redactBlocksRow(row("depeg-dai", "system")), row("system", "system"));
  for (const keep of [
    row("oracle", "system"),
    row("keeper", "system"),
    row("flow-curve:uninformed", "uninformed-flow"),
    row("flow-whale-fan", "agent"),
    "round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType",
  ])
    assert.equal(redactBlocksRow(keep), keep);
});

/** A run in progress: header, a block, and an environment submission the next block has not mined. */
function liveRun(root: string, id: string, resetUnit: "continuous" | "scenario"): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    [
      { type: "run_started_realtime", runId: id, seed: 1, resetUnit },
      { type: "round_timing", blockNumber: 100 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "blocks.csv"),
    "round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex,method,gasUsed,maxFeePerGasWei\n",
  );
  return dir;
}

test("the live tail holds an unmined submission and delivers it once mined, losing nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "eris-runs-api-"));
  const id = "2026-11-03T10-00-00-000Z";
  const dir = liveRun(root, id, "continuous");
  const append = (e: Record<string, unknown>) =>
    appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(e)}\n`);
  const { get, close } = await serve(root, true);
  try {
    let offset = 0;
    const received: Record<string, unknown>[] = [];
    const poll = async () => {
      const body = JSON.parse((await get(`/${id}/tail/events.jsonl?offset=${offset}`)).text) as {
        offset: number;
        text: string;
      };
      offset = body.offset;
      for (const l of body.text.split("\n").filter((x) => x.trim()))
        received.push(JSON.parse(l) as Record<string, unknown>);
    };
    await poll();
    assert.deepEqual(received.map((e) => e.type), ["run_started_realtime", "round_timing"]);
    // Sent with the head at 100; another line follows it in the file.
    const tx = { type: "tx_submitted", hash: "0xaa", headBlock: 100, ownerId: "flow-uniswap:informed", role: "informed-flow" };
    append(tx);
    append({ type: "lst_block", blockNumber: 101, rate: 1 });
    await poll();
    assert.equal(received.length, 2, "held, and what follows it waits behind it");
    const held = offset;
    await poll();
    assert.equal(offset, held, "the offset does not move past a held line");
    append({ type: "round_timing", blockNumber: 101 });
    await poll();
    assert.equal(received.length, 2, "101 is the block it could be in: still pending");
    append({ type: "round_timing", blockNumber: 102 });
    await poll();
    assert.deepEqual(
      received.map((e) => e.type),
      ["run_started_realtime", "round_timing", "tx_submitted", "lst_block", "round_timing", "round_timing"],
      "every line exactly once, in order",
    );
    assert.equal(received[2].hash, "0xaa");
    // A coordinator from before headBlock: dated by the line before it, found by looking back from
    // the tail's start (102). Sent at 103 at the latest, so shown from 105.
    append({ type: "tx_submitted", hash: "0xbb", ownerId: "flow-curve:uninformed", role: "uninformed-flow" });
    append({ type: "round_timing", blockNumber: 103 });
    append({ type: "round_timing", blockNumber: 104 });
    await poll();
    assert.equal(received.length, 6);
    append({ type: "round_timing", blockNumber: 105 });
    await poll();
    assert.deepEqual(received.slice(6).map((e) => e.hash ?? e.blockNumber), ["0xbb", 103, 104, 105]);
    // The run ends: summary.json makes everything mined.
    append({ type: "tx_submitted", hash: "0xcc", headBlock: 105, ownerId: "flow-curve:uninformed", role: "uninformed-flow" });
    await poll();
    assert.equal(received.length, 10);
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ resetUnit: "continuous" }));
    await poll();
    assert.equal(received[10]?.hash, "0xcc");
    assert.equal(offset, readFileSync(join(dir, "events.jsonl")).length, "caught up to the end");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scenario epoch's regime-naming owners are collapsed in events.jsonl and blocks.csv", async () => {
  const root = mkdtempSync(join(tmpdir(), "eris-runs-api-"));
  const id = "2026-11-04T10-00-00-000Z";
  const dir = liveRun(root, id, "scenario");
  appendFileSync(
    join(dir, "events.jsonl"),
    [
      { type: "tx_submitted", hash: "0xw", headBlock: 100, ownerId: "flow-whale:uninformed", role: "uninformed-flow" },
      { type: "round_timing", blockNumber: 102 },
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(""),
  );
  appendFileSync(
    join(dir, "blocks.csv"),
    "101,101,0,0xo,0xa,9,success,oracle,system,,,,setPrice,50000,9\n" +
      "101,101,1,0xw,0xb,1,success,flow-whale:uninformed,uninformed-flow,swap,,,exactInputSingle,90000,1\n" +
      "101,101,2,0xl,0xc,1,success,liquidity,system,,,,decreaseLiquidity,90000,1\n",
  );
  const { get, close } = await serve(root, true);
  try {
    const tail = JSON.parse((await get(`/${id}/tail/events.jsonl?offset=0`)).text) as { text: string };
    const tx = tail.text
      .split("\n")
      .filter((l) => l.includes("tx_submitted"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(tx.length, 1);
    assert.equal(tx[0].ownerId, "flow");
    assert.ok(!tail.text.includes("whale"));
    const whole = await get(`/${id}/blocks.csv`);
    const blocksTail = JSON.parse((await get(`/${id}/tail/blocks.csv?offset=0`)).text) as { text: string };
    for (const text of [whole.text, blocksTail.text]) {
      assert.ok(!text.includes("whale") && !text.includes(",liquidity,"), text);
      assert.ok(text.includes(",flow,uninformed-flow,"));
      assert.ok(text.includes(",oracle,system,"));
      assert.ok(text.includes(",system,system,,,,decreaseLiquidity"));
    }
    // A continuous world is served as written.
    const cont = "2026-11-05T10-00-00-000Z";
    const cdir = liveRun(root, cont, "continuous");
    const row = "101,101,1,0xw,0xb,1,success,flow-whale:uninformed,uninformed-flow,swap,,,exactInputSingle,90000,1\n";
    appendFileSync(join(cdir, "blocks.csv"), row);
    assert.equal((await get(`/${cont}/blocks.csv`)).text, readFileSync(join(cdir, "blocks.csv"), "utf8"));
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator mode serves every file and tail byte for byte", async () => {
  const root = fixtureRuns();
  const id = "2026-11-04T10-00-00-000Z";
  const dir = liveRun(root, id, "scenario");
  appendFileSync(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ type: "tx_submitted", hash: "0xw", headBlock: 100, ownerId: "flow-whale:uninformed" })}\n{"torn":`,
  );
  appendFileSync(join(dir, "blocks.csv"), "101,101,1,0xw,0xb,1,success,flow-whale:uninformed,uninformed-flow,swap");
  const { get, close } = await serve(root, false);
  try {
    for (const run of ["2026-11-01T10-00-00-000Z", "2026-11-02T10-00-00-000Z", id]) {
      for (const file of ["events.jsonl", "blocks.csv"]) {
        const raw = readFileSync(join(root, run, file), "utf8");
        assert.equal((await get(`/${run}/${file}`)).text, raw, `${run}/${file}`);
        const tail = JSON.parse((await get(`/${run}/tail/${file}?offset=0`)).text) as {
          offset: number;
          text: string;
        };
        assert.equal(tail.text, raw, `${run}/tail/${file}`);
        assert.equal(tail.offset, Buffer.byteLength(raw), "no line alignment for the operator");
      }
    }
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});


// A hosted box keeps every smoke and test run its operator ever made under runs/, and the picker
// offered all of them to participants under their internal names. The allowlist is the server's
// answer, so it has to hold for the index, for direct fetches and for tails alike (issue #84 K).
test("an allowlisted competition is served with its scenarios, and nothing else is", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, true, ["matrix-2026-11-01"]);
  try {
    const index = JSON.parse((await get("/index.json")).text) as {
      id: string;
      live?: boolean;
    }[];
    const ids = index.map((e) => e.id);
    assert.ok(ids.includes("matrix-2026-11-01"), "the competition itself");
    assert.ok(
      ids.includes("2026-11-01T10-00-00-000Z"),
      "the run its matrix.json names, resolved as a sibling",
    );
    assert.ok(!ids.includes("practice-period"), "another competition");
    // Membership is what the competition names or contains, never what happens to be running. A
    // live directory nothing connects to this matrix stays out: admitting it would have admitted
    // every live run under runs/ for as long as the matrix was incomplete, which is the whole
    // competition — the operator's own smoke run included.
    assert.ok(
      !ids.includes("2026-11-02T10-00-00-000Z"),
      "a live run the matrix does not name",
    );
    assert.equal(
      (await get("/2026-11-02T10-00-00-000Z/events.jsonl")).status,
      404,
      "and its files are not served either",
    );
    assert.equal((await get("/practice-period/matrix.json")).status, 404);
    assert.equal(
      (await get("/2026-11-01T10-00-00-000Z/summary.json")).status,
      200,
    );
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a practice period admits everything inside it, and nothing outside", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, true, ["practice-period"]);
  try {
    const ids = (
      JSON.parse((await get("/index.json")).text) as { id: string }[]
    ).map((e) => e.id);
    assert.deepEqual(ids, ["practice-period"]);
    // A period's own days live inside its directory, so they are admitted by containment — which
    // is why a practice period's live segment keeps working with no exception for "what is
    // running". A run outside it is not admitted, as a file or as a tail.
    assert.equal(
      (await get("/2026-11-02T10-00-00-000Z/tail/events.jsonl?offset=0")).status,
      404,
      "a tail is withheld the same way a file is",
    );
    assert.equal((await get("/practice-period/matrix.json")).status, 200);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no allowlist serves everything, which is the operator's own view", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, false);
  try {
    const ids = (
      JSON.parse((await get("/index.json")).text) as { id: string }[]
    ).map((e) => e.id);
    assert.ok(ids.includes("practice-period"));
    assert.ok(ids.includes("matrix-2026-11-01"));
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("competitionsFromEnv reads a list, and treats an empty one as unset", () => {
  assert.equal(competitionsFromEnv({}), undefined);
  assert.deepEqual(
    competitionsFromEnv({ ERIS_DASHBOARD_COMPETITIONS: "a, b/c ,/d/" }),
    ["a", "b/c", "d"],
  );
  assert.equal(
    competitionsFromEnv({ ERIS_DASHBOARD_COMPETITIONS: "  ," }),
    undefined,
    "an empty list is not a list of nothing",
  );
});

test("modeFromEnv reads the two switches", () => {
  assert.deepEqual(modeFromEnv({}), { audience: false, standings: true });
  assert.deepEqual(modeFromEnv({ ERIS_DASHBOARD_AUDIENCE: "1" }), {
    audience: true,
    standings: true,
  });
  assert.deepEqual(modeFromEnv({ ERIS_DASHBOARD_STANDINGS: "0" }), {
    audience: false,
    standings: false,
  });
});

test("/manifest.json is the manifest of the run to connect to, among the admitted ones (issue #156)", async () => {
  const root = fixtureRuns();
  // Yesterday's segment (finished) and today's (live) each wrote a manifest; so did an operator's
  // smoke run outside the period, which is live too.
  const day0 = join(root, "practice-period", "day0");
  const day1 = join(root, "practice-period", "day1");
  mkdirSync(day0, { recursive: true });
  mkdirSync(day1, { recursive: true });
  writeFileSync(join(day0, "summary.json"), JSON.stringify({ runId: "day0" }));
  writeFileSync(join(day0, "manifest.json"), JSON.stringify({ day: 0 }));
  writeFileSync(join(day1, "events.jsonl"), '{"type":"run_started_realtime"}\n');
  writeFileSync(join(day1, "manifest.json"), JSON.stringify({ day: 1 }));
  writeFileSync(
    join(root, "2026-11-02T10-00-00-000Z", "manifest.json"),
    JSON.stringify({ day: "smoke" }),
  );
  const { get, close } = await serve(root, true, ["practice-period"]);
  try {
    const res = await get("/manifest.json");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { day: 1 }, "the live segment's, not the smoke run's");
    assert.equal(res.headers.get("content-type"), "application/json");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("/manifest.json is a 404 when no admitted run has written one", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, true, ["matrix-2026-11-01"]);
  try {
    assert.equal((await get("/manifest.json")).status, 404);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the public view withholds who moved value to whom", async () => {
  // rosterTransfers (issue #208) is a recorded fact for the operator to judge under rules §8, not
  // a finding: the same movement is a trade between strangers or self-dealing within one unit
  // depending on who owns both ends, and nothing in the list has been adjudicated. Served during
  // the week it reads as an accusation the audience cannot check, about people who cannot answer.
  const root = fixtureRuns();
  const run = join(root, "2026-11-01T10-00-00-000Z");
  const summary = {
    agents: [
      {
        id: "a",
        pnlUsdc: 1,
        rosterTransfers: [{ route: "erc20", from: "a", to: "b", flagged: true }],
      },
    ],
    rosterTransfers: [{ route: "erc20", from: "a", to: "b", flagged: true }],
  };
  writeFileSync(join(run, "summary.json"), JSON.stringify(summary));
  try {
    const pub = await serve(root, true, ["matrix-2026-11-01"]);
    try {
      const body = JSON.parse((await pub.get("/2026-11-01T10-00-00-000Z/summary.json")).text);
      assert.equal("rosterTransfers" in body, false);
      assert.equal("rosterTransfers" in body.agents[0], false);
      assert.equal(body.agents[0].pnlUsdc, 1, "the score itself is still served");
    } finally {
      await pub.close();
    }
    // The operator's own view keeps them: that is who the list is for.
    const op = await serve(root, false, ["matrix-2026-11-01"]);
    try {
      const body = JSON.parse((await op.get("/2026-11-01T10-00-00-000Z/summary.json")).text);
      assert.equal(body.rosterTransfers.length, 1);
      assert.equal(body.agents[0].rosterTransfers.length, 1);
    } finally {
      await op.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a '..' in the path cannot step from an admitted competition into a run outside it", async () => {
  const root = fixtureRuns();
  // The live epoch 2026-11-02 is in no matrix.json yet, so the allowlist withholds it. Encoded
  // slashes, because fetch (like a browser) would resolve a literal "/../" before sending.
  const escape = "matrix-2026-11-01%2F..%2F2026-11-02T10-00-00-000Z";
  for (const audience of [true, false]) {
    const { get, close } = await serve(root, audience, ["matrix-2026-11-01"]);
    try {
      assert.equal((await get("/2026-11-02T10-00-00-000Z/events.jsonl")).status, 404);
      assert.equal((await get(`/${escape}%2Fevents.jsonl`)).status, 404, `audience=${audience}`);
      assert.equal(
        (await get(`/${escape}/tail/events.jsonl?offset=0`)).status,
        404,
        `audience=${audience}`,
      );
      // Climbing out of runs/ altogether is refused before any allowlist question.
      assert.equal((await get("/..%2F..%2Fetc%2Fpasswd")).status, 403);
      // A '..' that stays inside an admitted run still resolves to it.
      assert.equal(
        (await get("/2026-11-01T10-00-00-000Z%2Fagents%2F..%2Fmarket.json")).status,
        200,
        `audience=${audience}`,
      );
    } finally {
      await close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test("a malformed percent-escape answers 400 and the server keeps serving", async () => {
  const root = fixtureRuns();
  const { get, close } = await serve(root, true, ["matrix-2026-11-01"]);
  try {
    // decodeURIComponent throws on these. The throw used to leave the request handler, which ends
    // the hosted process every viewer shares (issue #203).
    for (const bad of ["/%", "/%E0%A4%A", "/matrix-2026-11-01%2F%ZZ"]) {
      assert.equal((await get(bad)).status, 400, bad);
    }
    assert.equal((await get("/%/tail/events.jsonl?offset=0")).status, 400);
    // Still answering afterwards: the point of the guard.
    assert.equal((await get("/index.json")).status, 200);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink inside an admitted competition does not serve a run outside the allowlist", async () => {
  const root = fixtureRuns();
  // resolveInside follows the link (that is what stops a link from serving the rest of the disk),
  // so the allowlist has to read where the file actually is, not where the request pointed (#202).
  symlinkSync(
    join(root, "2026-11-02T10-00-00-000Z"),
    join(root, "matrix-2026-11-01", "link"),
    "dir",
  );
  for (const audience of [true, false]) {
    const { get, close } = await serve(root, audience, ["matrix-2026-11-01"]);
    try {
      assert.equal(
        (await get("/matrix-2026-11-01/link/events.jsonl")).status,
        404,
        `audience=${audience}`,
      );
      assert.equal(
        (await get("/matrix-2026-11-01/link/tail/events.jsonl?offset=0")).status,
        404,
        `audience=${audience}`,
      );
      // The admitted run's own files still come back.
      assert.equal((await get("/2026-11-01T10-00-00-000Z/market.json")).status, 200);
    } finally {
      await close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});
