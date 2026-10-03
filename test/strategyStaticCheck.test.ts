import test from "node:test";
import assert from "node:assert/strict";
import {
  findAssembledCheatcodeHints,
  findCheatcodeUsage,
} from "@eris/sdk/strategyStaticCheck.js";

test("findCheatcodeUsage: detects cheatcode RPC with line numbers", () => {
  const source = [
    "const obs = JSON.parse(line);",
    'await client.request({ method: "anvil_setBalance", params: [me, cap] });',
    'await client.request({ method: "evm_increaseTime", params: [3600] });',
  ].join("\n");
  const findings = findCheatcodeUsage(source);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => [f.line, f.match]),
    [
      [2, "anvil_setBalance"],
      [3, "evm_increaseTime"],
    ],
  );
});

test("findCheatcodeUsage: also detects imports of environment-only privileged helpers", () => {
  const findings = findCheatcodeUsage(
    'import { dealErc20, setEthBalance } from "../../src/chain.js";',
  );
  assert.equal(findings.length, 1);
  assert.equal(
    findings[0].rule,
    "privileged chain.ts helper (environment-only)",
  );
});

test("findCheatcodeUsage: passes healthy strategy code through untouched", () => {
  const source = [
    "const gap = fair / pool - 1;",
    'emit({ type: "swap", tokenIn: "WETH", amountIn: amountIn.toString() });',
    "const evmCompatible = true; // the bare word evm is not detected",
  ].join("\n");
  assert.deepEqual(findCheatcodeUsage(source), []);
});

// Issue #216 (5): the line check is an entrance gate, and an assembled method name walks through
// it. The hints name that shape for a reviewer; they never fail the gate, and they are not complete.
test("findCheatcodeUsage: a method name assembled at runtime passes the gate (documented limit)", () => {
  const bypass = 'await client.request({ method: ["anvil", "setBalance"].join("_"), params: [me, cap] });';
  assert.deepEqual(findCheatcodeUsage(bypass), []);
});

test("findAssembledCheatcodeHints: reports the cheap shapes of an assembled cheatcode name", () => {
  const source = [
    'const ns = "anvil";',
    "const name = ns + \"_\" + parts.join(\"\");",
    "await client.request({ method: name, params: [me, cap] });",
    'const m2 = ["evm_", "mine"].join("");',
    "const m3 = String.fromCharCode(97, 110, 118, 105, 108);",
  ].join("\n");
  const hints = findAssembledCheatcodeHints(source);
  assert.deepEqual(
    hints.map((h) => [h.line, h.match]),
    [
      [1, '"anvil"'],
      [3, "method: n"],
      [4, '"evm_"'],
      [5, "String.fromCharCode"],
    ],
  );
  // Reported, not enforced: the gate itself still sees nothing here.
  assert.deepEqual(findCheatcodeUsage(source), []);
});

test("findAssembledCheatcodeHints: stays quiet on literal RPC methods and type annotations", () => {
  const source = [
    'await client.request({ method: "eth_call", params: [tx, "latest"] });',
    "type Call = { method: string; params: unknown[] };",
    "const evmCompatible = true;",
    'const note = "the anvil fork"; // the word inside a longer string is not a fragment',
  ].join("\n");
  assert.deepEqual(findAssembledCheatcodeHints(source), []);
});

test("findAssembledCheatcodeHints: is not complete, and says so by missing a split inside the namespace", () => {
  // `"anv" + "il_setBalance"` matches no hint: the check reports shapes, it does not close the hole.
  assert.deepEqual(findAssembledCheatcodeHints('const m = "anv" + "il_setBalance";'), []);
  assert.deepEqual(findCheatcodeUsage('const m = "anv" + "il_setBalance";'), []);
});
