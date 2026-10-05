// The owner-guard audit (issue #40 T0) recorded every failed probe as "guarded", so a slow RPC or a
// malformed call passed the audit. Only a revert is evidence of a guard; anything else has to reach
// the fatal path as unreachable, which is what the GuardFinding type said all along.
import test from "node:test";
import assert from "node:assert/strict";
import {
  probeErrorIsRevert,
  unprotectedFindings,
  type GuardFinding,
  type GuardProbe,
} from "../core/src/realtime/ownerGuards.js";

test("only a revert counts as a guard", () => {
  for (const msg of [
    "execution reverted: Ownable: caller is not the owner",
    'The contract function "setAnswer" reverted.',
    "Execution reverted for an unknown reason.",
    "Execution reverted with reason: custom error 0x82b42900",
  ]) {
    assert.equal(probeErrorIsRevert(new Error(msg)), true, msg);
  }
  for (const msg of [
    "The request took too long to respond.",
    "HTTP request failed.",
    "fetch failed",
    "Invalid parameters were provided to the RPC method.",
  ]) {
    assert.equal(probeErrorIsRevert(new Error(msg)), false, msg);
  }
  assert.equal(probeErrorIsRevert("socket hang up"), false);
});

test("an inconclusive probe is reported with the unprotected ones", () => {
  const address = "0x0000000000000000000000000000000000000001";
  const probes: GuardProbe[] = [{ label: "oracle.setPrice", address, data: "0x" }];
  const findings: GuardFinding[] = [
    {
      label: "oracle.setPrice",
      address,
      status: "unreachable",
      detail: "probe did not complete: The request took too long to respond.",
    },
  ];
  assert.deepEqual(
    unprotectedFindings(findings, probes).map((f) => f.status),
    ["unreachable"],
  );
});
