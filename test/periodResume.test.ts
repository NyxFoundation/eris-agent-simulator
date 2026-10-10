// A practice period resumes after the coordinator restarts (core/src/realtime/periodResume.ts).
//
// The chain-facing half -- that a coordinator killed mid-period comes back on the same chain, the
// same directory and the same standings -- needs a chain and is checked by running one. What is
// checked here is the part that decides what a restart does: which checkpoint the chain is on, what
// of the directory is cut back, what may change in the config, and that segmenting and the series
// pick up where they were.
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_HISTORY_EVERY_BLOCKS,
  CHECKPOINT_HISTORY_KEEP,
  CHECKPOINT_SCHEMA,
  CheckpointWriter,
  chooseCheckpoint,
  closePeriod,
  configDiff,
  configMutable,
  configWorld,
  cutArtifactsToCheckpoint,
  decodeCheckpoint,
  encodeCheckpoint,
  openPeriods,
  readPeriodBoundaries,
  resumeUnsupportedReasons,
  segmentFileSizes,
  type PeriodCheckpoint,
} from "../core/src/realtime/periodResume.js";
import { SegmentedRun } from "../core/src/segments.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eris-resume-"));
}

function checkpoint(
  overrides: Partial<PeriodCheckpoint> = {},
): PeriodCheckpoint {
  return {
    schema: CHECKPOINT_SCHEMA,
    writtenAt: "2026-10-08T12:00:00.000Z",
    competitionId: "period",
    chainId: 31337,
    lastProcessedBlock: 1000,
    lastProcessedHash: "0xaaa",
    runStartBlock: 100,
    runBlocks: 5000,
    endBlock: 5100,
    runStartedAtMs: Date.parse("2026-10-08T11:00:00.000Z"),
    world: { seed: 1 },
    mutable: { maxPriorityFeeWei: "5000000000" },
    resumable: { ok: true, reasons: [] },
    starts: 1,
    priceFeed: "0x0000000000000000000000000000000000000001",
    walk: {
      baseFair: 3000,
      fairAnchor: 3000,
      extraBaseFair: {},
      extraAnchor: {},
      latestFairPrice: 3000,
      fairPrices: { WETH: 3000 },
      rng: { WETH: { kind: "keyed", draws: 12 } },
    },
    agents: [],
    loggedThroughBlock: 999,
    derivedSenders: [],
    stressAudit: [],
    scorer: {
      lastAttempted: 1000,
      failures: 0,
      endBlock: 5100,
      firstBoundaryBlock: 100,
      firstBoundaryByAgent: {},
    },
    segments: {
      segment: 0,
      segmentDirId: "2026-10-08-s00",
      segmentStartedAtMs: Date.parse("2026-10-08T11:00:00.000Z"),
      segmentStartBlock: 100,
      periodStartedAtMs: Date.parse("2026-10-08T11:00:00.000Z"),
      nextRollAtMs: Date.parse("2026-10-09T11:00:00.000Z"),
    },
    files: {},
    liquidityPull: null,
    depegs: [],
    lstExhaustedReported: false,
    ...overrides,
  };
}

test("a checkpoint round-trips, bigints included", () => {
  const cp = checkpoint({
    agents: [
      {
        id: "a",
        origin: "config",
        spec: { id: "a", wallet: "AUTO" },
        address: "0x1111111111111111111111111111111111111111",
        external: false,
        initial: {
          ethWei: 10n ** 18n,
          wethWei: 8n * 10n ** 18n,
          usdcUnits: 25_000_000_000n,
          bases: { WBTC: 40_000_000n },
        },
        included: 3,
        reverted: 1,
      },
    ],
    liquidityPull: {
      seededShares: { "uniswap:WETH-USDC": 123456789012345678901234n },
      restoreReported: true,
    },
    depegs: [
      {
        symbol: "DAI",
        seededPoolStableWei: 10n ** 23n,
        startStableWei: 5n * 10n ** 22n,
        cappedReported: false,
      },
    ],
  });
  const back = decodeCheckpoint(encodeCheckpoint(cp));
  assert.deepEqual(back, cp);
  assert.equal(typeof back.agents[0].initial.bases?.WBTC, "bigint");
  assert.throws(
    () => decodeCheckpoint(encodeCheckpoint({ ...cp, schema: 99 })),
    /schema 99/,
  );
});

