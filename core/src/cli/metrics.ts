// npm run metrics -- <runDir...>
// npm run metrics -- --matrix <matrixDir>
//
// Rescore stored runs under every candidate metric (issue #56). Reads summary.json's epoch series,
// so it needs nothing but the run directories -- no chain, no re-run. Writes a JSON alongside the
// table so a later comparison can be diffed rather than re-eyeballed.
//
// The point is not to produce a ranking. It is to see where the candidates disagree: if two metrics
// order every run identically, the choice between them is theoretical, and where they diverge is
// exactly the case the decision has to be made on.
//
// --matrix adds the second layer that `scenario` mode needs (ADR 0020 §5). A run-dir list answers
// "which metric", and in a continuous economy that is the whole question. A scenario matrix also has
// to decide how N per-scenario numbers become one standing, and that rule is a separate choice with
// its own failure mode (#55: field-relative z-scores let one participant compress everyone else).
// So this mode crosses every metric with every aggregator and reports where the pairs disagree.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  aggregateScenarios,
  orderOf,
  sdInflationFromExtreme,
  AGGREGATORS,
  type ScenarioRow,
} from "../scoring/aggregate.js";
import {
  bordaTotals,
  metricsForRun,
  rankBy,
  type MetricKey,
  type RunMetrics,
} from "../scoring/metrics.js";

const USAGE = `usage: npm run metrics -- <runDir> [runDir...] [--lambda N] [--rho N] [--out <path>]
       npm run metrics -- --matrix <matrixDir> [--lambda N] [--rho N] [--out <path>]
  <runDir>          a run directory containing summary.json with an epoch series
  --matrix <dir>    a runs/matrix-* directory; scores every scenario in it and crosses each metric
                    with each cross-scenario aggregator (zscore / borda / mean), ADR 0020 §5
  --lambda N        M9's risk aversion (default 0.25)
  --rho N           M7's MPPM risk aversion (default 2)
  --out <path>      also write the full table as JSON`;

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "totalPnlUsdc", label: "M1 PnL" },
  { key: "excessLogGrowth", label: "M4 excess-log" },
  { key: "score", label: "M9 mean-λstd" },
  { key: "sharpePerEpoch", label: "M13 Sharpe" },
  { key: "mppm", label: "M7 MPPM" },
];

// Which world shape each reported run came from, so the cross-run section below can refuse to mix
// them (ADR 0020 §1). Filled by readRun.
const resetUnitByRun = new Map<string, string>();

function readRun(runDir: string): RunMetrics | undefined {
  const path = join(runDir, "summary.json");
  if (!existsSync(path)) {
    console.error(`[metrics] ${path} not found; skipped`);
    return undefined;
  }
  const summary = JSON.parse(readFileSync(path, "utf8")) as {
    resetUnit?: string;
    valueSeries?: {
      epochSeries?: {
        valuesByAgent?: Record<string, Array<number | null>>;
      };
    };
    agents?: Array<{ id: string; baseline?: boolean }>;
  };
  // Runs stored before the axis existed carry no field, and every one of them was a single world
  // (ADR 0020 §1 named that shape `continuous`), so reading them as continuous is a fact about those
  // runs rather than a default.
  resetUnitByRun.set(basename(runDir), summary.resetUnit ?? "continuous");
  const valuesByAgent = summary.valueSeries?.epochSeries?.valuesByAgent;
  if (!valuesByAgent) {
    // A run from before the epoch series existed, or one whose reconstruction failed. Saying so is
    // the point -- a silently missing run would look like a metric that agreed with everything.
    console.error(`[metrics] ${runDir} has no epoch series; skipped`);
    return undefined;
  }
  // summary.json does not record which agent was the baseline, so fall back to the convention the
  // rosters use. Stated rather than guessed silently: with the wrong benchmark every excess figure
  // in the table is wrong by the benchmark's own drift.
  const benchmarkId =
    summary.agents?.find((a) => a.baseline)?.id ??
    (valuesByAgent.noop ? "noop" : undefined);
  if (benchmarkId === undefined)
    console.error(
      `[metrics] ${runDir}: no baseline agent found; excess figures fall back to raw returns`,
    );
  return metricsForRun(basename(runDir), valuesByAgent, benchmarkId, {
    lambda: LAMBDA,
    rho: RHO,
  });
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LAMBDA = Number(flagValue("--lambda") ?? 0.25);
const RHO = Number(flagValue("--rho") ?? 2);
const OUT = flagValue("--out");
const MATRIX = flagValue("--matrix");
const runDirs = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const previous = argv[i - 1];
  return !(
    previous === "--lambda" ||
    previous === "--rho" ||
    previous === "--out" ||
    previous === "--matrix"
  );
});

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number) =>
  Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0)
    ? v.toExponential(2)
    : v.toFixed(4);

