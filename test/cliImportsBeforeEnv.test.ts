// The two CLI entry points that set the local-deploy environment and only *then* load the
// coordinator (core/src/cli/sim-realtime.ts, core/src/cli/backtest.ts: "dependency-light") must
// not reach sdk/src/constants.ts through a static import. constants.ts fixes the address overlay
// when it is first evaluated, from ERIS_LOCAL_DEPLOY / the manifest; evaluated too early it freezes
// the fork registry for the whole process, and the symptom is far from the cause: every scenario
// dies at setup with `markets: unknown token symbol "WBTC"` (CI run 36989637551, where
// backtest.ts -> scenarioScores.ts -> scoring/endowmentV0.ts -> @eris/sdk/pnl.js -> markets.js ->
// constants.js was the chain, added for the V_0 flags of issue #207).
//
// A static walk over the import graph, following value imports only: `import type` and
// `import()` are exactly the two forms that do not evaluate the module at load.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FORBIDDEN = resolve(ROOT, "sdk/src/constants.ts");

const ENTRY_POINTS = ["core/src/cli/sim-realtime.ts", "core/src/cli/backtest.ts"];

// One static value import per match: `import x from`, `import { x } from`, `import * as x from`,
// `export { x } from`, `export * from`. A `type` right after the keyword is a type-only form.
const STATIC_IMPORT =
  /^\s*(import|export)\s+(?!type\s)[^;'"]*?\s+from\s+["']([^"']+)["']/gm;

function resolveSpecifier(from: string, spec: string): string | undefined {
  let path: string | undefined;
  if (spec.startsWith(".")) path = resolve(dirname(from), spec);
  else if (spec === "@eris/sdk") path = resolve(ROOT, "sdk/src/index.ts");
  else if (spec.startsWith("@eris/sdk/"))
    path = resolve(ROOT, "sdk/src", spec.slice("@eris/sdk/".length));
  else return undefined; // a package or a node builtin: not ours
  // Compiled-name imports (`./x.js`) point at the TypeScript source.
  const candidates = [
    path.replace(/\.js$/, ".ts"),
    path.replace(/\.js$/, ".tsx"),
    path,
    `${path}.ts`,
    join(path, "index.ts"),
  ];
  return candidates.find((c) => existsSync(c));
}

// Every module reachable from `entry` through static value imports, with the chain that reached it.
function walk(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; chain: string[] }> = [
    { file: entry, chain: [entry] },
  ];
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, chain);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(STATIC_IMPORT)) {
      const next = resolveSpecifier(file, m[2]);
      if (next && !seen.has(next))
        queue.push({ file: next, chain: [...chain, next] });
    }
  }
  return seen;
}

for (const entry of ENTRY_POINTS) {
  test(`${entry} does not statically import sdk/src/constants.ts`, () => {
    const reached = walk(resolve(ROOT, entry));
    const chain = reached.get(FORBIDDEN);
    assert.equal(
      chain,
      undefined,
      chain
        ? `constants.ts is evaluated before the entry point sets the environment, via:\n  ${chain
            .map((f) => f.slice(ROOT.length + 1))
            .join("\n  -> ")}`
        : undefined,
    );
    // And the walk actually walked: the coordinator is loaded dynamically, so it must be absent too,
    // while the entry point's own helpers are present.
    assert.ok(reached.size > 1, "the entry point imports something");
    assert.equal(
      reached.has(resolve(ROOT, "core/src/realtime/coordinator.ts")),
      false,
      "the coordinator is a dynamic import",
    );
  });
}

test("the walk sees through the chain that broke CI, and ignores type-only imports", () => {
  // scenarioScores.ts is on backtest.ts's static path; from it, a value import of the sdk's
  // markets registry is what must never appear.
  const reached = walk(resolve(ROOT, "core/src/cli/backtest.ts"));
  assert.ok(reached.has(resolve(ROOT, "core/src/backtest/scenarioScores.ts")));
  assert.ok(reached.has(resolve(ROOT, "core/src/scoring/endowmentV0.ts")));
  assert.equal(reached.has(resolve(ROOT, "sdk/src/markets.ts")), false);
  // standings.ts imports V0Source as a type only, which evaluates nothing.
  const matches = [
    ...readFileSync(
      resolve(ROOT, "core/src/backtest/standings.ts"),
      "utf8",
    ).matchAll(STATIC_IMPORT),
  ].map((m) => m[2]);
  assert.ok(!matches.includes("../scoring/endowmentV0.js"));
});
