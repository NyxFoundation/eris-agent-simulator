// checkStrategyCode: CLI for static cheatcode checking of strategy code (ADR 0006 §5).
// The entry gate that must pass before /strategy-evolve accepts a change involving code edits.
//
// Usage:
//   tsx scripts/checkStrategyCode.ts [files...]   # when omitted, all strategy code under example/agents/*/
//
// Output: findings JSON to stdout, a human-readable summary to stderr. Exit code: PASS=0 / findings=2 / error=1.
// `hints` (issue #216 (5): shapes an assembled cheatcode name takes) are printed and written to the
// JSON but never change the exit code; the line check is an entrance gate, and the runtime refusal
// and the post-run audit are the layers that see an assembled name.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  findAssembledCheatcodeHints,
  findCheatcodeUsage,
  type StaticCheckFinding,
} from "@eris/sdk/strategyStaticCheck.js";

// ADR 0015 §2: 1 agent = 1 directory. runtime/ is a reserved name (not participant code, so excluded);
// lib/ holds shared strategy helpers, so it is included.
function defaultTargets(): string[] {
  const root = "example/agents";
  const targets: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if ([".venv", "__pycache__", "node_modules"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(ts|py)$/.test(path)) targets.push(path);
    }
  };
  for (const name of readdirSync(root)) {
    if (name === "runtime") continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    walk(dir);
  }
  return targets;
}

function main(): void {
  const files = process.argv.slice(2);
  const targets = files.length > 0 ? files : defaultTargets();
  const results: Array<{ file: string; findings: StaticCheckFinding[] }> = [];
  const hints: Array<{ file: string; findings: StaticCheckFinding[] }> = [];
  for (const file of targets) {
    const source = readFileSync(file, "utf8");
    const findings = findCheatcodeUsage(source);
    if (findings.length > 0) results.push({ file, findings });
    const hinted = findAssembledCheatcodeHints(source);
    if (hinted.length > 0) hints.push({ file, findings: hinted });
  }

  process.stdout.write(
    `${JSON.stringify({ pass: results.length === 0, checkedFiles: targets.length, results, hints }, null, 2)}\n`,
  );
  for (const h of hints) {
    for (const f of h.findings) {
      console.error(
        `[static-check] hint ${h.file}:${f.line} ${f.rule}: \`${f.match}\``,
      );
    }
  }
  if (hints.length > 0) {
    console.error(
      "[static-check] hints do not fail the gate: a cheatcode name assembled at runtime is refused by the " +
        "read-only client and the gateway when sent, and read from blocks.csv afterwards. Look at them.",
    );
  }
  if (results.length === 0) {
    console.error(`[static-check] PASS (${targets.length} files)`);
    // Issue #40 T6: deployment used to be neither allowed nor forbidden in writing, which meant a
    // participant deciding whether to ship a contract had to infer the answer from the absence of a
    // rule. It is allowed. Stating it here, where the gate already speaks to the participant, is
    // cheaper than a paragraph in a document they may not reach.
    console.error(
      "[static-check] deploying your own contracts IS permitted (issue #40). A rawTx with no `to` " +
        "deploys the creation bytecode in `data`; the environment publishes what it finds to the " +
        "MarketRegistry. What bounds it: the per-transaction and per-block gas budget (rules §2.6), " +
        "and the fact that anything you deploy is `unknown` to everyone else — value left inside a " +
        "contract the environment cannot value is worth zero at the epoch's final block (rules §4.1).",
    );
    return;
  }
  for (const r of results) {
    for (const f of r.findings) {
      console.error(
        `[static-check] ${r.file}:${f.line} ${f.rule}: \`${f.match}\``,
      );
    }
  }
  console.error(
    "[static-check] FAIL — detected use of a cheatcode/privileged helper. Remove it from the strategy code (ADR 0006 §5).",
  );
  process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
