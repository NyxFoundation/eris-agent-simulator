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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  competitionsFromEnv,
  createRunsApi,
  modeFromEnv,
  redactEventLine,
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
    JSON.stringify({ k: 40, epochs: [{ s: 3, regime: "crash", seed: 4242 }] }),
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
      assert.equal(started.rpcUrl, "http://127.0.0.1:8545");
      const schedule = events.find((e) => e.type === "stress_schedule")!;
      const windows = schedule.events as { type: string }[];
      assert.deepEqual(
        windows.map((w) => w.type),
        ["crash"],
        "only the window that has closed by block 200",
      );
      const pool = events.find((e) => e.type === "pool_created")!;
      assert.equal(pool.rigged, undefined);
      assert.equal(pool.rugBps, undefined);
      assert.equal(pool.feeBps, 30);
      const exited = events.find((e) => e.type === "agent_process_exited")!;
      assert.equal(exited.stderrTail, undefined);
      assert.equal(exited.code, 137);
      assert.ok(types.includes("stress_liquidation"), "realized events stay");
    }
    // A scenario matrix's epoch: the window closed at block 147 and the run is at 300, and still
    // nothing of the plan is served -- its kind would name the regime (rules §3.3).
    const epoch = await get("/2026-11-02T10-00-00-000Z/events.jsonl");
    const epochTypes = epoch.text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as { type: string }).type);
    assert.ok(!epochTypes.includes("stress_schedule"), "no schedule for a scenario epoch");
    assert.ok(epochTypes.includes("stress_liquidation"));
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
  assert.equal(redactEventLine("not json", past(1)), "not json");
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
