// checkStrategyCode: CLI for static cheatcode checking of strategy code (ADR 0006 §5).
// The entry gate that must pass before /strategy-evolve accepts a change involving code edits.
//
// Usage:
//   tsx scripts/checkStrategyCode.ts [files...]   # when omitted, all strategy code under example/agents/*/
//
// Output: findings JSON to stdout, a human-readable summary to stderr. Exit code: PASS=0 / findings=2 / error=1.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  findCheatcodeUsage,
  type StaticCheckFinding,
} from "../core/src/strategyStaticCheck.js";

// ADR 0015 §2: 1 agent = 1 directory. runtime/ is a reserved name (not participant code, so excluded);
// lib/ holds shared strategy helpers, so it is included.
function defaultTargets(): string[] {
  const root = "example/agents";
  const targets: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === "runtime") continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      const p = join(dir, file);
      if (statSync(p).isFile() && p.endsWith(".ts")) targets.push(p);
    }
  }
  return targets;
}

function main(): void {
  const files = process.argv.slice(2);
  const targets = files.length > 0 ? files : defaultTargets();
  const results: Array<{ file: string; findings: StaticCheckFinding[] }> = [];
  for (const file of targets) {
    const findings = findCheatcodeUsage(readFileSync(file, "utf8"));
    if (findings.length > 0) results.push({ file, findings });
  }

  process.stdout.write(
    `${JSON.stringify({ pass: results.length === 0, checkedFiles: targets.length, results }, null, 2)}\n`,
  );
  if (results.length === 0) {
    console.error(`[static-check] PASS (${targets.length} files)`);
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
