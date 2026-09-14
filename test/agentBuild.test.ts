import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

test("team builds refresh an existing base before copying team code; a failed base stops the build", t => {
  const dir = mkdtempSync(join(tmpdir(), "eris-build-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.jsonl");
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!${process.execPath}\nconst args=process.argv.slice(2); require('node:fs').appendFileSync(process.env.CAPTURE, JSON.stringify(args)+'\\n'); if (process.env.FAIL_BASE === '1' && args.includes('infra/docker-agent/Dockerfile.base')) process.exit(7);\n`);
  chmodSync(docker, 0o700);
  const run = (fail: boolean) => spawnSync("bash", ["infra/docker-agent/build.sh", "team", "my-arb"], {
    env: { ...process.env, PATH: dir + delimiter + process.env.PATH, CAPTURE: log, FAIL_BASE: fail ? "1" : "0" },
    encoding: "utf8", timeout: 10_000,
  });
  for (let i = 0; i < 2; i++) {
    writeFileSync(log, "");
    const result = run(false);
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.ok(calls[0].includes("infra/docker-agent/Dockerfile.base"));
    assert.ok(calls[2].includes("infra/docker-agent/Dockerfile.team"));
  }
  writeFileSync(log, "");
  assert.equal(run(true).status, 7);
  assert.doesNotMatch(readFileSync(log, "utf8"), /Dockerfile.team/);
});
