// What infra/docker-agent/run-agent.sh mounts into an agent container, read off the real script with
// a stub `docker` on PATH (no daemon needed). In image mode the container gets its view directory
// read-only and its own log files -- not the run directory, which holds the coordinator's records
// and the other agents' logs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const WRAPPER = resolve("infra/docker-agent/run-agent.sh");

type Mount = { source: string; target: string; readOnly: boolean };

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "eris-run-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const capture = join(dir, "docker-run.json");
  // Records the `docker run` argv; every other subcommand (image inspect, ps, rm) is a no-op.
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nconst a = process.argv.slice(2);\n` +
      `if (a[0] === "run") require("node:fs").writeFileSync(process.env.ERIS_TEST_CAPTURE, JSON.stringify(a));\n`,
  );
  chmodSync(join(bin, "docker"), 0o700);
  const runDir = join(dir, "runs", "2026-09-27T00-00-00-000Z");
  const viewDir = join(runDir, "agent-view", "probe");
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(join(viewDir, "config.yaml"), "run:\n  blocks: 12\n");
  return { dir, bin, capture, runDir, viewDir };
}

function runWrapper(
  ctx: ReturnType<typeof setup>,
  env: Record<string, string>,
): { args: string[]; mounts: Mount[]; envs: string[] } {
  const result = spawnSync("bash", [WRAPPER], {
    env: {
      // Built, not inherited: an ERIS_* in the developer's shell would change what is mounted.
      PATH: ctx.bin + delimiter + (process.env.PATH ?? ""),
      HOME: ctx.dir,
      ERIS_TEST_CAPTURE: ctx.capture,
      ERIS_REPO: process.cwd(),
      ERIS_AGENT_ID: "probe",
      ERIS_AGENT_DIR: resolve("example/agents/noop"),
      ERIS_AGENT_IMAGE: "eris-agent:probe",
      ERIS_RUN_DIR: ctx.runDir,
      ...env,
    },
    timeout: 10_000,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(ctx.capture, "utf8")) as string[];
  const mounts: Mount[] = [];
  const envs: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-v") {
      const [source, target, mode] = args[i + 1].split(":");
      mounts.push({ source, target, readOnly: mode === "ro" });
    } else if (args[i] === "-e") envs.push(args[i + 1]);
  }
  return { args, mounts, envs };
}

test("image mode mounts the agent's view read-only and its own log, not the run directory", (t) => {
  const ctx = setup(t);
  const { mounts, envs } = runWrapper(ctx, {
    ERIS_AGENT_VIEW_DIR: ctx.viewDir,
  });

  assert.deepEqual(
    mounts.find((m) => m.target === "/eris/run"),
    { source: ctx.viewDir, target: "/eris/run", readOnly: true },
  );
  const log = join(ctx.runDir, "agents", "probe.jsonl");
  assert.deepEqual(
    mounts.find((m) => m.target === "/eris/run/agents/probe.jsonl"),
    { source: log, target: "/eris/run/agents/probe.jsonl", readOnly: false },
  );
  // Nothing else of the run: not the run directory, not the agents directory, not the transcript.
  assert.equal(mounts.length, 2, JSON.stringify(mounts));
  assert.ok(!mounts.some((m) => m.source === ctx.runDir));
  assert.ok(!mounts.some((m) => m.source === join(ctx.runDir, "agents")));

  assert.ok(envs.includes("ERIS_RUN_DIR=/eris/run"));
  assert.ok(envs.includes("ERIS_CONFIG=/eris/run/config.yaml"));
  // A host path, meaningless inside, and not forwarded.
  assert.ok(!envs.some((e) => e.startsWith("ERIS_AGENT_VIEW_DIR")));

  // The log exists on the host where the dashboard reads it, and its mountpoint in the view.
  assert.ok(existsSync(log));
  assert.ok(existsSync(join(ctx.viewDir, "agents", "probe.jsonl")));
});

test("image mode adds the transcript only when it is recorded, and disclosures read-only", (t) => {
  const ctx = setup(t);
  mkdirSync(join(ctx.runDir, "disclosures"));
  const { mounts } = runWrapper(ctx, {
    ERIS_AGENT_VIEW_DIR: ctx.viewDir,
    ERIS_IMPROVE_LOG_CALLS: "1",
  });
  assert.deepEqual(
    mounts.find((m) => m.target === "/eris/run/agents/probe.llm.jsonl"),
    {
      source: join(ctx.runDir, "agents", "probe.llm.jsonl"),
      target: "/eris/run/agents/probe.llm.jsonl",
      readOnly: false,
    },
  );
  assert.deepEqual(
    mounts.find((m) => m.target === "/eris/run/disclosures"),
    {
      source: join(ctx.runDir, "disclosures"),
      target: "/eris/run/disclosures",
      readOnly: true,
    },
  );
  assert.equal(mounts.length, 4, JSON.stringify(mounts));
});

test("an agent id that cannot be one mount path segment is refused", (t) => {
  const ctx = setup(t);
  const result = spawnSync("bash", [WRAPPER], {
    env: {
      PATH: ctx.bin + delimiter + (process.env.PATH ?? ""),
      HOME: ctx.dir,
      ERIS_TEST_CAPTURE: ctx.capture,
      ERIS_REPO: process.cwd(),
      ERIS_AGENT_ID: "a:b",
      ERIS_AGENT_DIR: resolve("example/agents/noop"),
      ERIS_AGENT_IMAGE: "eris-agent:probe",
      ERIS_RUN_DIR: ctx.runDir,
      ERIS_AGENT_VIEW_DIR: ctx.viewDir,
    },
    timeout: 10_000,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.ok(!existsSync(ctx.capture), "docker run was reached");
});

test("without a view directory, or in a segmented period, image mode keeps the directory mount", (t) => {
  const ctx = setup(t);
  const legacy = runWrapper(ctx, {});
  assert.ok(legacy.mounts.some((m) => m.source === ctx.runDir && !m.readOnly));

  const pointer = join(ctx.dir, "runs", "current-segment");
  writeFileSync(pointer, ctx.runDir);
  const segmented = runWrapper(ctx, {
    ERIS_AGENT_VIEW_DIR: ctx.viewDir,
    ERIS_RUN_DIR_POINTER: pointer,
    ERIS_CONFIG: join(ctx.viewDir, "config.yaml"),
  });
  assert.ok(segmented.mounts.some((m) => m.source === join(ctx.dir, "runs")));
  assert.ok(
    segmented.mounts.some(
      (m) => m.source === join(ctx.viewDir, "config.yaml") && m.readOnly,
    ),
  );
});
