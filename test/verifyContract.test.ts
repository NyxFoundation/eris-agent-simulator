// Pure-function tests for verifyContract's mock source audit (ADR 0014 §4-2).
// Chain-independent. The aim is to pin down that honest-side comments (e.g. "does not skim") do not cause a
// false positive — the audit decides on swap structure (a branch that subtracts out when amountIn exceeds a threshold), not comments/variable names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditContractWithLlm } from "../example/agents/lib/verifyContract.js";

const ROOT = resolve(import.meta.dirname, "..");
const riggedSrc = readFileSync(
  resolve(ROOT, "contracts/RiggedAMM.sol"),
  "utf8",
);
const simpleSrc = readFileSync(
  resolve(ROOT, "contracts/SimpleAMM.sol"),
  "utf8",
);
const probe = { quotedOut: "1000", simOut: "540", amountIn: "5000" };

test("mock audit: judges RiggedAMM's conditional skim as rigged", async () => {
  const v = await auditContractWithLlm(riggedSrc, probe, "mock");
  assert.ok(v && v.safe === false, `${JSON.stringify(v)}`);
});

test("mock audit: SimpleAMM is safe (no false positive from a 'does not skim' comment)", async () => {
  const v = await auditContractWithLlm(simpleSrc, probe, "mock");
  assert.ok(v && v.safe === true, `${JSON.stringify(v)}`);
});

test("mock audit: the verdict is unchanged after removing comments (structure-based)", async () => {
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const vr = await auditContractWithLlm(strip(riggedSrc), probe, "mock");
  const vs = await auditContractWithLlm(strip(simpleSrc), probe, "mock");
  assert.ok(vr && vr.safe === false);
  assert.ok(vs && vs.safe === true);
});

test("mock audit: mode '0' is null (skip)", async () => {
  assert.equal(await auditContractWithLlm(riggedSrc, probe, "0"), null);
});
