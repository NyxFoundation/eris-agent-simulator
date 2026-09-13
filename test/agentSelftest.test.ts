import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { selftestVerdict } from "../scripts/agentSelftest.js";
import { RealtimeAgentProcess } from "../core/src/realtime/agentProcess.js";

const agent = { id: "team", includedTxCount: 14, revertCount: 2, stderrTail: "" };
test("self-test reports completion with counts, including an idle strategy", () => {
  for (const includedTxCount of [0, 14]) {
    const verdict = selftestVerdict({ blocksProcessed: 40, agents: [{ ...agent, includedTxCount }] }, "team", "4g");
    assert.equal(verdict.passed, true);
    assert.match(verdict.message, new RegExp(`PASS team:.*4g; ${includedTxCount} included.*2 reverted`));
  }
});

for (const termination of [
  { code: 0, script: "process.exit(0)", detail: "code 0", possibleOom: false },
  { code: 1, script: "process.exit(1)", detail: "code 1", possibleOom: false },
  { code: 137, script: "process.exit(137)", detail: "code 137", possibleOom: true },
  { signal: "SIGKILL", script: 'process.kill(process.pid, "SIGKILL")', detail: "signal SIGKILL", possibleOom: true },
  { command: "/eris-selftest-missing-command", detail: "spawn error:", possibleOom: false },
]) {
  test(`self-test reports a real child termination: ${termination.detail}`, { timeout: 10_000 }, async () => {
    const child = new RealtimeAgentProcess(
      { id: "team", wallet: "AUTO", command: termination.command ?? process.execPath,
        args: ["-e", termination.script ?? ""] },
      "http://127.0.0.1:1", "0x0000000000000000000000000000000000000001", "/tmp/eris-selftest-exit",
      { privateKey: "0xtest", priceFeedAddress: "0x0000000000000000000000000000000000000002", runId: "test" },
      "example/agents", 0,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await new Promise<{ reason: string; code?: number; signal?: string }>((resolve, reject) => {
        child.onExit = resolve;
        timeout = setTimeout(() => reject(new Error("agent did not exit")), 5000);
      });
      assert.equal(info.code, termination.code);
      assert.equal(info.signal, termination.signal);
      // This is the exact field the coordinator writes, not a fabricated exit message.
      const verdict = selftestVerdict({ blocksProcessed: 40, agents: [{
        ...agent, processExitedEarly: info.reason, stderrTail: "startup failed",
      }] }, "team", "4g");
      assert.equal(verdict.passed, false);
      assert.ok(verdict.message.includes(termination.detail), verdict.message);
      assert.match(verdict.message, /startup failed/);
      if (termination.possibleOom) {
        assert.match(verdict.message, /possible OOM.*4g/);
        assert.match(verdict.message, /does not prove OOM/);
      } else {
        assert.doesNotMatch(verdict.message, /OOM/);
      }
    } finally {
      clearTimeout(timeout);
      if (child.isAlive()) child.close();
    }
  });
}

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