test("the writer keeps state.json every pass and a history copy every N blocks, bounded", () => {
  const dir = tmp();
  const writer = new CheckpointWriter(dir);
  const last = CHECKPOINT_HISTORY_EVERY_BLOCKS * (CHECKPOINT_HISTORY_KEEP + 5);
  for (let b = 1; b <= last; b++)
    writer.write(checkpoint({ lastProcessedBlock: b }));
  const state = decodeCheckpoint(
    readFileSync(join(dir, "resume", "state.json"), "utf8"),
  );
  assert.equal(state.lastProcessedBlock, last);
  const history = readdirSync(join(dir, "resume", "history")).sort();
  assert.equal(history.length, CHECKPOINT_HISTORY_KEEP);
  const blocks = history.map((f) => Number(f.slice(0, -5)));
  for (let i = 1; i < blocks.length; i++)
    assert.equal(blocks[i] - blocks[i - 1], CHECKPOINT_HISTORY_EVERY_BLOCKS);
  // A writer opened on the same directory (a resumed period) carries the cadence on.
  const again = new CheckpointWriter(dir);
  again.write(checkpoint({ lastProcessedBlock: last + 1 }));
  assert.equal(
    readdirSync(join(dir, "resume", "history")).length,
    CHECKPOINT_HISTORY_KEEP,
  );
});

function periodDir(root: string, id: string, cp: PeriodCheckpoint): string {
  const dir = join(root, id);
  new CheckpointWriter(dir).write(cp);
  return dir;
}

test("open periods are the ones with a checkpoint that were neither finished nor superseded", () => {
  const root = tmp();
  periodDir(root, "old", checkpoint({ runStartedAtMs: 1 }));
  const closed = periodDir(root, "closed", checkpoint({ runStartedAtMs: 3 }));
  periodDir(root, "new", checkpoint({ runStartedAtMs: 2 }));
  mkdirSync(join(root, "no-checkpoint"));
  closePeriod(closed, "completed");
  assert.deepEqual(
    openPeriods(root).map((p) => p.competitionId),
    ["new", "old"],
  );
  assert.deepEqual(openPeriods(join(root, "missing")), []);
});

test("the checkpoint a resume picks is the newest one the chain holds", async () => {
  const root = tmp();
  const dir = join(root, "p");
  const writer = new CheckpointWriter(dir);
  // Blocks 1..100; history at 1, 31, 61, 91.
  for (let b = 1; b <= 100; b++)
    writer.write(
      checkpoint({ lastProcessedBlock: b, lastProcessedHash: `0x${b}` }),
    );
  const [period] = openPeriods(root);
  const chain = (head: number, fork?: number) => ({
    head,
    hashAt: async (b: number) =>
      b > head
        ? null
        : fork !== undefined && b > fork
          ? `0xfork${b}`
          : `0x${b}`,
  });

  // The coordinator died; the chain kept going. state.json is on it.
  const ahead = await chooseCheckpoint(period, chain(140));
  assert.equal(ahead.kind, "match");
  assert.equal(
    ahead.kind === "match" && ahead.checkpoint.lastProcessedBlock,
    100,
  );
  assert.equal(ahead.kind === "match" && ahead.rewound, false);

  // anvil came back from a dump taken at block 75: the newest history copy at or below it.
  const back = await chooseCheckpoint(period, chain(75));
  assert.equal(back.kind === "match" && back.checkpoint.lastProcessedBlock, 61);
  assert.equal(back.kind === "match" && back.rewound, true);

  // Same height, different chain past block 40 (a reset and new blocks): the copy before it.
  const forked = await chooseCheckpoint(period, chain(140, 40));
  assert.equal(
    forked.kind === "match" && forked.checkpoint.lastProcessedBlock,
    31,
  );

  // A chain that holds none of them.
  const none = await chooseCheckpoint(period, chain(140, 0));
  assert.equal(none.kind, "refused");
  assert.match(
    none.kind === "refused" ? none.reason : "",
    /holds none of period p's checkpoints/,
  );
});

