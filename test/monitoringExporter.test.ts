// infra/monitoring/exporter/exporter.py is the only thing between the practice box and its alerts: the
// run's files, the chain and the containers become the metrics the Grafana rules read. These tests run
// the real script (python3) over a fabricated run directory, a fabricated cgroup tree and a fake
// JSON-RPC server, and read back the textfile node_exporter would serve -- because the failures that
// matter here (issue #157: a series nobody produces; issue #159: an event nobody counts) are
// properties of what the file contains, not of any helper.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPORTER = join(
  import.meta.dirname,
  "..",
  "infra",
  "monitoring",
  "exporter",
  "exporter.py",
);
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const hex = (n: number) => `0x${n.toString(16)}`;

/** A chain whose head moves on each `latest` read: `heads[i]` is the i-th answer. */
function fakeChain(
  timestamps: Record<number, number>,
  heads: number[],
): Promise<{ url: string; server: Server }> {
  let reads = 0;
  const block = (n: number) =>
    timestamps[n] === undefined
      ? null
      : {
          number: hex(n),
          timestamp: hex(timestamps[n]),
          gasUsed: "0x0",
          gasLimit: "0x1312d000",
          transactions: [],
        };
  const answer = (req: { id: unknown; method: string; params: unknown[] }) => {
    if (req.method === "eth_gasPrice")
      return { jsonrpc: "2.0", id: req.id, result: "0x0" };
    const tag = req.params[0] as string;
    const n =
      tag === "latest"
        ? heads[Math.min(reads++, heads.length - 1)]
        : Number(tag);
    return { jsonrpc: "2.0", id: req.id, result: block(n) };
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          Array.isArray(parsed) ? parsed.map(answer) : answer(parsed),
        ),
      );
    });
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      r({
        url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
        server,
      });
    }),
  );
}

