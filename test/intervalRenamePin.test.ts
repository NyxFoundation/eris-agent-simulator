// Pins the scoring output on real runs across the evaluation-interval rename (issue #140).
//
// The interval series is the scoring input: P is V_K − V_0 off its first and last boundary, and the
// standings are computed from those P. A rename of the key the series is stored under is therefore a
// rename on the scoring path, and the only acceptable effect on it is none. These fixtures are three
// scenario matrices (nine runs) exactly as the runner wrote them, before the rename (the run
// directories are under summaries/, because runs/ is gitignored); the standings have to come out
// byte-identical to the standings.json stored beside each matrix.
//
// The chain under test is the production one, hop by hop: the series as a reader finds it in
// summary.json -> P per agent (epochPnlFromSeries, what the coordinator writes as `pnlUsdc`) ->
// matrix.json's per-agent record (scoresFromSummary) -> standings.json (computeStandings). The
// dashboard's reading of the same series (scenarioAgentP, and V_k − V_0 for "through interval k")
// is checked against the same numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeStandings,
  type ScenarioResult,
} from "../core/src/backtest/standings.js";
import {
  scoresFromSummary,
  type AgentSummary,
} from "../core/src/backtest/scenarioScores.js";
import { epochPnlFromSeries } from "../core/src/scoring/epochPnl.js";
import { scenarioAgentP } from "../dashboard/src/data/scenarioP.js";

const FIXTURES = fileURLToPath(
  new URL("./fixtures/interval-pin/", import.meta.url),
);

type Summary = {
  agents: Array<AgentSummary & { id: string }>;
  violations?: Array<{ ownerId?: string }>;
  valueSeries?: Record<string, unknown>;
};
type Series = {
  boundaryBlocks: number[];
  valuesByAgent: Record<string, Array<number | null>>;
};

// The one line the rename is allowed to change: where the series is found in summary.json.
function seriesOf(summary: Summary): Series | undefined {
  return summary.valueSeries?.epochSeries as Series | undefined;
}

function readSummary(runDir: string): Summary {
  return JSON.parse(
    readFileSync(
      join(FIXTURES, "summaries", basename(runDir), "summary.json"),
      "utf8",
    ),
  ) as Summary;
}

const matrices = readdirSync(FIXTURES).filter((d) => d.startsWith("matrix-"));

test("the fixture set is the one pinned: three matrices, nine runs", () => {
  assert.equal(matrices.length, 3);
  assert.equal(readdirSync(join(FIXTURES, "summaries")).length, 9);
});

for (const dir of matrices) {
  test(`${dir}: summary P, matrix records and standings.json survive the series reader`, () => {
    const matrix = JSON.parse(
      readFileSync(join(FIXTURES, dir, "matrix.json"), "utf8"),
    ) as { k: number; scenarios: ScenarioResult[] };
    const storedStandings = readFileSync(
      join(FIXTURES, dir, "standings.json"),
      "utf8",
    );

    const rebuilt: ScenarioResult[] = matrix.scenarios.map((scenario) => {
      assert.ok(scenario.runDir, "every pinned scenario has a run directory");
      const summary = readSummary(scenario.runDir);
      const series = seriesOf(summary);
      assert.ok(series, `${scenario.runDir}: the reader finds the series`);

      // Hop 1: the coordinator's P, off the series' two ends.
      const agents = summary.agents.map((a) => {
        const p = epochPnlFromSeries(series.valuesByAgent[a.id] ?? []);
        assert.ok(p, `${scenario.runDir} ${a.id}: the series yields a P`);
        assert.equal(
          p.pnlUsdc,
          a.pnlUsdc,
          `${a.id}: P as summary.json stores it`,
        );
        // The dashboard reads the same series, and must land on the same number.
        assert.equal(
          scenarioAgentP({}, series.valuesByAgent[a.id]),
          a.pnlUsdc,
          `${a.id}: the dashboard's P`,
        );
        return { ...a, pnlUsdc: p.pnlUsdc };
      });

      // Hop 2: summary.json -> matrix.json's record.
      const scores = scoresFromSummary(
        {
          runDir: scenario.runDir,
          agents,
          violations: summary.violations ?? [],
        },
        [],
      );
      assert.deepEqual(
        scores,
        scenario.agents,
        `${scenario.runDir}: matrix record`,
      );
      return { ...scenario, agents: scores };
    });

    // Hop 3: matrix.json -> standings.json, byte for byte.
    assert.equal(
      `${JSON.stringify(computeStandings(rebuilt, matrix.k), null, 2)}\n`,
      storedStandings,
    );
  });
}

test("the series every dashboard interval reads is the pinned one", () => {
  // The dashboard's "through interval k" standing is V_k − V_0 on these values, for every k. Pinning
  // the values themselves pins every one of those standings at once.
  const all: Record<string, Series["valuesByAgent"]> = {};
  for (const run of readdirSync(join(FIXTURES, "summaries")).sort()) {
    const series = seriesOf(readSummary(run));
    assert.ok(series);
    all[run] = series.valuesByAgent;
  }
  assert.equal(
    createHash("sha256").update(JSON.stringify(all)).digest("hex"),
    PINNED_SERIES_SHA256,
  );
});

const PINNED_SERIES_SHA256 =
  "4c0912488154bce52103b72833fdf616fa95acc930c4a5d9cd07f13c4ff7d675";