test("the world is every config key but the mutable and process-local ones", () => {
  const config = {
    seed: 1,
    runEndsAt: "2026-10-31T14:59:59.000Z",
    maxPriorityFeeWei: 5_000_000_000n,
    economicGas: false,
    rpcUrl: "http://a",
    runBlocks: 999,
    privateKeys: { admin: "0xsecret" },
    stressEvents: [{ type: "crash", magnitudeRange: [0.1, 0.2] }],
  };
  const world = configWorld(config, { roster: [{ id: "a" }] });
  assert.deepEqual(Object.keys(world).sort(), [
    "$roster",
    "runEndsAt",
    "seed",
    "stressEvents",
  ]);
  assert.ok(
    !JSON.stringify(world).includes("secret"),
    "keys never enter the record",
  );

  // The fee rule may change across a restart; the episodes may not.
  const feesChanged = configWorld(
    {
      ...config,
      maxPriorityFeeWei: 0n,
      economicGas: true,
      rpcUrl: "http://b",
      runBlocks: 5,
    },
    { roster: [{ id: "a" }] },
  );
  assert.deepEqual(configDiff(world, feesChanged), []);
  assert.deepEqual(
    configDiff(
      configMutable(config),
      configMutable({ ...config, economicGas: true }),
    ),
    ["economicGas: false -> true"],
  );
  const worldChanged = configWorld(
    { ...config, stressEvents: [], seed: 2 },
    { roster: [{ id: "a" }, { id: "b" }] },
  );
  assert.deepEqual(
    configDiff(world, worldChanged).map((d) => d.split(":")[0]),
    ["$roster", "seed", "stressEvents"],
  );
});

test("features whose state the checkpoint does not carry make a period unresumable", () => {
  const none = {
    agentMarkets: false,
    tokenLaunch: false,
    vulnEvents: false,
    stressVictims: 0,
    liquityVictims: 0,
    prewarmBlocks: 0,
  };
  assert.deepEqual(resumeUnsupportedReasons(none), []);
  assert.equal(
    resumeUnsupportedReasons({ ...none, agentMarkets: true, stressVictims: 2 })
      .length,
    2,
  );
});

// A directory as a period leaves it: matrix.json, the current segment with its appended files.
function periodOnDisk(): { root: string; dir: string; seg0: string } {
  const root = tmp();
  const run = new SegmentedRun({
    root,
    competitionId: "p",
    hours: 24,
    scenarioSet: "practice",
  });
  run.noteFirstBlock(100, Date.parse("2026-10-08T11:00:00.000Z"));
  return { root, dir: join(root, "p"), seg0: run.runDir };
}

test("a resume cuts the rederived files back to the checkpoint, and the log only when the chain went back", () => {
  const { dir, seg0 } = periodOnDisk();
  appendFileSync(join(seg0, "blocks.csv"), "row-before\n");
  appendFileSync(
    join(seg0, "intervals.jsonl"),
    `${JSON.stringify({ blockNumber: 100, values: { a: 1 } })}\n`,
  );
  appendFileSync(join(seg0, "events.jsonl"), '{"type":"before"}\n');
  const segmentDirId = seg0.split("/").at(-1) as string;
  const cp = checkpoint({
    files: segmentFileSizes(seg0),
    segments: { ...checkpoint().segments, segmentDirId },
  });
  appendFileSync(join(seg0, "blocks.csv"), "row-after\n");
  appendFileSync(
    join(seg0, "intervals.jsonl"),
    `${JSON.stringify({ blockNumber: 112, values: { a: 2 } })}\n`,
  );
  appendFileSync(join(seg0, "events.jsonl"), '{"type":"after"}\n');

  const crash = cutArtifactsToCheckpoint(dir, cp, { rewound: false });
  assert.ok(
    !readFileSync(join(seg0, "blocks.csv"), "utf8").includes("row-after"),
  );
  assert.ok(
    readFileSync(join(seg0, "events.jsonl"), "utf8").includes("after"),
    "a crash keeps its log",
  );
  assert.deepEqual(crash.truncated.map((t) => t.file.split("/")[1]).sort(), [
    "blocks.csv",
    "intervals.jsonl",
  ]);
  // What was cut is kept, not deleted.
  assert.match(
    readFileSync(join(crash.cutDir, segmentDirId, "blocks.csv"), "utf8"),
    /^row-after\n$/,
  );

  appendFileSync(join(seg0, "events.jsonl"), '{"type":"after-again"}\n');
  cutArtifactsToCheckpoint(dir, cp, {
    rewound: true,
    at: new Date(Date.now() + 1000),
  });
  assert.ok(
    !readFileSync(join(seg0, "events.jsonl"), "utf8").includes("after"),
    "a rewind cuts the log",
  );
  assert.deepEqual(
    readPeriodBoundaries(dir, cp).map((b) => b.blockNumber),
    [100],
  );
});

