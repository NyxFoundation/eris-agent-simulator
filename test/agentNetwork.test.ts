// The network a docker agent is actually on, measured (issue #214 item 4; agentNetwork.ts).
//
// `agentNetworkPosture` says what run-agent.sh will do with the env it is given. Docker is asked
// afterwards what it did, through a runner supplied by the caller -- faked here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  agentContainerName,
  agentIsolationNetwork,
  measureAgentNetworks,
  networkMismatches,
  parseContainerNetworks,
  parseInternalFlag,
  type DockerRunner,
} from "../core/src/realtime/agentNetwork.js";
import { agentNetworkPosture } from "../core/src/realtime/agentView.js";

type Daemon = {
  containers: Record<string, string[]>; // container name -> networks
  internal: Record<string, boolean>; // network name -> --internal
};

function fakeDocker(d: Daemon): { run: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerRunner = (args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      const nets = d.containers[args[3]];
      if (nets === undefined)
        return { status: 1, stdout: "", stderr: `Error: No such object: ${args[3]}\n` };
      const json: Record<string, unknown> = {};
      for (const n of nets) json[n] = { NetworkID: "x" };
      return { status: 0, stdout: `${JSON.stringify(json)}\n`, stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const flag = d.internal[args[4]];
      if (flag === undefined)
        return { status: 1, stdout: "", stderr: `Error: No such network: ${args[4]}\n` };
      return { status: 0, stdout: `${flag}\n`, stderr: "" };
    }
    return { status: 2, stdout: "", stderr: "unexpected\n" };
  };
  return { run, calls };
}

const isolated = agentNetworkPosture(
  { ERIS_AGENT_ISOLATE: "1", ERIS_AGENT_INTERNAL: "1" },
  "linux",
);
const isolatedOpen = agentNetworkPosture({ ERIS_AGENT_ISOLATE: "1" }, "linux");
const shared = agentNetworkPosture({}, "linux");

test("names follow run-agent.sh", () => {
  assert.equal(agentContainerName("venue-arb"), "eris-venue-arb");
  assert.equal(agentIsolationNetwork("venue-arb"), "ag-venue-arb");
  assert.deepEqual(parseContainerNetworks('{"ag-a":{},"bridge":{}}'), ["ag-a", "bridge"]);
  assert.deepEqual(parseContainerNetworks("null"), []);
  assert.equal(parseInternalFlag("true\n"), true);
  assert.equal(parseInternalFlag("false"), false);
  assert.equal(parseInternalFlag(""), null);
});

test("measureAgentNetworks: one inspect per container, one per network, and a missing container is unmeasured", () => {
  const { run, calls } = fakeDocker({
    containers: { "eris-a": ["ag-a"], "eris-b": ["ag-b", "bridge"] },
    internal: { "ag-a": true, "ag-b": false, bridge: false },
  });
  const facts = measureAgentNetworks(["a", "b", "c"], run);
  assert.deepEqual(facts[0], {
    id: "a",
    container: "eris-a",
    measured: true,
    networks: [{ name: "ag-a", internal: true }],
  });
  assert.deepEqual(facts[1].networks, [
    { name: "ag-b", internal: false },
    { name: "bridge", internal: false },
  ]);
  assert.equal(facts[2].measured, false);
  assert.match(facts[2].error ?? "", /No such object: eris-c/);
  // Networks are inspected once each, however many containers share them.
  assert.equal(calls.filter((c) => c[0] === "network").length, 3);
});

test("networkMismatches: a container on its own --internal network is where it should be", () => {
  const facts = measureAgentNetworks(
    ["a"],
    fakeDocker({ containers: { "eris-a": ["ag-a"] }, internal: { "ag-a": true } }).run,
  );
  assert.deepEqual(networkMismatches(facts, () => isolated), []);
  // Open egress declared, open egress measured: also consistent (the banner covers the policy).
  const open = measureAgentNetworks(
    ["a"],
    fakeDocker({ containers: { "eris-a": ["ag-a"] }, internal: { "ag-a": false } }).run,
  );
  assert.deepEqual(networkMismatches(open, () => isolatedOpen), []);
});

test("networkMismatches: a reused non-internal network, a shared network and an extra one are each named", () => {
  const { run } = fakeDocker({
    containers: {
      "eris-reused": ["ag-reused"],
      "eris-host": ["host"],
      "eris-extra": ["ag-extra", "ascon-chain"],
      "eris-shared-declared": ["host"],
    },
    internal: { "ag-reused": false, "ag-extra": true, "ascon-chain": false, host: false },
  });
  const facts = measureAgentNetworks(
    ["reused", "host", "extra", "shared-declared", "gone"],
    run,
  );
  const found = networkMismatches(facts, (id) =>
    id === "shared-declared" ? shared : isolated,
  );
  assert.deepEqual(
    found.map((m) => `${m.id}:${m.kind}`),
    ["reused:route-out", "host:shared-network", "extra:extra-network"],
  );
  assert.match(found[0].detail, /ag-reused is not --internal/);
  assert.match(found[1].detail, /on host, not ag-host/);
  assert.match(found[2].detail, /attached to ascon-chain besides ag-extra/);
  // An unmeasured container is not a mismatch; the caller reports it as unmeasured.
  assert.ok(!found.some((m) => m.id === "gone"));
});
