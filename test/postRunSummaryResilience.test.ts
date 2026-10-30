// An agent must not be able to make an epoch excluded for everyone by making the post-run summary
// fail to write. Two layers: the end-of-run value reads never throw (postRunValues.ts), and a run
// with no summary.json is still scored off its live boundary series when that series reached the
// end block (scenarioScores.ts scoresFromIntervals).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  postRunReadFailedHoldings,
  readPostRunValues,
  runDirOfError,
  withRunDir,
} from "../core/src/realtime/postRunValues.js";
import {
  scoresFromIntervals,
  scoresFromSummary,
  type AgentSummary,
} from "../core/src/backtest/scenarioScores.js";
import { computeStandings } from "../core/src/backtest/standings.js";
import { writeRunStart } from "../sdk/src/runStart.js";

test("an adapter whose end-of-run read throws counts 0 and is reported, not thrown", async () => {
  const adapters = [{ id: "uniswap" }, { id: "lst" }, { id: "aave" }];
  const values = await readPostRunValues(adapters, async (a) => {
    // The measured case: MockLSTVault.accountSummaryAt over ~3,250 requests needs more than the
    // 30M block gas limit and the eth_call reverts.
    if (a.id === "lst")
      throw new Error("execution reverted: out of gas (accountSummaryAt)");
    return a.id === "uniswap" ? 1_000 : 250;
  });
  assert.equal(values.totalUsdc, 1_250);
  assert.deepEqual(values.protocolValues, { uniswap: 1_000, lst: 0, aave: 250 });
  assert.equal(values.failures.length, 1);
  assert.equal(values.failures[0].adapter, "lst");

  const holdings = postRunReadFailedHoldings(values.failures);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].reason, "read-failed");
  assert.equal(holdings[0].source, "summary-value:lst");
  assert.equal(holdings[0].amountRaw, "");
  assert.match(holdings[0].read ?? "", /lst\.valueUsdc.*out of gas/);
});

test("a non-finite adapter value is treated like a failed read", async () => {
  const values = await readPostRunValues([{ id: "gmx" }], async () => Number.NaN);
  assert.equal(values.totalUsdc, 0);
  assert.equal(values.failures[0].adapter, "gmx");
});

test("a run's failure carries its run directory, on the same error object", () => {
  const original = new Error("boom");
  original.name = "LiveWeekRefusal";
  const wrapped = withRunDir(original, "/runs/x");
  assert.equal(wrapped, original);
  assert.equal(wrapped.name, "LiveWeekRefusal");
  assert.equal(runDirOfError(wrapped), "/runs/x");
  assert.equal(runDirOfError(withRunDir("text", "/runs/y")), "/runs/y");
  assert.equal(runDirOfError(new Error("plain")), undefined);
});

// ---- the intervals.jsonl fallback ----

const RUN_START = 1_000;
const RUN_BLOCKS = 360;
const END = RUN_START + RUN_BLOCKS;

// Five boundaries at 90-block spacing, as the live scorer writes them: the first carries the
// endowment floor's record and already holds the floored V_0 in `values`.
function boundaryLines(lastBlock: number) {
  const blocks = [RUN_START, RUN_START + 90, RUN_START + 180, RUN_START + 270, lastBlock];
  return blocks.map((blockNumber, index) => ({
    index,
    blockNumber,
    fairPriceUsdcPerWeth: 3_000,
    values: {
      // V_0 floored at the endowment (measured 99,000 below it).
      alpha: [100_000, 100_400, 100_900, 101_100, 101_234][index],
      // Measured above the endowment: V_0 as measured.
      beta: [100_500, 100_000, 99_000, 98_500, 98_000][index],
      // The final boundary did not report: P carries the last one that did (rules §4.4.2).
      gamma: [100_000, 100_100, 100_200, 100_300, null][index],
      bench: [100_000, 100_000, 100_000, 100_000, 100_050][index],
    },
    elapsedMs: 5,
    ...(index === 0
      ? {
          v0SourceByAgent: {
            alpha: "endowment",
            beta: "measured",
            gamma: "endowment",
            bench: "endowment",
          },
          v0MeasuredByAgent: { alpha: 99_000, beta: 100_500, gamma: 100_000, bench: 100_000 },
          v0EndowmentByAgent: { alpha: 100_000, beta: 100_000, gamma: 100_000, bench: 100_000 },
        }
      : {}),
  }));
}