test("a roll the checkpoint did not see is undone: the new segment moved out, the old one open again", () => {
  const root = tmp();
  const run = new SegmentedRun({
    root,
    competitionId: "p",
    hours: 24,
    scenarioSet: "practice",
  });
  const t0 = Date.parse("2026-10-08T11:00:00.000Z");
  run.noteFirstBlock(100, t0);
  const seg0 = run.runDir;
  appendFileSync(
    join(seg0, "intervals.jsonl"),
    `${JSON.stringify({ blockNumber: 100, values: { a: 1 } })}\n`,
  );
  const cp = checkpoint({
    files: segmentFileSizes(seg0),
    segments: run.state(),
  });
  // The pass after the checkpoint rolled the segment (and the crash came before the next checkpoint).
  appendFileSync(
    join(seg0, "intervals.jsonl"),
    `${JSON.stringify({ blockNumber: 900, values: { a: 2 } })}\n`,
  );
  run.summary({ closed: true });
  const seg1 = run.roll(900, [{ id: "a", scored: true }], t0 + 24 * 3600_000);
  assert.ok(existsSync(seg1));

  const report = cutArtifactsToCheckpoint(join(root, "p"), cp, {
    rewound: false,
  });
  assert.deepEqual(report.movedSegments, [seg1.split("/").at(-1)]);
  assert.ok(!existsSync(seg1));
  assert.ok(
    !existsSync(join(seg0, "summary.json")),
    "the reopened segment has no summary yet",
  );

  const index = JSON.parse(
    readFileSync(join(root, "p", "matrix.json"), "utf8"),
  ).scenarios;
  const resumed = new SegmentedRun(
    { root, competitionId: "p", hours: 24, scenarioSet: "practice" },
    { state: cp.segments, index },
  );
  assert.equal(resumed.runDir, seg0);
  assert.equal(resumed.currentSegment, 0);
  assert.equal(resumed.currentSegmentStartBlock, 100);
  const after = JSON.parse(
    readFileSync(join(root, "p", "matrix.json"), "utf8"),
  ).scenarios;
  assert.equal(after.length, 1);
  assert.equal(after[0].endedAt, undefined);
  assert.deepEqual(after[0].agents, []);
  assert.equal(
    readFileSync(join(root, "p", "current-segment"), "utf8").trim(),
    seg0,
  );
  // Opening it again appends rather than starting the files over.
  assert.ok(
    readFileSync(join(seg0, "intervals.jsonl"), "utf8").includes(
      '"blockNumber":100',
    ),
  );
  assert.deepEqual(resumed.state(), cp.segments);
});

test("the period's boundaries are read across every segment up to the checkpoint's", () => {
  const root = tmp();
  const run = new SegmentedRun({
    root,
    competitionId: "p",
    hours: 24,
    scenarioSet: "practice",
  });
  const t0 = Date.parse("2026-10-08T11:00:00.000Z");
  run.noteFirstBlock(100, t0);
  run.append("intervals.jsonl", { blockNumber: 100, values: { a: 1 } });
  run.append("intervals.jsonl", { blockNumber: 1000, values: { a: 2 } });
  run.roll(1000, [], t0 + 24 * 3600_000);
  run.append("intervals.jsonl", { blockNumber: 1900, values: { a: 3, b: 7 } });
  const cp = checkpoint({
    files: segmentFileSizes(run.runDir),
    segments: run.state(),
  });
  writeFileSync(join(run.runDir, "unrelated.txt"), "x");
  assert.deepEqual(readPeriodBoundaries(join(root, "p"), cp), [
    { blockNumber: 100, values: { a: 1 } },
    { blockNumber: 1000, values: { a: 2 } },
    { blockNumber: 1900, values: { a: 3, b: 7 } },
  ]);
});
