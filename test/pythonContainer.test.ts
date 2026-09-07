import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

test("Docker uses its own Python in image and bind-mount modes, with an explicit override", t => {
  const dir = mkdtempSync(join(tmpdir(), "eris-python-container-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "args.json");
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ERIS_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(docker, 0o700);
  for (const [bind, python] of [["0", ""], ["1", ""], ["0", "/opt/team/python"]]) {
    const result = spawnSync("bash", ["infra/docker-agent/run-agent.sh"], {
      env: {
        ...process.env,
        PATH: dir + delimiter + process.env.PATH,
        ERIS_TEST_CAPTURE: capture,
        ERIS_REPO: process.cwd(),
        ERIS_AGENT_ID: "python-test",
        ERIS_AGENT_DIR: resolve("example/agents/my-arb-py"),
        ERIS_RUN_DIR: join(dir, "run"),
        ERIS_AGENT_IMAGE: "",
        ERIS_AGENT_BINDMOUNT: bind,
        ERIS_AGENT_ISOLATE: "0",
        ERIS_BASE_IMAGE: "test-python-base",
        ERIS_PYTHON: "/host/venv/bin/python",
        ERIS_DOCKER_PYTHON: python,
      },
      timeout: 5000,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(capture, "utf8")) as string[];
    assert.ok(args.includes(`ERIS_PYTHON=${python || "python3"}`));
    assert.ok(!args.includes("ERIS_PYTHON"));
    assert.ok(!args.some(arg => arg.includes("/host/venv")));
    if (bind === "1") {
      assert.ok(args.includes("test-python-base"));
      assert.equal(args[args.indexOf("--entrypoint") + 1], "node");
    }
  }
});
