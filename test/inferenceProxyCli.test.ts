// The proxy process survives a record it cannot write (issue #215). The unit tests cover the server;
// this one runs the CLI as the operator does, because the failure was the process exiting with code
// 1 on an unhandled rejection, and only the process can show it no longer does.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test("the CLI keeps serving after a record write fails, and says so on stderr", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eris-proxy-cli-"));
  const models = join(dir, "models.yaml");
  // An upstream nobody listens on: the call fails upstream (502) and is then recorded -- into a
  // path that is a directory, so the write fails too.
  writeFileSync(
    models,
    "maxCallsPerMinute: 0\nmodels:\n  - name: gpt-x\n    provider: openai\n    upstream: http://127.0.0.1:1/v1\n",
  );
  const record = join(dir, "record");
  mkdirSync(join(record, "alice.jsonl"), { recursive: true });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "core/src/cli/inferenceProxy.ts", "--models", models, "--listen", "127.0.0.1:0", "--record", record],
    { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => (stderr += c));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  t.after(() => {
    child.kill("SIGKILL");
  });
  const until = Date.now() + 45_000;
  while (!/listening on http:\/\/127\.0\.0\.1:\d+/.test(stderr)) {
    if (child.exitCode !== null) assert.fail(`the proxy exited before listening:\n${stderr}`);
    if (Date.now() > until) assert.fail(`the proxy did not start:\n${stderr}`);
    await delay(50);
  }
  const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)![1]);
  assert.ok(port > 0, "the bound port is printed, not the 0 that was asked for");
  const call = () =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eris-agent": "alice" },
      body: JSON.stringify({ model: "gpt-x", messages: [] }),
    });
  assert.equal((await call()).status, 502, "the call is answered (the upstream is down)");
  await delay(200);
  assert.equal(child.exitCode, null, `the proxy exited:\n${stderr}`);
  assert.match(stderr, /record for alice not written \(the call was served\): EISDIR/);
  assert.equal((await call()).status, 502, "and the next call too");
  const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { recording: { failures: number } };
  assert.equal(health.recording.failures, 2);
  child.kill("SIGTERM");
  await exited;
});
