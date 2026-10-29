// The network a docker agent is actually on, measured (issue #214 item 4; agentNetwork.ts).
//
// `agentNetworkPosture` says what run-agent.sh will do with the env it is given. Docker is asked
// afterwards what it did, through a runner supplied by the caller -- faked here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  agentContainerName,
  agentIsolationNetwork,
  hostReachable,
  keepsNetRaw,
  measureAgentNetworks,
  networkMismatches,
  parseContainerNetworks,
  parseInternalFlag,
  parseNetworkInspect,
  type DockerRunner,
} from "../core/src/realtime/agentNetwork.js";
import { agentNetworkPosture } from "../core/src/realtime/agentView.js";

type Daemon = {
  containers: Record<string, string[]>; // container name -> networks
  internal: Record<string, boolean>; // network name -> --internal
  // network name -> docker's gateway mode; absent = "isolated" for an internal network (what
  // run-agent.sh creates), docker's default otherwise
  gatewayMode?: Record<string, string>;
  // container name -> capabilities kept; absent = NET_RAW dropped (what run-agent.sh launches)
  keepsNetRaw?: Record<string, boolean>;
};

function fakeDocker(d: Daemon): { run: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerRunner = (args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      const nets = d.containers[args[3]];
      if (nets === undefined)
        return { status: 1, stdout: "", stderr: `Error: No such object: ${args[3]}\n` };
      const networks: Record<string, unknown> = {};
      for (const n of nets) networks[n] = { NetworkID: "x" };
      const raw = d.keepsNetRaw?.[args[3]] ?? false;
      const json = {
        networks,
        capAdd: null,
        capDrop: raw ? null : ["CAP_NET_RAW"], // docker's own spelling of `--cap-drop NET_RAW`
        privileged: false,
      };
      return { status: 0, stdout: `${JSON.stringify(json)}\n`, stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const name = args[4];
      const flag = d.internal[name];
      if (flag === undefined)
        return { status: 1, stdout: "", stderr: `Error: No such network: ${name}\n` };
      const mode = d.gatewayMode?.[name] ?? (flag ? "isolated" : "");
      // docker prints no Gateway in the IPAM config of an isolated network
      const ipam =
        mode === "isolated"
          ? [{ Subnet: "10.200.1.0/24" }]
          : [{ Subnet: "10.200.1.0/24", Gateway: "10.200.1.1" }];
      return { status: 0, stdout: `${flag}|${mode}|${JSON.stringify(ipam)}\n`, stderr: "" };
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

test("the inspect outputs read as docker 29.8.1 prints them", () => {
  // `docker network inspect -f '{{.Internal}}|{{index .Options "...gateway_mode_ipv4"}}|{{json .IPAM.Config}}'`
  const isolated = parseNetworkInspect(
    "ag-a",
    'true|isolated|[{"Subnet":"172.20.0.0/16"}]\n',
  );
  assert.deepEqual(isolated, {
    name: "ag-a",
    internal: true,
    gatewayMode: "isolated",
    hostAddress: null,
  });
  assert.equal(hostReachable(isolated), false);
  const internalOnly = parseNetworkInspect(
    "ag-b",
    'true||[{"Subnet":"172.19.0.0/16","Gateway":"172.19.0.1"}]\n',
  );
  assert.equal(internalOnly.hostAddress, "172.19.0.1");
  assert.equal(hostReachable(internalOnly), true);
  // Isolated in name but with a gateway listed is still a host address.
  assert.equal(
    hostReachable({ ...isolated, hostAddress: "172.20.0.1" }),
    true,
  );
  // Output that does not read whole is "could not be inspected", not "no host address".
  for (const garbled of ["true|isolated|[{", "true|isolated", ""])
    assert.deepEqual(parseNetworkInspect("ag-c", garbled), {
      name: "ag-c",
      internal: null,
      gatewayMode: null,
      hostAddress: null,
    });
  // `--cap-drop NET_RAW` is reported as CAP_NET_RAW; NET_RAW is in docker's default set.
  assert.equal(keepsNetRaw({ capDrop: ["CAP_NET_RAW"] }), false);
  assert.equal(keepsNetRaw({ capDrop: ["ALL"] }), false);
  assert.equal(keepsNetRaw({ capDrop: null, capAdd: null }), true);
  assert.equal(keepsNetRaw({ capDrop: ["CAP_NET_RAW"], capAdd: ["NET_RAW"] }), true);
  assert.equal(keepsNetRaw({ capDrop: ["CAP_NET_RAW"], privileged: true }), true);
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
    networks: [
      { name: "ag-a", internal: true, gatewayMode: "isolated", hostAddress: null },
    ],
    rawSockets: false,
  });
  assert.deepEqual(
    facts[1].networks.map((n) => [n.name, n.internal, n.hostAddress]),
    [
      ["ag-b", false, "10.200.1.1"],
      ["bridge", false, "10.200.1.1"],
    ],
  );
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

test("networkMismatches: an internal network that gives the host an address, and a container that kept NET_RAW, are each named", () => {
  // Measured 2026-10-29: from a plain --internal network a service on 0.0.0.0 answered a connect to
  // the bridge address, and with CAP_NET_RAW a hand-built TCP handshake reached a service on
  // docker0's address -- where the live week's anvil listens with its cheatcodes open.
  const { run } = fakeDocker({
    containers: {
      "eris-old-net": ["ag-old-net"],
      "eris-raw": ["ag-raw"],
      "eris-both": ["ag-both"],
      "eris-ok": ["ag-ok"],
    },
    internal: { "ag-old-net": true, "ag-raw": true, "ag-both": true, "ag-ok": true },
    gatewayMode: { "ag-old-net": "", "ag-both": "" },
    keepsNetRaw: { "eris-raw": true, "eris-both": true },
  });
  const facts = measureAgentNetworks(["old-net", "raw", "both", "ok"], run);
  const found = networkMismatches(facts, () => isolated);
  assert.deepEqual(
    found.map((m) => `${m.id}:${m.kind}`),
    ["old-net:host-reachable", "raw:raw-socket", "both:host-reachable", "both:raw-socket"],
  );
  assert.match(found[0].detail, /ag-old-net gives the host an address \(10\.200\.1\.1\)/);
  assert.match(found[1].detail, /keeps CAP_NET_RAW/);
  // With egress declared open the host is reachable by routing anyway; neither is judged there.
  assert.deepEqual(networkMismatches(facts, () => isolatedOpen), []);
});
