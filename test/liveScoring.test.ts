// ADR 0021 §3: the interval boundary is read as it goes past, not swept up when the run ends.
//
// The chain-dependent half of this -- that a boundary read live and the same boundary read
// afterwards produce the same number -- is checked by the coordinator on every run it can
// (`interval_series_agreement`), because what could break it is a venue whose state depends on when it
// is read rather than on which block, and that only shows up on a chain. What is checked here is the
// part that is pure: the boundary walk, the refusal to invent a value for a boundary that failed,
// and the comparator that reports the agreement.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LiveScorer,
  INTERVALS_FILENAME,
} from "../core/src/realtime/liveScoring.js";
import { compareIntervalSeries } from "../core/src/realtime/coordinator.js";
import { RunLogger } from "../core/src/logger.js";
import type { IntervalSeries } from "../core/src/intervalSeries.js";
import type { V0Rule } from "../core/src/scoring/endowmentV0.js";
import { TOKENS } from "@eris/sdk/constants.js";

const AGENTS = [
  { id: "a", address: "0x1111111111111111111111111111111111111111" as const },
  { id: "b", address: "0x2222222222222222222222222222222222222222" as const },
];

// A publicClient stand-in that answers a value cross-section without a chain.
//
// It replies per *call* rather than by position: the head layout depends on how many bases and
// stables the registry holds and on which venues are enabled, and a fixture that hard-codes the
// order silently answers the wrong question the moment a token is added. (It did: the first version
// of this test returned three words per agent and every agent scored zero.)
function fakeClient(opts: {
  valueAt: (block: number) => number;
  failAt?: Set<number>;
}) {
  return {
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: Array<{ address: string; functionName: string }>;
      blockNumber: bigint;
    }) => {
      const block = Number(blockNumber);
      if (opts.failAt?.has(block)) throw new Error(`no state at ${block}`);
      const usdcUnits = BigInt(Math.round(opts.valueAt(block) * 1e6));
      return contracts.map((c) => {
        switch (c.functionName) {
          case "latestAnswer":
            return { status: "success", result: 3000n * 10n ** 8n };
          case "balanceOf":
            return {
              status: "success",
              result:
                c.address.toLowerCase() === TOKENS.USDC.address.toLowerCase()
                  ? usdcUnits
                  : 0n,
            };
          default:
            // answerOf / getEthBalance / anything a venue adds: zero, which is a real balance rather
            // than a failed read.
            return { status: "success", result: 0n };
        }
      });
    },
  } as never;
}

