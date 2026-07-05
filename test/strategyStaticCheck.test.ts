import test from "node:test";
import assert from "node:assert/strict";
import { findCheatcodeUsage } from "../core/src/strategyStaticCheck.js";

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