// `/public/healthz` is the same dashboard as seen through the Cloudflare tunnel, which answers urllib's
// default User-Agent with 403 (and curl or a browser with 200).
function fakeDashboard(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const cloudflareRefuses =
      req.url === "/public/healthz" &&
      /^Python-urllib\//.test(req.headers["user-agent"] ?? "");
    res.statusCode =
      req.url === "/healthz" || req.url === "/public/healthz"
        ? cloudflareRefuses
          ? 403
          : 200
        : 404;
    res.end('{"ok":true}');
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      r({
        url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/healthz`,
        server,
      });
    }),
  );
}

const ANVIL_ID = "a".repeat(64);
const AGENT_ID = "b".repeat(64);

/** runs/<period>/<segment>/ plus a cgroup v2 tree and Docker's container metadata. */
function fixture(now: number): string {
  const root = mkdtempSync(join(tmpdir(), "eris-exporter-"));
  const period = join(root, "runs", "2026-09-27T06-36-22-082Z");
  const seg = join(period, "2026-09-28-s01");
  mkdirSync(join(seg, "agents"), { recursive: true });
  writeFileSync(join(period, "current-segment"), "2026-09-28-s01\n");
  const recent = now - 60;
  const old = now - 3600;
  const ev = (ts: number, type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ts: iso(ts), type, ...extra });
  writeFileSync(
    join(seg, "events.jsonl"),
    [
      ev(old, "run_started_realtime"),
      ev(old, "agents_registered", {
        agents: [{ id: "ops-canary" }, { id: "venue-arb" }],
      }),
      ev(old, "tx_submitted", { hash: "0x1" }),
      ev(recent, "tx_submitted", { hash: "0x2" }),
      ev(recent, "tx_submitted", { hash: "0x3" }),
      // an environment failure long ago, and two just now
      ev(old, "lst_reward_reserve_exhausted"),
      ev(recent, "interval_boundary_failed", { error: "x" }),
      ev(recent, "flow_process_exited", { code: 1 }),
      // per-order send failures are counted apart, not as environment failures
      ev(recent, "tx_submit_failed", { error: "nonce too low" }),
      ev(old, "tx_submit_failed", { error: "nonce too low" }),
      // a market warning is not a failure
      ev(recent, "no_arb_persistent_warning"),
      // a nested "type" inside the payload must not be read as the event's type
      ev(recent, "stress_schedule", {
        events: [{ type: "registration_failed" }],
      }),
      ev(recent, "agent_process_exited", { agentId: "a1", code: 137 }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(seg, "blocks.csv"),
    "round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,actionType,bundleId,bundleIndex,method,gasUsed,maxFeePerGasWei\n" +
      "90,90,0,0xa,0x1,0,success,oracle,system,,,,setPrice,1,\n" +
      "95,95,1,0xb,0x2,0,success,ops-canary,agent,swap,,,exactInputSingle,1,\n" +
      "97,97,1,0xc,0x2,0,reverted,ops-canary,agent,swap,,,exactInputSingle,1,\n" +
      "98,98,2,0xd,0x3,0,success,flow-uniswap:uninformed,uninformed-flow,swap,,,x,1,\n",
  );
  writeFileSync(
    join(seg, "agents", "venue-arb.jsonl"),
    '{"event":"submitted"}\n{"event":"submitted"}\n',
  );
  writeFileSync(join(seg, "intervals.jsonl"), '{"index":0}\n{"index":1}\n');

  const cg = join(root, "cgroup", "system.slice");
  const docker = join(root, "docker-containers");
  const container = (
    id: string,
    name: string,
    role: string | undefined,
    max: string,
  ) => {
    const d = join(cg, `docker-${id}.scope`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "memory.current"), "1000000\n");
    writeFileSync(
      join(d, "memory.stat"),
      "anon 700000\nfile 300000\ninactive_file 250000\nactive_file 50000\n",
    );
    writeFileSync(join(d, "memory.max"), `${max}\n`);
    writeFileSync(
      join(d, "cpu.stat"),
      "usage_usec 2500000\nuser_usec 2000000\n",
    );
    mkdirSync(join(docker, id), { recursive: true });
    writeFileSync(
      join(docker, id, "config.v2.json"),
      JSON.stringify({
        Name: `/${name}`,
        Config: { Labels: role ? { "eris.role": role } : {} },
      }),
    );
  };
  container(ANVIL_ID, "ascon-anvil", undefined, "max");
  container(AGENT_ID, "eris-agent-alice", "agent", "4294967296");
  // not a container scope: ignored
  mkdirSync(join(cg, "ssh.service"), { recursive: true });
  return root;
}

type Sample = { name: string; labels: Record<string, string>; value: number };

function parse(text: string): { samples: Sample[]; families: string[] } {
  const samples: Sample[] = [];
  const families: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("# TYPE ")) {
      families.push(line.split(" ")[2]);
      continue;
    }
    const m = /^([a-z_]+)\{([^}]*)\} (\S+)$/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const kv of m[2].matchAll(/([a-z_]+)="([^"]*)"/g))
      labels[kv[1]] = kv[2];
    samples.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return { samples, families };
}

function get(
  samples: Sample[],
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  return samples.find(
    (s) =>
      s.name === name &&
      Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  )?.value;
}

// The exporter runs as a child process while the fake servers answer it from this one.
async function runExporter(opts: {
  heads: number[];
  timestamps: Record<number, number>;
  loops: number;
  canaryIds?: string;
  publicDashboard?: boolean;
}) {
  const now = Math.floor(Date.now() / 1000);
  const root = fixture(now);
  const chain = await fakeChain(opts.timestamps, opts.heads);
  const dash = await fakeDashboard();
  try {
    const child = spawn("python3", [EXPORTER], {
      env: {
        ...process.env,
        ASCON_RUNS: join(root, "runs"),
        ASCON_RPC: chain.url,
        ASCON_TEXTFILE: join(root, "textfile", "ascon.prom"),
        ASCON_ENV: "live",
        ASCON_CGROUP_ROOT: join(root, "cgroup"),
        ASCON_DOCKER_CONTAINERS: join(root, "docker-containers"),
        ASCON_DASHBOARD_URL: dash.url,
        ...(opts.publicDashboard
          ? {
              ASCON_DASHBOARD_PUBLIC_URL: dash.url.replace(
                "/healthz",
                "/public/healthz",
              ),
            }
          : {}),
        ASCON_CANARY_IDS: opts.canaryIds ?? "ops-canary",
        ASCON_LOOPS: String(opts.loops),
        ASCON_LOOP_SEC: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    assert.equal(code, 0, stderr);
    return parse(readFileSync(join(root, "textfile", "ascon.prom"), "utf8"));
  } finally {
    chain.server.close();
    dash.server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const T0 = 1_800_000_000;
const steady: Record<number, number> = {};
for (let n = 80; n <= 120; n++) steady[n] = T0 + 2 * (n - 80);

test(
  "environment failures are counted by kind, with a recent-window gauge the alert reads (issue #159)",
  { skip: !hasPython },
  async () => {
    const { samples } = await runExporter({
      heads: [100],
      timestamps: steady,
      loops: 1,
    });
    // recent: inside the last 10 minutes by the event's own timestamp
    assert.equal(
      get(samples, "ascon_env_failures_recent", {
        type: "interval_boundary_failed",
      }),
      1,
    );
    assert.equal(
      get(samples, "ascon_env_failures_recent", {
        type: "flow_process_exited",
      }),
      1,
    );
    assert.equal(
      get(samples, "ascon_env_failures_recent", {
        type: "agent_process_exited",
      }),
      1,
    );
    // an hour old: still in the run's total, not in the window
    assert.equal(
      get(samples, "ascon_env_failures_total", {
        type: "lst_reward_reserve_exhausted",
      }),
      1,
    );
    assert.equal(
      get(samples, "ascon_env_failures_recent", {
        type: "lst_reward_reserve_exhausted",
      }),
      0,
    );
    // per-order send failures are their own series, never an environment failure
    assert.equal(
      get(samples, "ascon_env_failures_total", { type: "tx_submit_failed" }),
      undefined,
    );
    assert.equal(get(samples, "ascon_tx_submit_failed_total"), 2);
    assert.equal(get(samples, "ascon_tx_submit_failed_recent"), 1);
    // warnings and a payload's nested "type" are not failures
    assert.equal(
      get(samples, "ascon_env_failures_total", {
        type: "no_arb_persistent_warning",
      }),
      undefined,
    );
    assert.equal(
      get(samples, "ascon_env_failures_total", { type: "registration_failed" }),
      undefined,
    );
    // the flow's sends, all and recent
    assert.equal(get(samples, "ascon_flow_tx_total"), 3);
    assert.equal(get(samples, "ascon_flow_tx_recent"), 2);
    // what the exporter already reported stays as it was
    assert.equal(get(samples, "ascon_agent_crashes_total"), 1);
    assert.equal(get(samples, "ascon_agent_tx_total"), 2);
    assert.equal(get(samples, "ascon_interval_index"), 1);
  },
);

test(
  "container memory comes from the cgroup tree, named from Docker's metadata (issue #157)",
  { skip: !hasPython },
  async () => {
    const { samples } = await runExporter({
      heads: [100],
      timestamps: steady,
      loops: 1,
    });
    assert.equal(get(samples, "ascon_containers_observed"), 2);
    // working set = memory.current - inactive_file, cAdvisor's definition
    assert.equal(
      get(samples, "ascon_container_memory_working_set_bytes", {
        name: "ascon-anvil",
      }),
      750000,
    );
    // uncapped reads 0, which the OOM rule's `> 0` drops rather than divides by
    assert.equal(
      get(samples, "ascon_container_memory_limit_bytes", {
        name: "ascon-anvil",
      }),
      0,
    );
    assert.equal(
      get(samples, "ascon_container_memory_limit_bytes", {
        name: "eris-agent-alice",
        eris_role: "agent",
      }),
      4294967296,
    );
    assert.equal(
      get(samples, "ascon_container_cpu_seconds_total", {
        name: "eris-agent-alice",
      }),
      2.5,
    );
  },
);

test(
  "a registered canary's silence is measured from its last landed transaction (issue #159)",
  { skip: !hasPython },
  async () => {
    const { samples } = await runExporter({
      heads: [100],
      timestamps: steady,
      loops: 1,
      canaryIds: "ops-canary,ghost",
    });
    // block 95 landed, 97 reverted: the reverted one does not count as the canary working
    assert.equal(
      get(samples, "ascon_canary_seconds_since_tx", { agent: "ops-canary" }),
      steady[100] - steady[95],
    );
    // not registered in this period: no series, so a box without that canary does not page about it
    assert.equal(
      get(samples, "ascon_canary_seconds_since_tx", { agent: "ghost" }),
      undefined,
    );
  },
);

test(
  "every block interval since the last sample is measured, so a stall between samples still shows (issue #159)",
  { skip: !hasPython },
  async () => {
    const ts = { ...steady };
    // 100 -> 105 between two samples, with an 11 s stall at 103 and 2 s blocks around it
    ts[101] = ts[100] + 2;
    ts[102] = ts[101] + 2;
    ts[103] = ts[102] + 11;
    ts[104] = ts[103] + 2;
    ts[105] = ts[104] + 2;
    const { samples } = await runExporter({
      heads: [100, 105],
      timestamps: ts,
      loops: 2,
    });
    assert.equal(get(samples, "ascon_chain_block_number"), 105);
    assert.equal(
      get(samples, "ascon_block_interval_seconds"),
      2,
      "the newest interval, as before",
    );
    assert.equal(get(samples, "ascon_block_interval_max_seconds"), 11);
  },
);

test(
  "the textfile is one family per name and the dashboard is probed",
  { skip: !hasPython },
  async () => {
    const { samples, families } = await runExporter({
      heads: [100],
      timestamps: steady,
      loops: 1,
    });
    assert.equal(
      new Set(families).size,
      families.length,
      "a family appears once",
    );
    assert.equal(get(samples, "ascon_dashboard_up"), 1);
    assert.equal(
      get(samples, "ascon_dashboard_public_up"),
      undefined,
      "only when a public URL is set",
    );
    assert.ok(samples.every((s) => s.labels.env === "live"));
  },
);

test(
  "the public probe names itself, so the tunnel does not refuse it as a bot",
  { skip: !hasPython },
  async () => {
    const { samples } = await runExporter({
      heads: [100],
      timestamps: steady,
      loops: 1,
      publicDashboard: true,
    });
    assert.equal(get(samples, "ascon_dashboard_public_up"), 1);
  },
);
