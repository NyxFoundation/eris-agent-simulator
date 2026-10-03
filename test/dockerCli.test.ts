// Docker calls the coordinator makes from inside the block loop, bounded (issue #223).
//
// These run synchronously on the environment's own thread, so an unbounded one is an unbounded stop
// of the oracle write, the GMX keeper and the flow. The timeout is measured against a real `docker`
// on PATH that never answers; the rest is pure with respect to docker, so the removal's read-back and
// the attempt budget are tested without a daemon.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { DockerRunner } from "../core/src/realtime/agentNetwork.js";
import {
  createDockerRunner,
  PROBE_ATTEMPTS,
  ProbeBudget,
  REMOVE_TRIES,
  removeAgentContainer,
} from "../core/src/realtime/dockerCli.js";
import {
  createAgentStopper,
  type StoppableAgent,
} from "../core/src/realtime/agentStop.js";

/** A `docker` on PATH whose body is `body`: here, one that sleeps instead of answering. */
function stubDockerBin(body: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), "eris-docker-cli-")), "bin");
  mkdirSync(bin);
  const path = join(bin, "docker");
  // `exec`, so the process spawnSync kills on the deadline is the one holding its stdio open.
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return bin;
}

test("createDockerRunner: a docker that never answers costs its deadline, not the run", () => {
  const bin = stubDockerBin("exec sleep 30");
  const saved = process.env.PATH ?? "";
  process.env.PATH = bin + delimiter + saved;
  try {
    const started = Date.now();
    const result = createDockerRunner(400)([
      "inspect",
      "-f",
      "{{json .NetworkSettings.Networks}}",
      "eris-a",
    ]);
    const elapsed = Date.now() - started;
    // Without the deadline this call returns when the daemon feels like it. The coordinator makes two
    // of them per agent at the agents-ready wait and again every interval for whatever is pending, so
    // one sulking daemon stopped every block the environment owed the chain.
    assert.ok(elapsed < 5_000, `the call took ${elapsed} ms`);
    assert.notEqual(result.status, 0, "a deadline must not read as an answer");
    assert.match(result.stderr, /did not answer within 400 ms/);
    assert.equal(result.stdout, "");
  } finally {
    process.env.PATH = saved;
  }
});

