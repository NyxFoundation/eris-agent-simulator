// ADR 0021 §3: the epoch boundary is read as it goes past, not swept up when the run ends.
//
// The chain-dependent half of this -- that a boundary read live and the same boundary read
// afterwards produce the same number -- is checked by the coordinator on every run it can
// (`epoch_series_agreement`), because what could break it is a venue whose state depends on when it
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
  EPOCHS_FILENAME,
} from "../core/src/realtime/liveScoring.js";
import { compareEpochSeries } from "../core/src/realtime/coordinator.js";
import { RunLogger } from "../core/src/logger.js";
import type { EpochSeries } from "../core/src/realtime/reconstruct.js";
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
    epochBlocks: 4,
    markMedianBlocks: 0,
    sampleMarket: false,
  });
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eris-live-"));
}

test("boundaries land on the epoch grid, from the run's first block", async () => {
  const root = tmp();
  const scorer = scorerFixture({ runDir: root, valueAt: (b) => b });
  for (let b = 100; b <= 112; b++) await scorer.onBlock(b);
  const series = scorer.series();
  assert.ok(series);
  assert.deepEqual(series.boundaryBlocks, [100, 104, 108, 112]);
  assert.equal(series.epochs, 3);
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

test("a boundary that could not be read is dropped, never filled in", async () => {
  // A fabricated value is a fabricated return, and the metric averages returns. Leaving the boundary
  // out costs one epoch; inventing one puts a number nobody measured into the score.
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
  const path = join(root, "run", EPOCHS_FILENAME);
  assert.ok(existsSync(path), "epochs.jsonl exists after the first boundary");
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
  const live: EpochSeries = {
    epochBlocks: 4,
    epochs: 2,
    boundaryBlocks: [100, 104, 108],
    valuesByAgent: { a: [10, 20, 30], b: [1, 2, 3] },
  };
  const same = compareEpochSeries(live, live);
  assert.equal(same.compared, 6);
  assert.equal(same.maxAbsDiffUsdc, 0);
  assert.equal(same.worst, undefined);

  const drifted: EpochSeries = {
    ...live,
    valuesByAgent: { a: [10, 20, 33], b: [1, 2, 3] },
  };
  const diff = compareEpochSeries(live, drifted);
  assert.equal(diff.maxAbsDiffUsdc, 3);
  assert.equal(diff.worst?.agentId, "a");
  assert.equal(diff.worst?.boundaryBlock, 108);
  assert.ok(Math.abs(diff.maxRelDiff - 3 / 33) < 1e-9);
});

test("the comparator only compares boundaries both series hold", () => {
  // A live run that lost a boundary and a sweep that read every one are not misaligned; they simply
  // overlap on fewer blocks. Comparing by index rather than by block would offset the whole series.
  const live: EpochSeries = {
    epochBlocks: 4,
    epochs: 1,
    boundaryBlocks: [100, 108],
    valuesByAgent: { a: [10, 30] },
  };
  const swept: EpochSeries = {
    epochBlocks: 4,
    epochs: 2,
    boundaryBlocks: [100, 104, 108],
    valuesByAgent: { a: [10, 20, 30] },
  };
  const r = compareEpochSeries(live, swept);
  assert.equal(r.compared, 2);
  assert.equal(r.maxAbsDiffUsdc, 0);
});
