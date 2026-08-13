// npm run metrics -- <runDir...>
//
// Rescore stored runs under every candidate metric (issue #56). Reads summary.json's epoch series,
// so it needs nothing but the run directories -- no chain, no re-run. Writes a JSON alongside the
// table so a later comparison can be diffed rather than re-eyeballed.
//
// The point is not to produce a ranking. It is to see where the candidates disagree: if two metrics
// order every run identically, the choice between them is theoretical, and where they diverge is
// exactly the case the decision has to be made on.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  bordaTotals,
  metricsForRun,
  rankBy,
  type MetricKey,
  type RunMetrics,
} from "../scoring/metrics.js";

const USAGE = `usage: npm run metrics -- <runDir> [runDir...] [--lambda N] [--rho N] [--out <path>]
  <runDir>        a run directory containing summary.json with an epoch series
  --lambda N      M9's risk aversion (default 0.25)
  --rho N         M7's MPPM risk aversion (default 2)
  --out <path>    also write the full table as JSON`;

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "totalPnlUsdc", label: "M1 PnL" },
  { key: "excessLogGrowth", label: "M4 excess-log" },
  { key: "score", label: "M9 mean-λstd" },
  { key: "sharpePerEpoch", label: "M13 Sharpe" },
  { key: "mppm", label: "M7 MPPM" },
];

function readRun(runDir: string): RunMetrics | undefined {
  const path = join(runDir, "summary.json");
  if (!existsSync(path)) {
    console.error(`[metrics] ${path} not found; skipped`);
    return undefined;
  }
  const summary = JSON.parse(readFileSync(path, "utf8")) as {
    valueSeries?: {
      epochSeries?: {
        valuesByAgent?: Record<string, Array<number | null>>;
      };
    };
    agents?: Array<{ id: string; baseline?: boolean }>;
  };
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
const runDirs = argv.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const previous = argv[i - 1];
  return !(
    previous === "--lambda" ||
    previous === "--rho" ||
    previous === "--out"
  );
});

const runs = runDirs
  .map(readRun)
  .filter((r): r is RunMetrics => r !== undefined);
if (runs.length === 0) {
  console.error("[metrics] nothing to report");
  process.exit(1);
}

const pad = (s: string, n: number) => s.padEnd(n);
const num = (v: number) =>
  Math.abs(v) >= 1000 || (Math.abs(v) < 0.001 && v !== 0)
    ? v.toExponential(2)
    : v.toFixed(4);

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