// ---- --matrix: metric x cross-scenario aggregator (ADR 0020 §5) ----
if (MATRIX) {
  const matrixDir = resolve(MATRIX);
  const matrixPath = join(matrixDir, "matrix.json");
  if (!existsSync(matrixPath)) {
    console.error(`[metrics] ${matrixPath} not found`);
    process.exit(1);
  }
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
    resetUnit?: string;
    scenarioSet?: string;
    scenarios?: Array<{
      regime: string;
      seed: number;
      runDir?: string;
      error?: string;
    }>;
  };

  // matrix.json records runDir relative to the poc root that produced it, so a matrix collected off
  // a remote box resolves against the directory the tarball was unpacked into rather than the cwd.
  const collectedRoot = resolve(matrixDir, "..", "..");
  const scored: Array<{ regime: string; seed: number; run: RunMetrics }> = [];
  const skipped: string[] = [];
  for (const s of matrix.scenarios ?? []) {
    const label = `${s.regime}#${s.seed}`;
    if (!s.runDir) {
      skipped.push(`${label}: ${s.error ?? "no runDir recorded"}`);
      continue;
    }
    const candidates = [
      isAbsolute(s.runDir) ? s.runDir : resolve(process.cwd(), s.runDir),
      resolve(collectedRoot, s.runDir),
      resolve(matrixDir, "..", basename(s.runDir)),
    ];
    const dir = candidates.find((c) => existsSync(join(c, "summary.json")));
    if (!dir) {
      skipped.push(`${label}: run directory is gone (${s.runDir})`);
      continue;
    }
    const run = readRun(dir);
    if (!run) {
      skipped.push(`${label}: no epoch series`);
      continue;
    }
    scored.push({ regime: s.regime, seed: s.seed, run });
  }
  if (scored.length === 0) {
    console.error("[metrics] no scenario in this matrix could be scored");
    process.exit(1);
  }

  // Same refusal as the run-dir path: a matrix is scenario-mode by construction, so a run inside it
  // stamped `continuous` means the matrix mixes shapes and nothing below can be read (ADR 0020 §1).
  const modes = new Set(
    scored.map((s) => resetUnitByRun.get(s.run.label) ?? "continuous"),
  );
  if (matrix.resetUnit) modes.add(matrix.resetUnit);
  if (modes.size > 1) {
    console.error(
      `[metrics] this matrix mixes reset units (${[...modes].join(", ")}); refusing to aggregate (ADR 0020 §1)`,
    );
    process.exit(1);
  }

  const regimes = [...new Set(scored.map((s) => s.regime))];
  const agentIds = [
    ...new Set(scored.flatMap((s) => s.run.agents.map((a) => a.agentId))),
  ];
  console.log(
    `\n=== ${basename(matrixDir)} — ${scored.length} scenarios, ${regimes.length} regimes, ` +
      `${agentIds.length} agents (λ=${LAMBDA}, ρ=${RHO}, resetUnit=${[...modes][0]}) ===`,
  );
  if (skipped.length > 0) {
    // Named rather than counted: a silently dropped scenario looks like a regime that agreed with
    // everything, and the regimes most likely to fail are the ones with the sharpest events.
    console.log(`skipped ${skipped.length} scenario(s):`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  const rowsFor = (key: MetricKey): ScenarioRow[] =>
    scored.map((s) => ({
      regime: s.regime,
      seed: s.seed,
      byAgent: Object.fromEntries(s.run.agents.map((a) => [a.agentId, a[key]])),
    }));

  const standings = new Map<string, ReturnType<typeof aggregateScenarios>>();
  for (const m of METRICS)
    for (const agg of AGGREGATORS)
      standings.set(`${m.key}|${agg}`, aggregateScenarios(rowsFor(m.key), agg));

  for (const m of METRICS) {
    console.log(`\n--- ${m.label} ---`);
    for (const agg of AGGREGATORS) {
      const rows = standings.get(`${m.key}|${agg}`) ?? [];
      console.log(`  ${pad(agg, 8)}${orderOf(rows).join(" > ")}`);
    }
  }

  // The two questions this mode exists to answer, kept apart because they are different decisions:
  // which metric to score a scenario with, and which rule turns scenarios into a standing.
  console.log(
    "\n=== disagreement (reference: M9 x zscore = ADR 0019's metric + the incumbent aggregator) ===",
  );
  const reference = orderOf(standings.get("score|zscore") ?? []).join(" > ");
  for (const m of METRICS)
    for (const agg of AGGREGATORS) {
      const order = orderOf(standings.get(`${m.key}|${agg}`) ?? []).join(" > ");
      if (m.key === "score" && agg === "zscore") continue;
      console.log(
        `  ${pad(`${m.label} x ${agg}`, 30)}${order === reference ? "same order" : "DIFFERENT"}`,
      );
    }

  console.log("\n=== aggregator disagreement, holding the metric fixed ===");
  for (const m of METRICS) {
    const orders = AGGREGATORS.map((agg) =>
      orderOf(standings.get(`${m.key}|${agg}`) ?? []).join(" > "),
    );
    const distinct = new Set(orders).size;
    console.log(
      `  ${pad(m.label, 16)}${distinct === 1 ? "all three aggregators agree" : `${distinct} distinct orders`}`,
    );
  }

  // Issue #55 as a measurement rather than an anecdote: how much of each scenario's spread is one
  // agent's doing. This is what decides whether retiring the z-score is urgent or theoretical.
  console.log(
    "\n=== #55 exposure: sd inflation from the single most extreme agent (1.0 = none) ===",
  );
  for (const m of METRICS) {
    const inflations = rowsFor(m.key).map((row) => ({
      label: `${row.regime}#${row.seed}`,
      ...sdInflationFromExtreme(row.byAgent),
    }));
    const worst = inflations.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    const median = [...inflations].sort((a, b) => a.ratio - b.ratio)[
      Math.floor(inflations.length / 2)
    ];
    console.log(
      `  ${pad(m.label, 16)}median ${median.ratio.toFixed(2)}   worst ${worst.ratio.toFixed(2)}` +
        (worst.agentId ? ` (${worst.agentId} in ${worst.label})` : ""),
    );
  }

  if (OUT) {
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          matrix: basename(matrixDir),
          lambda: LAMBDA,
          rho: RHO,
          resetUnit: [...modes][0],
          scenarios: scored.map((s) => ({
            regime: s.regime,
            seed: s.seed,
            run: s.run,
          })),
          standings: Object.fromEntries(standings),
          skipped,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nwrote ${OUT}`);
  }
  process.exit(0);
}

const runs = runDirs
  .map(readRun)
  .filter((r): r is RunMetrics => r !== undefined);
if (runs.length === 0) {
  console.error("[metrics] nothing to report");
  process.exit(1);
}

// ADR 0020 §1: mixing the modes is refused rather than reported. Everything below this line compares
// runs against each other (the disagreement count and the M27 Borda), and a continuous week and a
// single scenario are not the same measurement: the epoch count per world differs, which moves the
// effective severity of M9's lambda by 1/sqrt(epoch length) (measurement log §5.6). A Borda total
// mixing the two reads as a ranking when it is an average over two different competitions.
{
  const byMode = new Map<string, string[]>();
  for (const run of runs) {
    const mode = resetUnitByRun.get(run.label) ?? "continuous";
    byMode.set(mode, [...(byMode.get(mode) ?? []), run.label]);
  }
  if (byMode.size > 1) {
    console.error(
      `[metrics] refusing to report across reset units: ` +
        [...byMode]
          .map(([mode, labels]) => `${mode} (${labels.join(", ")})`)
          .join(" vs ") +
        `. Run them separately — the epoch count per world differs, so the metrics are not ` +
        `comparable (ADR 0020 §1)`,
    );
    process.exit(1);
  }
}

for (const run of runs) {
  console.log(
    `\n=== ${run.label} (benchmark: ${run.benchmarkId ?? "none — raw returns"}, λ=${LAMBDA}, ρ=${RHO}) ===`,
  );
  console.log(
    pad("agent", 16) + METRICS.map((m) => pad(m.label, 16)).join("") + "epochs",
  );
  for (const a of run.agents) {
    console.log(
      pad(a.agentId, 16) +
        METRICS.map((m) => pad(num(a[m.key]), 16)).join("") +
        a.epochs,
    );
  }
  console.log("rankings:");
  for (const m of METRICS)
    console.log(`  ${pad(m.label, 16)}${rankBy(run, m.key).join(" > ")}`);
}

// Where the candidates actually disagree. Two metrics that never reorder anything are the same
// decision under different notation, and the ones that do are the choice being made.
console.log("\n=== disagreement with M9 (the ADR 0019 decision) ===");
for (const m of METRICS) {
  if (m.key === "score") continue;
  const differing = runs.filter(
    (r) => rankBy(r, m.key).join() !== rankBy(r, "score").join(),
  );
  console.log(
    `  ${pad(m.label, 16)}${differing.length}/${runs.length} runs ordered differently` +
      (differing.length > 0
        ? `: ${differing.map((r) => r.label).join(", ")}`
        : ""),
  );
}

if (runs.length > 1) {
  console.log("\n=== M27 Borda over these runs (lower is better) ===");
  for (const m of METRICS) {
    const totals = bordaTotals(runs, m.key);
    const order = Object.entries(totals).sort((a, b) => a[1] - b[1]);
    console.log(
      `  ${pad(m.label, 16)}${order.map(([id, t]) => `${id}=${t}`).join("  ")}`,
    );
  }
}

if (OUT) {
  writeFileSync(
    OUT,
    `${JSON.stringify({ lambda: LAMBDA, rho: RHO, runs }, null, 2)}\n`,
  );
  console.log(`\nwrote ${OUT}`);
}