test("createDockerRunner: an answer within the deadline comes back whole", () => {
  const bin = stubDockerBin('printf "true\\n"');
  const saved = process.env.PATH ?? "";
  process.env.PATH = bin + delimiter + saved;
  try {
    const result = createDockerRunner(5_000)(["network", "inspect", "ag-a"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "true");
  } finally {
    process.env.PATH = saved;
  }
});

test("ProbeBudget: a container docker will not describe is asked a fixed number of times", () => {
  const budget = new ProbeBudget(3);
  assert.equal(budget.failed("a"), false);
  assert.equal(budget.failed("a"), false);
  assert.equal(budget.failed("a"), true, "the third attempt spends the budget");
  assert.equal(budget.count("a"), 3);
  // Every id has its own budget, and one that answers after a bad patch starts over.
  assert.equal(budget.failed("b"), false);
  budget.forget("a");
  assert.equal(budget.count("a"), 0);
  const dflt = new ProbeBudget();
  for (let i = 1; i < PROBE_ATTEMPTS; i++)
    assert.equal(dflt.failed("c"), false, `attempt ${i} is not the last`);
  assert.equal(dflt.failed("c"), true);
});

type DockerPlan = {
  running: Set<string>;
  /** `docker rm -f` answers non-zero (no such container, or a daemon that refuses). */
  rmFails?: boolean;
  /** `docker ps` answers non-zero: the daemon will not say, which is not absence. */
  psFails?: boolean;
};

function fakeDocker(plan: DockerPlan): {
  run: DockerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: DockerRunner = (args) => {
    calls.push(args);
    if (args[0] === "rm") {
      if (plan.rmFails === true)
        return {
          status: 1,
          stdout: "",
          stderr: `Error response from daemon: No such container: ${args[2]}`,
        };
      plan.running.delete(args[2]);
      return { status: 0, stdout: `${args[2]}\n`, stderr: "" };
    }
    if (args[0] === "ps") {
      if (plan.psFails === true)
        return {
          status: 1,
          stdout: "",
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        };
      const name = (args[3] ?? "").replace(/^name=\^/, "").replace(/\$$/, "");
      return {
        status: 0,
        stdout: plan.running.has(name) ? "c0ffee\n" : "",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("removeAgentContainer: the name is the one run-agent.sh gives the container", () => {
  // The removal is addressed by name, so the two have to agree. If the wrapper's naming changes this
  // fails here rather than in a run where the quota is detected and nothing is stopped.
  const script = readFileSync(resolve("infra/docker-agent/run-agent.sh"), "utf8");
  assert.match(script, /^NAME="eris-\$\{ERIS_AGENT_ID/m);
  const docker = fakeDocker({ running: new Set(["eris-venue-arb"]) });
  const removal = removeAgentContainer("venue-arb", docker.run);
  assert.equal(removal.container, "eris-venue-arb");
  assert.equal(removal.gone, true);
  assert.deepEqual(docker.calls[0], ["rm", "-f", "eris-venue-arb"]);
});

test("removeAgentContainer: gone only when docker answered and said so", () => {
  // A container that was never there: rm exits non-zero, ps says it is not running, and that is gone.
  const absent = fakeDocker({ running: new Set(), rmFails: true });
  const r1 = removeAgentContainer("a", absent.run);
  assert.equal(r1.gone, true);
  assert.match(r1.detail, /is not running/);

  // A daemon that will not answer is not evidence of absence -- the mistake that leaves the container
  // this function exists to remove running with its key for the rest of the run.
  const mute = fakeDocker({ running: new Set(["eris-a"]), psFails: true });
  const r2 = removeAgentContainer("a", mute.run);
  assert.equal(r2.gone, false);
  assert.equal(r2.attempts, REMOVE_TRIES, "a mute daemon is retried");
  assert.match(r2.detail, /cannot be confirmed gone/);

  // A container that survives `rm -f`.
  const survivor = fakeDocker({ running: new Set(["eris-a"]), rmFails: true });
  const r3 = removeAgentContainer("a", survivor.run);
  assert.equal(r3.gone, false);
  assert.match(r3.detail, /still running after docker rm -f/);
});

function stopper(plan: DockerPlan, sandbox = "docker") {
  const events: Array<Record<string, unknown>> = [];
  const docker = fakeDocker(plan);
  const due: Array<() => void> = [];
  const agentStopper = createAgentStopper({
    sandbox,
    docker: docker.run,
    event: (event) => void events.push(event),
    log: () => {},
    // The grace is the coordinator's timer; here it is run on demand so the test does not sleep.
    schedule: (fn) => void due.push(fn),
  });
  return {
    ...agentStopper,
    events,
    calls: docker.calls,
    grace: () => {
      for (const fn of due.splice(0)) fn();
    },
  };
}

const agent = (): StoppableAgent & { closed: number } => {
  const a = {
    id: "greedy",
    closed: 0,
    process: { close: () => void a.closed++ },
  } as StoppableAgent & { closed: number };
  return a;
};

test("createAgentStopper: a docker agent's container is removed after the grace (issue #223)", () => {
  // The whole of issue #214 item 1 rests on this: a quota the environment detects and does not
  // enforce is an event in a log. close() reaches the `docker run` client, not the container.
  const s = stopper({ running: new Set(["eris-greedy"]) });
  const a = agent();
  s.stop(a, "stopped by the environment: disk quota exceeded", "disk quota exceeded");
  assert.equal(a.exitedEarly, "stopped by the environment: disk quota exceeded");
  assert.equal(a.closed, 1);
  // Nothing before the grace: a runtime that does stop on SIGTERM gets to flush its log.
  assert.deepEqual(s.calls, []);
  s.grace();
  assert.deepEqual(s.calls[0], ["rm", "-f", "eris-greedy"]);
  const removed = s.events.find((e) => e.type === "agent_container_removed");
  assert.ok(removed, `no removal event in ${JSON.stringify(s.events)}`);
  assert.equal(removed.why, "disk quota exceeded");
});

test("createAgentStopper: under the process sandbox close() is the whole stop", () => {
  const s = stopper({ running: new Set() }, "process");
  const a = agent();
  s.stop(a, "stopped", "disk quota exceeded");
  s.grace();
  assert.deepEqual(s.calls, [], "there is no container to remove");
  assert.deepEqual(s.events, []);
});

test("createAgentStopper: a container that will not go is retried, then recorded as abandoned", () => {
  // Bounded, and the giving up is in the record: a container that outlives the run holds its key and
  // its RPC connection, and the operator has reap.sh for it -- but only if they are told.
  const s = stopper({ running: new Set(["eris-greedy"]), rmFails: true });
  const a = agent();
  s.stop(a, "stopped", "disk quota exceeded");
  s.grace();
  for (let i = 1; i < PROBE_ATTEMPTS; i++)
    s.escalate("greedy", "still writing after being stopped");
  const failures = s.events.filter(
    (e) => e.type === "agent_container_remove_failed",
  );
  assert.equal(failures.length, PROBE_ATTEMPTS);
  assert.equal(
    s.events.filter((e) => e.type === "agent_container_remove_abandoned").length,
    0,
    "the budget is spent, not yet overspent",
  );
  s.escalate("greedy", "still writing after being stopped");
  const abandoned = s.events.find(
    (e) => e.type === "agent_container_remove_abandoned",
  );
  assert.ok(abandoned);
  assert.equal(abandoned.attempts, PROBE_ATTEMPTS);
  // Once, not on every tick that finds it still writing.
  s.escalate("greedy", "still writing after being stopped");
  assert.equal(
    s.events.filter((e) => e.type === "agent_container_remove_abandoned").length,
    1,
  );
});