function scorerFixture(opts: {
  runDir: string;
  valueAt: (block: number) => number;
  failAt?: Set<number>;
  runStartBlock?: number;
  endBlock?: number | null;
}) {
  const runStartBlock = opts.runStartBlock ?? 100;
  return new LiveScorer({
    publicClient: fakeClient(opts),
    logger: new RunLogger(opts.runDir, "run"),
    agents: AGENTS,
    enabledIds: [],
    activeStables: [TOKENS.USDC.address],
    priceFeed: "0x3333333333333333333333333333333333333333",
    runStartBlock,
    ...(opts.endBlock !== undefined ? { endBlock: opts.endBlock } : {}),
    intervalBlocks: 4,
    markMedianBlocks: 0,
    sampleMarket: false,
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eris-live-"));
}

test("boundaries land on the interval grid, from the run's first block", async () => {
  const root = tmp();
  const scorer = scorerFixture({ runDir: root, valueAt: (b) => b });
  for (let b = 100; b <= 112; b++) await scorer.onBlock(b);
  const series = scorer.series();
  assert.ok(series);
  assert.deepEqual(series.boundaryBlocks, [100, 104, 108, 112]);
  assert.equal(series.intervals, 3);
  assert.deepEqual(series.valuesByAgent.a, [100, 104, 108, 112]);
});

test("a boundary inside a skipped block is still scored", async () => {
  // The coordinator's block handler drops notifications while it is busy, so onBlock is called with
  // gaps. Matching an index exactly would silently lose those boundaries -- the same way a dropped
  // block once swallowed a whole stress event.
  const root = tmp();
  const scorer = scorerFixture({ runDir: root, valueAt: (b) => b });
  await scorer.onBlock(100);
  await scorer.onBlock(111); // 104 and 108 went past unobserved
  assert.deepEqual(scorer.series()?.boundaryBlocks, [100, 104, 108]);
});

test("the end block is the last boundary, off the grid or on it", async () => {
  // epochExtent.ts: the epoch ends at runStartBlock + runBlocks, and that block is where V_K is read.
  // 10 blocks at 4 per interval: two full intervals and a short third one closed by the end.
  const root = tmp();
  const scorer = scorerFixture({
    runDir: root,
    valueAt: (b) => b,
    endBlock: 110,
  });
  for (let b = 100; b <= 120; b++) await scorer.onBlock(b);
  const series = scorer.series();
  assert.deepEqual(series?.boundaryBlocks, [100, 104, 108, 110]);
  assert.equal(series?.intervals, 3);
  assert.deepEqual(series?.valuesByAgent.a, [100, 104, 108, 110]);
});

test("a lagging loop reads the boundaries it skipped, and none past the end", async () => {
  // The measured failure: a pass told about a head 14 blocks on. Grid boundaries inside the jump are
  // still read (historical reads at their own blocks); the ones beyond the end are not.
  const root = tmp();
  const scorer = scorerFixture({
    runDir: root,
    valueAt: (b) => b,
    endBlock: 112,
  });
  await scorer.onBlock(100);
  await scorer.onBlock(126);
  assert.deepEqual(scorer.series()?.boundaryBlocks, [100, 104, 108, 112]);
});

test("close() gives a wall-clock run its last boundary at the block it ended on", async () => {
  // No block budget: the end is wherever the last pass got to, and it is a boundary like any other.
  const root = tmp();
  const scorer = scorerFixture({ runDir: root, valueAt: (b) => b });
  for (let b = 100; b <= 106; b++) await scorer.onBlock(b);
  assert.deepEqual(scorer.series()?.boundaryBlocks, [100, 104]);
  await scorer.close(106);
  assert.deepEqual(scorer.series()?.boundaryBlocks, [100, 104, 106]);
  await scorer.close(106);
  await scorer.onBlock(108);
  assert.deepEqual(
    scorer.series()?.boundaryBlocks,
    [100, 104, 106],
    "idempotent, and nothing after the end",
  );
});

test("close() reads the end block when the final pass did not", async () => {
  // A final pass that threw before its boundary read: the end is still the end.
  const root = tmp();
  const scorer = scorerFixture({
    runDir: root,
    valueAt: (b) => b,
    endBlock: 112,
  });
  for (let b = 100; b <= 111; b++) await scorer.onBlock(b);
  await scorer.close(112);
  assert.deepEqual(scorer.series()?.boundaryBlocks, [100, 104, 108, 112]);
  await scorer.close(112);
  assert.equal(scorer.count, 4, "no boundary is read twice");
});

test("a boundary that could not be read is dropped, never filled in", async () => {
  // A fabricated value is a fabricated return, and the metric averages returns. Leaving the boundary
  // out costs one interval; inventing one puts a number nobody measured into the score.
  const root = tmp();
  const scorer = scorerFixture({
    runDir: root,
    valueAt: (b) => b,
    failAt: new Set([104]),
  });
  for (let b = 100; b <= 112; b++) await scorer.onBlock(b);
  const series = scorer.series();
  assert.deepEqual(series?.boundaryBlocks, [100, 108, 112]);
  assert.deepEqual(series?.valuesByAgent.a, [100, 108, 112]);
  assert.equal(scorer.meta().failedBoundaries, 1);
});

test("each boundary is appended as it happens, for a live reader to tail", async () => {
  const root = tmp();
  const scorer = scorerFixture({ runDir: root, valueAt: (b) => b });
  await scorer.onBlock(100);
  const path = join(root, "run", INTERVALS_FILENAME);
  assert.equal(INTERVALS_FILENAME, "intervals.jsonl");
  assert.ok(
    existsSync(path),
    "intervals.jsonl exists after the first boundary",
  );
  assert.ok(
    !existsSync(join(root, "run", "epochs.jsonl")),
    "the old file name is read, not written",
  );
  const first = JSON.parse(readFileSync(path, "utf8").trim());
  assert.equal(first.index, 0);
  assert.equal(first.blockNumber, 100);
  assert.equal(first.values.a, 100);
  await scorer.onBlock(104);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
});

test("one boundary is not a series: there is no return to score", async () => {
  const root = tmp();
  const scorer = scorerFixture({ runDir: root, valueAt: (b) => b });
  await scorer.onBlock(100);
  assert.equal(scorer.series(), undefined);
});

test("the agreement comparator reports the worst boundary, not just a verdict", () => {
  const live: IntervalSeries = {
    intervalBlocks: 4,
    intervals: 2,
    boundaryBlocks: [100, 104, 108],
    valuesByAgent: { a: [10, 20, 30], b: [1, 2, 3] },
  };
  const same = compareIntervalSeries(live, live);
  assert.equal(same.compared, 6);
  assert.equal(same.maxAbsDiffUsdc, 0);
  assert.equal(same.worst, undefined);

  const drifted: IntervalSeries = {
    ...live,
    valuesByAgent: { a: [10, 20, 33], b: [1, 2, 3] },
  };
  const diff = compareIntervalSeries(live, drifted);
  assert.equal(diff.maxAbsDiffUsdc, 3);
  assert.equal(diff.worst?.agentId, "a");
  assert.equal(diff.worst?.boundaryBlock, 108);
  assert.ok(Math.abs(diff.maxRelDiff - 3 / 33) < 1e-9);
});

test("the comparator only compares boundaries both series hold", () => {
  // A live run that lost a boundary and a sweep that read every one are not misaligned; they simply
  // overlap on fewer blocks. Comparing by index rather than by block would offset the whole series.
  const live: IntervalSeries = {
    intervalBlocks: 4,
    intervals: 1,
    boundaryBlocks: [100, 108],
    valuesByAgent: { a: [10, 30] },
  };
  const swept: IntervalSeries = {
    intervalBlocks: 4,
    intervals: 2,
    boundaryBlocks: [100, 104, 108],
    valuesByAgent: { a: [10, 20, 30] },
  };
  const r = compareIntervalSeries(live, swept);
  assert.equal(r.compared, 2);
  assert.equal(r.maxAbsDiffUsdc, 0);
});

// ---------------------------------------------------------------------------
// Issue #207: the first boundary is V_0, and there the measured value is floored at the endowment.
// ---------------------------------------------------------------------------

// The fake above answers USDC = valueAt(block) for every agent; an endowment of N USDC is a snapshot
// the scorer values at par, so the floor is easy to read off.
function usdcEndowment(usdc: number) {
  const units = BigInt(usdc) * 10n ** 6n;
  return {
    ethWei: 0n,
    wethWei: 0n,
    usdcUnits: units,
    bases: { WETH: 0n },
    stables: { [TOKENS.USDC.address.toLowerCase()]: units },
  };
}

function flooredFixture(opts: {
  runDir: string;
  valueAt: (block: number) => number;
  endowments: Record<string, number | undefined>;
  failAt?: Set<number>;
  v0Rule?: V0Rule;
}) {
  return new LiveScorer({
    publicClient: fakeClient(opts),
    logger: new RunLogger(opts.runDir, "run"),
    agents: AGENTS.map((a) => ({
      ...a,
      ...(opts.endowments[a.id] !== undefined
        ? { endowment: usdcEndowment(opts.endowments[a.id] as number) }
        : {}),
    })),
    enabledIds: [],
    activeStables: [TOKENS.USDC.address],
    priceFeed: "0x3333333333333333333333333333333333333333",
    runStartBlock: 100,
    intervalBlocks: 4,
    markMedianBlocks: 0,
    sampleMarket: false,
    ...(opts.v0Rule ? { v0Rule: opts.v0Rule } : {}),
  });
}

test("the first boundary is floored at the endowment; every later one is measured", async () => {
  // Both agents show 30 on the chain at block 100 (a parked 70 of a 100 endowment, say), and 104
  // thereafter. `a` was funded with 100 and `b` is unknown to the environment.
  const root = tmp();
  const scorer = flooredFixture({
    runDir: root,
    valueAt: (b) => (b === 100 ? 30 : b),
    endowments: { a: 100, b: undefined },
  });
  for (let b = 100; b <= 108; b++) await scorer.onBlock(b);
  const series = scorer.series();
  assert.deepEqual(series?.valuesByAgent.a, [100, 104, 108]);
  assert.deepEqual(series?.valuesByAgent.b, [30, 104, 108]);
  assert.equal(scorer.firstBoundaryBlock, 100);
  assert.deepEqual(scorer.firstBoundary("a"), {
    valueUsdc: 100,
    source: "endowment",
    measuredUsdc: 30,
    endowmentUsdc: 100,
  });
  assert.equal(scorer.firstBoundary("b")?.source, "measured");

  // The row a live reader tails says the same: V_0 as used, and what the chain showed.
  const rows = readFileSync(join(root, "run", INTERVALS_FILENAME), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows[0].values.a, 100);
  assert.deepEqual(rows[0].v0SourceByAgent, { a: "endowment", b: "measured" });
  assert.deepEqual(rows[0].v0MeasuredByAgent, { a: 30, b: 30 });
  assert.deepEqual(rows[0].v0EndowmentByAgent, { a: 100 });
  assert.equal(rows[1].v0SourceByAgent, undefined, "only the first boundary says so");
});

test("a chain that shows more than the endowment at the first boundary keeps it", async () => {
  const root = tmp();
  const scorer = flooredFixture({
    runDir: root,
    valueAt: () => 130,
    endowments: { a: 100, b: 100 },
  });
  await scorer.onBlock(100);
  await scorer.onBlock(104);
  assert.deepEqual(scorer.series()?.valuesByAgent.a, [130, 130]);
  assert.equal(scorer.firstBoundary("a")?.source, "measured");
  assert.equal(scorer.firstBoundary("a")?.endowmentUsdc, 100);
});

test("a scenario pins V_0 to the endowment: a gift before the bell is not subtracted", async () => {
  // The gift attack on the floor: someone hands `a` an LP worth 30 before boundary 0 and drains it
  // during the epoch. Floored, V_0 = 130 and P = 100 − 130 = −30 for doing nothing. Pinned, V_0 is
  // the 100 the environment gave, and the gift nets out.
  const root = tmp();
  const scorer = flooredFixture({
    runDir: root,
    valueAt: (b) => (b === 100 ? 130 : 100),
    endowments: { a: 100, b: undefined },
    v0Rule: "pinned",
  });
  for (let b = 100; b <= 108; b++) await scorer.onBlock(b);
  const series = scorer.series();
  assert.deepEqual(series?.valuesByAgent.a, [100, 100, 100]);
  assert.deepEqual(scorer.firstBoundary("a"), {
    valueUsdc: 100,
    source: "endowment",
    measuredUsdc: 130,
    endowmentUsdc: 100,
  });
  // An agent the environment did not fund has nothing to pin to: measured, as under the floor.
  assert.deepEqual(series?.valuesByAgent.b, [130, 100, 100]);
  assert.equal(scorer.firstBoundary("b")?.source, "measured");
});

test("when the run's first boundary could not be read, no later boundary is floored", async () => {
  // Block 100 fails, so 104 is the first boundary the scorer holds. It is not V_0 in the sense of
  // issue #207 -- the sweep floors only fromBlock -- and flooring it would make a first-interval
  // loss count (V_0 raised to the endowment) while a first-interval gain vanished.
  const root = tmp();
  const scorer = flooredFixture({
    runDir: root,
    valueAt: (b) => (b === 104 ? 30 : b),
    endowments: { a: 100, b: 100 },
    failAt: new Set([100]),
  });
  for (let b = 100; b <= 108; b++) await scorer.onBlock(b);
  const series = scorer.series();
  assert.deepEqual(series?.boundaryBlocks, [104, 108]);
  assert.deepEqual(series?.valuesByAgent.a, [30, 108]);
  assert.equal(scorer.firstBoundaryBlock, null);
  assert.equal(scorer.firstBoundary("a"), undefined);
  const rows = readFileSync(join(root, "run", INTERVALS_FILENAME), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows[0].v0SourceByAgent, undefined);
  // And it says so. Without this line the epoch is indistinguishable from an ordinary one: every
  // agent's v0Source comes out "measured", which is also what a carried-over segment looks like,
  // and the flag that names issue #207's attack needs the endowment V_0 the floor would have
  // produced. So the one epoch with no floor would read as the normal case.
  const events = readFileSync(join(root, "run", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const skipped = events.filter((e) => e.type === "interval_v0_floor_skipped");
  assert.equal(skipped.length, 1, "said once");
  assert.equal(skipped[0].boundaryBlock, 104);
  assert.equal(skipped[0].runStartBlock, 100);
});

test("the sweep floors the same boundary at the same endowment, so the two series agree", async () => {
  // compareIntervalSeries is what the coordinator reports; here the sweep is the one reader with
  // the endowment applied, against a live series built the same way.
  const { reconstructValueSeries } = await import(
    "../core/src/realtime/reconstruct.js"
  );
  const root = tmp();
  const valueAt = (b: number) => (b === 100 ? 30 : b);
  const live = flooredFixture({
    runDir: root,
    valueAt,
    endowments: { a: 100, b: undefined },
  });
  for (let b = 100; b <= 108; b++) await live.onBlock(b);
  // The sweep also reads the reference fair for alpha and scans Transfer logs for unaccounted
  // tokens; the fixture above answers multicalls only.
  const sweepClient = {
    ...(fakeClient({ valueAt }) as unknown as Record<string, unknown>),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "latestAnswer" ? 3000n * 10n ** 8n : 0n,
    getLogs: async () => [],
  } as never;
  const swept = await reconstructValueSeries({
    publicClient: sweepClient,
    logger: new RunLogger(root, "sweep"),
    agents: AGENTS.map((a) => ({
      ...a,
      ...(a.id === "a" ? { endowment: usdcEndowment(100) } : {}),
    })),
    enabledIds: [],
    activeStables: [TOKENS.USDC.address],
    priceFeed: "0x3333333333333333333333333333333333333333",
    fromBlock: 100,
    toBlock: 108,
    scoreEvery: 4,
    intervalBlocks: 4,
    markMedianBlocks: 0,
  });
  assert.deepEqual(swept.intervalSeries?.valuesByAgent.a, [100, 104, 108]);
  assert.deepEqual(swept.intervalSeries?.valuesByAgent.b, [30, 104, 108]);
  const agreement = compareIntervalSeries(live.series()!, swept.intervalSeries!);
  assert.equal(agreement.compared, 6);
  assert.equal(agreement.maxAbsDiffUsdc, 0);
  // Alpha's first cross-section is floored too: a parked basket is not β-removed skill.
  assert.equal(swept.alphaByAgent.a, 8);
  assert.equal(swept.alphaByAgent.b, 78);
});

test("the sweep pins the same boundary when the live scorer does, so the two still agree", async () => {
  const { reconstructValueSeries } = await import(
    "../core/src/realtime/reconstruct.js"
  );
  const root = tmp();
  const valueAt = (b: number) => (b === 100 ? 130 : b);
  const live = flooredFixture({
    runDir: root,
    valueAt,
    endowments: { a: 100, b: undefined },
    v0Rule: "pinned",
  });
  for (let b = 100; b <= 108; b++) await live.onBlock(b);
  const sweepClient = {
    ...(fakeClient({ valueAt }) as unknown as Record<string, unknown>),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "latestAnswer" ? 3000n * 10n ** 8n : 0n,
    getLogs: async () => [],
  } as never;
  const swept = await reconstructValueSeries({
    publicClient: sweepClient,
    logger: new RunLogger(root, "sweep"),
    agents: AGENTS.map((a) => ({
      ...a,
      ...(a.id === "a" ? { endowment: usdcEndowment(100) } : {}),
    })),
    enabledIds: [],
    activeStables: [TOKENS.USDC.address],
    priceFeed: "0x3333333333333333333333333333333333333333",
    fromBlock: 100,
    toBlock: 108,
    scoreEvery: 4,
    intervalBlocks: 4,
    markMedianBlocks: 0,
    v0Rule: "pinned",
  });
  assert.deepEqual(swept.intervalSeries?.valuesByAgent.a, [100, 104, 108]);
  const agreement = compareIntervalSeries(live.series()!, swept.intervalSeries!);
  assert.equal(agreement.maxAbsDiffUsdc, 0);
  // Alpha's first cross-section is pinned the same way.
  assert.equal(swept.alphaByAgent.a, 8);
});

// The practice period's resume (periodResume.ts): a restarted coordinator rebuilds the series from
// the intervals.jsonl lines the scorer appended, plus the snapshot's bookkeeping, and carries on as
// if it had never stopped.
test("a scorer restored from its lines and snapshot continues the same series", async () => {
  const failAt = new Set([104]);
  const straight = scorerFixture({ runDir: tmp(), valueAt: (b) => b, failAt });
  for (let b = 100; b <= 120; b++) await straight.onBlock(b);

  const before = tmp();
  const first = scorerFixture({ runDir: before, valueAt: (b) => b, failAt });
  for (let b = 100; b <= 109; b++) await first.onBlock(b);
  const saved = first.snapshot();
  const lines = readFileSync(join(before, "run", INTERVALS_FILENAME), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { blockNumber: number; values: Record<string, number | null> });

  const resumed = scorerFixture({ runDir: tmp(), valueAt: (b) => b, failAt });
  resumed.restore(saved, lines);
  for (let b = 110; b <= 120; b++) await resumed.onBlock(b);

  assert.deepEqual(resumed.series(), straight.series());
  assert.equal(resumed.meta().failedBoundaries, 1, "the failure before the restart still counts");
  assert.equal(resumed.firstBoundaryBlock, 100);
  assert.deepEqual(resumed.firstBoundary("a"), straight.firstBoundary("a"));
});

test("restore refuses boundaries the snapshot never attempted", () => {
  const scorer = scorerFixture({ runDir: tmp(), valueAt: (b) => b });
  const snapshot = {
    lastAttempted: 104,
    failures: 0,
    endBlock: null,
    firstBoundaryBlock: 100,
    firstBoundaryByAgent: {},
  };
  assert.throws(
    () => scorer.restore(snapshot, [{ blockNumber: 100, values: {} }, { blockNumber: 108, values: {} }]),
    /past the last one the snapshot attempted/,
  );
  assert.throws(
    () => scorer.restore(snapshot, [{ blockNumber: 104, values: {} }, { blockNumber: 100, values: {} }]),
    /out of order/,
  );
});
