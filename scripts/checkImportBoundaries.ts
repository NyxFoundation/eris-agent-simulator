// checkImportBoundaries: check the workspace dependency direction (ADR 0015 §1).
// Only `example → sdk ← core` is allowed. Direct core<->example references and sdk->core/example are forbidden.
// Run as `npm run check:boundaries` in CI / pre-merge. Exit code: PASS=0 / violation=2.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Violation = { file: string; line: number; specifier: string };

const RULES: Array<{
  root: string;
  forbidden: RegExp[];
  reason: string;
}> = [
  {
    root: "core/src",
    forbidden: [/^@eris\/example/, /\/example\/agents\//, /^\.\..*\/example\//],
    reason:
      "core cannot reference example (dependency direction is example → sdk ← core)",
  },
  {
    root: "example/agents",
    forbidden: [/^@eris\/core/, /\/core\/src\//, /^\.\..*\/core\//],
    reason: "example cannot reference core (it depends on sdk only)",
  },
  {
    root: "sdk/src",
    forbidden: [/^@eris\/core/, /^@eris\/example/, /^\.\..*\/(core|example)\//],
    reason: "sdk cannot reference core / example (it is the contract layer)",
  },
];

const IMPORT_RE =
  /(?:import|export)[^"']*from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
}

function main(): void {
  const violations: Array<Violation & { reason: string }> = [];
  for (const rule of RULES) {
    const files: string[] = [];
    walk(rule.root, files);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((lineText, i) => {
        for (const m of lineText.matchAll(IMPORT_RE)) {
          const spec = m[1] ?? m[2];
          if (!spec) continue;
          if (rule.forbidden.some((re) => re.test(spec))) {
            violations.push({
              file,
              line: i + 1,
              specifier: spec,
              reason: rule.reason,
            });
          }
        }
      });
    }
  }
  if (violations.length === 0) {
    console.error("[boundaries] PASS (example → sdk ← core)");
    return;
  }
  for (const v of violations) {
    console.error(
      `[boundaries] ${v.file}:${v.line} imports "${v.specifier}" — ${v.reason}`,
    );
  }
  process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
