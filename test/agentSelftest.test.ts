import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { selftestVerdict } from "../scripts/agentSelftest.js";

const agent = { id: "team", includedTxCount: 14, revertCount: 2, stderrTail: "" };
test("self-test reports completion with counts, including an idle strategy", () => {
  for (const includedTxCount of [0, 14]) {
    const verdict = selftestVerdict({ blocksProcessed: 40, agents: [{ ...agent, includedTxCount }] }, "team", "4g");
    assert.equal(verdict.passed, true);
    assert.match(verdict.message, new RegExp(`PASS team:.*4g; ${includedTxCount} included.*2 reverted`));
  }
});

test("self-test fails every early exit, including code zero, and explains SIGKILL without asserting OOM", () => {
  for (const reason of ["exit code 0", "exit code 1", "exit code 137", "signal SIGKILL"]) {
    const verdict = selftestVerdict({ blocksProcessed: 40, agents: [{ ...agent, processExitedEarly: reason, stderrTail: "startup failed" }] }, "team", "4g");
    assert.equal(verdict.passed, false);
    assert.ok(verdict.message.includes(reason));
    assert.match(verdict.message, /startup failed/);
    if (/137|SIGKILL/.test(reason)) assert.match(verdict.message, /possible OOM.*4g/);
  }
});

test("self-test cannot pass a missing, malformed, duplicate or unrelated agent record", () => {
  for (const summary of [null, {}, { blocksProcessed: 40, agents: [] }, { blocksProcessed: 40, agents: [{ id: "team" }] },
    { blocksProcessed: 40, agents: [agent, agent] }, { blocksProcessed: 40, agents: [{ ...agent, id: "someone-else" }] }])
    assert.equal(selftestVerdict(summary, "team", "4g").passed, false);
});

test("self-test exits nonzero with setup instructions before building when the chain is unavailable", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/agentSelftest.ts", "my-arb"], {
    env: { ...process.env, ERIS_RPC_URL: "http://127.0.0.1:1" }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FAIL self-test: no working chain.*gen:local-constants/);
  assert.doesNotMatch(result.stdout, /build images/);
});
