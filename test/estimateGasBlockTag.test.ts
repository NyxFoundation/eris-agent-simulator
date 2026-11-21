// Every eth_estimateGas the environment or the reference runtime sends names its block.
//
// anvil's default block for an estimate is the pending one, and building that block computes a state
// root over every storage slot on the chain. Measured on anvil 1.8.3: 0.63 s per million slots, and
// 1.5-3 s a call on the practice chain once GMX's DataStore held 15.8M (mostly cleared) slots -- the
// coordinator estimated every background-flow transaction that way, a pass took 5 s, and the chain
// made 10 blocks a minute instead of 30 (2026-11-21). Against "latest" the same call is ~1 ms.
// Participants never hit this: the gateway writes "latest" into an estimate that omits the block.
// Code that talks to the node directly has to say it itself, and a new call site that forgets is
// invisible until the state has grown again, so this reads the source.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const DIRS = ["core/src", "sdk/src", "example/agents/runtime", "example/agents/lib"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|mts|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

// The argument list of the call that opens at `open` (the index of its "(").
function callArguments(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

test("every estimateGas call names its block tag", () => {
  const calls: Array<{ where: string; args: string }> = [];
  for (const dir of DIRS) {
    for (const file of sources(join(ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\.estimate(?:Contract)?Gas\s*\(/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        calls.push({
          where: `${relative(ROOT, file)}:${line}`,
          args: callArguments(text, m.index + m[0].length - 1),
        });
      }
    }
  }
  // The two known sites: the coordinator's background-flow sender and the reference runtime.
  assert.ok(calls.length >= 2, `expected to find the estimateGas call sites, found ${calls.length}`);
  const missing = calls.filter((c) => !/\bblockTag\s*:|\bblockNumber\s*:/.test(c.args));
  assert.deepEqual(
    missing.map((c) => c.where),
    [],
    'these estimateGas calls omit the block, which anvil reads as "pending" (a full state walk per call): pass blockTag: "latest"',
  );
  const pending = calls.filter((c) => /blockTag\s*:\s*["']pending["']/.test(c.args));
  assert.deepEqual(pending.map((c) => c.where), [], "an estimate against pending walks the whole state");
});
