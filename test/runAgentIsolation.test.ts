// How infra/docker-agent/run-agent.sh sets up an isolated agent's network and capabilities, read off
// the real script with a stateful stub `docker` on PATH (no daemon needed).
//
// `--internal` alone does not keep the host out (measured 2026-10-29, Docker Engine 29.8.1): the
// network still puts the host's address on its bridge, and a container that keeps CAP_NET_RAW
// completed a hand-built TCP handshake to a service on docker0's address -- where the live week's
// anvil listens with anvil_* / evm_* open. So an internal network is created in docker's `isolated`
// gateway mode and read back, and every container drops NET_RAW.
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
const GATEWAY_MODE = "com.docker.network.bridge.gateway_mode_ipv4";

type Net = { internal: boolean; gatewayMode: string; gateway: string | null; members: string[] };
type State = { networks: Record<string, Net>; creates: string[][] };

// A daemon that remembers networks across calls. `ERIS_TEST_IGNORE_GW_MODE=1` plays an engine that
// accepts the gateway-mode option and does nothing with it.
const STUB = `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
const file = process.env.ERIS_TEST_STATE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => fs.writeFileSync(file, JSON.stringify(s));
if (a[0] === "run") {
  fs.writeFileSync(process.env.ERIS_TEST_CAPTURE, JSON.stringify(a));
} else if (a[0] === "network" && a[1] === "inspect") {
  const fmt = a[3], net = s.networks[a[4]];
  if (!net) { process.stderr.write("Error: No such network: " + a[4] + "\\n"); process.exit(1); }
  if (fmt.includes(".Internal")) console.log(String(net.internal));
  else if (fmt.includes("${GATEWAY_MODE}")) console.log(net.gatewayMode);
  else if (fmt.includes("IPAM.Config"))
    console.log(JSON.stringify([net.gateway ? { Subnet: "10.200.1.0/24", Gateway: net.gateway } : { Subnet: "10.200.1.0/24" }]));
  else if (fmt.includes(".Containers")) for (const m of net.members) console.log(m);
} else if (a[0] === "network" && a[1] === "create") {
  s.creates.push(a);
  const name = a[a.length - 1];
  const opt = a.find((x) => x.startsWith("${GATEWAY_MODE}="));
  const mode = opt && process.env.ERIS_TEST_IGNORE_GW_MODE !== "1" ? opt.split("=")[1] : "";
  s.networks[name] = { internal: a.includes("--internal"), gatewayMode: mode,
    gateway: mode === "isolated" ? null : "10.200.1.1", members: [] };
  save();
} else if (a[0] === "network" && a[1] === "rm") {
  delete s.networks[a[2]]; save();
} else if (a[0] === "network" && a[1] === "connect") {
  const net = s.networks[a[2]];
  if (net && !net.members.includes(a[3])) net.members.push(a[3]);
  save();
} else if (a[0] === "network" && a[1] === "disconnect") {
  const net = s.networks[a[3]];
  if (net) net.members = net.members.filter((m) => m !== a[4]);
  save();
}
`;

function setup(t: { after: (fn: () => void) => void }, networks: Record<string, Net> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "eris-run-agent-iso-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), STUB);
  chmodSync(join(bin, "docker"), 0o700);
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ networks, creates: [] } satisfies State));
  const runDir = join(dir, "runs", "2026-10-29T00-00-00-000Z");
  const viewDir = join(runDir, "agent-view", "probe");
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(join(viewDir, "config.yaml"), "run:\n  blocks: 12\n");
  return { dir, bin, state, capture: join(dir, "docker-run.json"), runDir, viewDir };
}

function runWrapper(ctx: ReturnType<typeof setup>, env: Record<string, string>) {
  const result = spawnSync("bash", [WRAPPER], {
    env: {
      // Built, not inherited: an ERIS_* in the developer's shell would change what is set up.
      PATH: ctx.bin + delimiter + (process.env.PATH ?? ""),
      HOME: ctx.dir,
      ERIS_TEST_STATE: ctx.state,
      ERIS_TEST_CAPTURE: ctx.capture,
      ERIS_REPO: process.cwd(),
      ERIS_AGENT_ID: "probe",
      ERIS_AGENT_DIR: resolve("example/agents/noop"),
      ERIS_AGENT_IMAGE: "eris-agent:probe",
      ERIS_RUN_DIR: ctx.runDir,
      ERIS_AGENT_VIEW_DIR: ctx.viewDir,
      ...env,
    },
    timeout: 10_000,
    encoding: "utf8",
  });
  const state = JSON.parse(readFileSync(ctx.state, "utf8")) as State;
  const args = existsSync(ctx.capture)
    ? (JSON.parse(readFileSync(ctx.capture, "utf8")) as string[])
    : null;
  return { status: result.status, stderr: result.stderr, state, args };
}

const ISOLATED_INTERNAL = {
  ERIS_AGENT_ISOLATE: "1",
  ERIS_AGENT_INTERNAL: "1",
  ERIS_AGENT_HUB: "hub",
};

test("an internal agent network is created in the isolated gateway mode and the container drops NET_RAW", (t) => {
  const ctx = setup(t);
  const r = runWrapper(ctx, ISOLATED_INTERNAL);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.creates, [
    ["network", "create", "--internal", "-o", `${GATEWAY_MODE}=isolated`, "ag-probe"],
  ]);
  assert.deepEqual(r.state.networks["ag-probe"], {
    internal: true,
    gatewayMode: "isolated",
    gateway: null,
    members: ["hub"],
  });
  assert.ok(r.args, "docker run was not reached");
  const joined = r.args.join(" ");
  assert.match(joined, /--network ag-probe/);
  assert.match(joined, /--cap-drop NET_RAW/);
});

test("an internal network left by an earlier run without the gateway mode is recreated", (t) => {
  const ctx = setup(t, {
    "ag-probe": { internal: true, gatewayMode: "", gateway: "10.200.1.1", members: ["hub"] },
  });
  const r = runWrapper(ctx, ISOLATED_INTERNAL);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /gateway_mode=default, this run wants internal=true gateway_mode=isolated; recreating/);
  assert.equal(r.state.networks["ag-probe"].gatewayMode, "isolated");
  assert.equal(r.state.networks["ag-probe"].gateway, null);
  assert.deepEqual(r.state.networks["ag-probe"].members, ["hub"]);
});

test("an engine that does not honour the isolated gateway mode is an exit, not an agent with the host in reach", (t) => {
  const ctx = setup(t);
  const r = runWrapper(ctx, { ...ISOLATED_INTERNAL, ERIS_TEST_IGNORE_GW_MODE: "1" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /gateway_mode=default with host address 10\.200\.1\.1 after setup/);
  assert.match(r.stderr, /anvil on docker0 included/);
  assert.equal(r.args, null, "the agent container must not start");
});

test("open egress keeps docker's default gateway mode; every mode drops NET_RAW", (t) => {
  const open = setup(t);
  const r = runWrapper(open, { ERIS_AGENT_ISOLATE: "1", ERIS_AGENT_HUB: "hub" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.creates, [["network", "create", "ag-probe"]]);
  assert.match(r.args?.join(" ") ?? "", /--cap-drop NET_RAW/);
  const shared = setup(t);
  const s = runWrapper(shared, {});
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(s.state.creates, []);
  assert.match(s.args?.join(" ") ?? "", /--cap-drop NET_RAW/);
});