function runDirWith(lastBlock: number, torn = false): string {
  const dir = mkdtempSync(join(tmpdir(), "eris-intervals-fallback-"));
  writeRunStart(dir, { runStartBlock: RUN_START, runBlocks: RUN_BLOCKS });
  writeFileSync(
    join(dir, "intervals.jsonl"),
    boundaryLines(lastBlock)
      .map((l) => JSON.stringify(l))
      .join("\n") + (torn ? '\n{"index":5,"blockNum' : "\n"),
  );
  writeFileSync(
    join(dir, "events.jsonl"),
    JSON.stringify({ type: "agent_process_exited", agentId: "gamma", reason: "exit 1" }) + "\n",
  );
  return dir;
}

const roster = [
  { id: "alpha", participant: "unit-a" },
  { id: "beta" },
  { id: "gamma" },
  { id: "bench", baseline: true },
];

test("a run with no summary.json is scored off intervals.jsonl with the summary's P", () => {
  const dir = runDirWith(END, true);
  const fallback = scoresFromIntervals(dir, roster, "summary.json not found");
  assert.ok(fallback.ok);
  assert.equal(fallback.endBlock, END);

  // What the coordinator would have written for the same series (pnlUsdc = epochPnlFromSeries,
  // v0 fields = v0FieldsFor), scored the ordinary way.
  const summaryAgents: AgentSummary[] = [
    {
      id: "alpha",
      participant: "unit-a",
      pnlUsdc: 1_234,
      v0Source: "endowment",
      v0Usdc: 100_000,
      v0MeasuredUsdc: 99_000,
      v0EndowmentUsdc: 100_000,
    },
    {
      id: "beta",
      pnlUsdc: -2_500,
      v0Source: "measured",
      v0Usdc: 100_500,
      v0MeasuredUsdc: 100_500,
      v0EndowmentUsdc: 100_000,
    },
    {
      id: "gamma",
      pnlUsdc: 300,
      v0Source: "endowment",
      v0Usdc: 100_000,
      v0MeasuredUsdc: 100_000,
      v0EndowmentUsdc: 100_000,
      processExitedEarly: "exit 1",
    },
    {
      id: "bench",
      baseline: true,
      pnlUsdc: 50,
      v0Source: "endowment",
      v0Usdc: 100_000,
      v0MeasuredUsdc: 100_000,
      v0EndowmentUsdc: 100_000,
    },
  ];
  const fromSummary = scoresFromSummary(
    { runDir: dir, agents: summaryAgents, violations: [] },
    roster.map((a) => a.id),
  );
  const byId = Object.fromEntries(fallback.scores.map((s) => [s.id, s]));
  for (const expected of fromSummary) {
    const got = byId[expected.id];
    assert.equal(got.pnlUsdc, expected.pnlUsdc, expected.id);
    assert.equal(got.v0Source, expected.v0Source, expected.id);
    assert.equal(got.baseline, expected.baseline, expected.id);
    assert.equal(got.participant, expected.participant, expected.id);
    assert.equal(got.pnlSource, "intervals-fallback");
    // Every flag the summary would have raised is still there, plus the one that names the fallback.
    for (const f of expected.flags ?? []) assert.ok(got.flags?.includes(f), `${expected.id}: ${f}`);
    assert.ok(got.flags?.some((f) => /scored from intervals\.jsonl/.test(f)));
  }

  // And the epoch counts: it is in S, the benchmark kept out of the population.
  const standings = computeStandings(
    [{ s: 1, regime: "calm", seed: 1, agents: fallback.scores }],
    1,
  );
  assert.equal(standings.epochs[0].excluded, undefined);
  assert.equal(standings.epochs[0].n, 3);
  assert.ok("alpha" in standings.epochs[0].tByAgent);
  assert.ok(!("bench" in standings.epochs[0].tByAgent));
});

test("a series short of the end block keeps the epoch excluded", () => {
  const dir = runDirWith(END - 10);
  const fallback = scoresFromIntervals(dir, roster, "the run threw");
  assert.equal(fallback.ok, false);
  assert.match(!fallback.ok ? fallback.reason : "", /did not finish/);
  const standings = computeStandings(
    [{ s: 1, regime: "calm", seed: 1, error: "the run threw" }],
    1,
  );
  assert.equal(standings.epochs[0].excluded, "invalid");
  assert.equal(standings.epochs[0].invalidReason, "the run threw");
});

test("no run-start.json or no series at all keeps the exclusion", () => {
  const empty = mkdtempSync(join(tmpdir(), "eris-intervals-fallback-"));
  assert.equal(scoresFromIntervals(empty, roster, "x").ok, false);
  writeRunStart(empty, { runStartBlock: RUN_START, runBlocks: RUN_BLOCKS });
  assert.equal(scoresFromIntervals(empty, roster, "x").ok, false);
});
