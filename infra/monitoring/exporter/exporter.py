#!/usr/bin/env python3
"""ASCON domain exporter -> Prometheus. Turns the run's files, the chain RPC, the host's container
cgroups and the dashboard into metrics, so the same Grafana/alerting stack that handles host CPU and
memory also handles ASCON-specific and chain signals. Every metric carries env="live|test".

  run      ascon_tx_total, ascon_flow_tx_total, ascon_agent_tx_total, ascon_unique_users,
           ascon_agents_active, ascon_agent_crashes_total, ascon_round_lag, ascon_interval_index
           (ascon_epoch_index, its name before issue #140)
           ascon_env_failures_total{type} / ascon_env_failures_recent{type}      (issue #159)
           ascon_tx_submit_failed_total / _recent, ascon_flow_tx_recent          (issue #159)
           ascon_canary_seconds_since_tx{agent}                                  (issue #159)
  chain    ascon_chain_up, ascon_chain_block_number, and erigon-style per block:
           ascon_block_gas_used/limit/fullness_ratio, ascon_block_tx_count, ascon_block_base_fee_gwei,
           ascon_gas_price_gwei, ascon_block_interval_seconds,
           ascon_block_interval_max_seconds                                      (issue #159)
  host     ascon_container_memory_working_set_bytes{name,eris_role},
           ascon_container_memory_limit_bytes{...}, ascon_container_cpu_seconds_total{...},
           ascon_containers_observed                                             (issue #157)
  web      ascon_dashboard_up, ascon_dashboard_public_up                         (issue #159)

`*_recent` counts the events whose own timestamp is inside the last ASCON_RECENT_WINDOW_SEC (600).
The alerts read those rather than `increase()` of a counter: a series that first appears with a
non-zero value -- the first failure of its kind, or anything already in the file when the exporter
restarts -- has no earlier sample to increase from, so `increase()` reads 0 and the alert stays
silent for exactly the event it exists for.

Files are read incrementally (an offset per file, restarted when the file is replaced). The whole of
events.jsonl used to be re-read every 10 s, and a practice day writes ~60 MB of it.

Written every ~10 s as a Prometheus textfile that node_exporter serves. ASCON_LOOPS=<n> writes it n
times and exits, ASCON_LOOP_SEC sets the pause (test/monitoringExporter.test.ts)."""
import bisect, glob, json, os, re, time, urllib.request
from collections import deque
from datetime import datetime

RUNS = os.environ.get("ASCON_RUNS", "/runs")
RPC = os.environ.get("ASCON_RPC", "http://127.0.0.1:8545")
TEXTFILE = os.environ.get("ASCON_TEXTFILE", "/textfile/ascon.prom")
ENV = os.environ.get("ASCON_ENV", "live")
# The host's cgroup v2 tree and Docker's per-container metadata, both mounted read-only (issue #157).
CGROUP_ROOT = os.environ.get("ASCON_CGROUP_ROOT", "/host/cgroup")
DOCKER_CONTAINERS = os.environ.get("ASCON_DOCKER_CONTAINERS", "/host/docker-containers")
DASHBOARD_URL = os.environ.get("ASCON_DASHBOARD_URL", "http://127.0.0.1:5174/healthz")
DASHBOARD_PUBLIC_URL = os.environ.get("ASCON_DASHBOARD_PUBLIC_URL", "")
PROBE_USER_AGENT = "ascon-exporter/1 (uptime probe)"
CANARY_IDS = [s.strip() for s in os.environ.get("ASCON_CANARY_IDS", "ops-canary").split(",") if s.strip()]
RECENT_SEC = int(os.environ.get("ASCON_RECENT_WINDOW_SEC", "600"))
# How long an interval stays in ascon_block_interval_max_seconds after the block that closed it.
# Several scrapes long, so every stall is in at least one sample whatever the phase between them.
INTERVAL_HOLD_SEC = 60
LOOP_SEC = float(os.environ.get("ASCON_LOOP_SEC", "10"))
# Per file per loop: a day of events.jsonl is taken in a few loops after a restart, not in one.
MAX_READ = 64 * 1024 * 1024

# CHECKLIST.md's `envfail`: an environment function that did not do its job. tx_submit_failed matches
# the pattern but is one flow order that failed to send (issue #148: 1 in 358,970 over 22 h), so it is
# kept apart and alerted on as a rate.
ENV_FAILURE = re.compile(
    r"(_failed|_stuck|_reverted|_incomplete|_exhausted|_capped)$"
    r"|^(realtime_block_error|agent_process_exited|flow_process_exited)$")
SEND_FAILURE = "tx_submit_failed"
TYPE_RE = re.compile(r'"type":"([a-z0-9_]+)"')
TS_RE = re.compile(r'"ts":"([^"]+)"')
CONTAINER_ID = re.compile(r"[0-9a-f]{64}")


def parse_ts(line):
    m = TS_RE.search(line)
    if not m:
        return None
    try:
        return datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class Tail:
    """What was appended to a file since the last call; starts over when the file is replaced."""

    def __init__(self):
        self.path = self.ino = None
        self.off = 0
        self.buf = b""

    def read(self, path):
        """-> (complete new lines, whether this is a different file than last time)."""
        try:
            st = os.stat(path)
        except OSError:
            return [], False
        fresh = path != self.path or st.st_ino != self.ino or st.st_size < self.off
        if fresh:
            self.path, self.ino, self.off, self.buf = path, st.st_ino, 0, b""
        if st.st_size <= self.off:
            return [], fresh
        with open(path, "rb") as f:
            f.seek(self.off)
            chunk = f.read(MAX_READ)
        self.off += len(chunk)
        parts = (self.buf + chunk).split(b"\n")
        self.buf = parts.pop()
        return [p.decode("utf-8", "replace") for p in parts if p], fresh


class Recent:
    """Timestamps of events inside the trailing window, per key. Kept sorted rather than assumed
    sorted: lines written from concurrent tasks are not strictly in timestamp order."""

    def __init__(self):
        self.q = {}

    def add(self, key, ts):
        if ts >= time.time() - RECENT_SEC:
            bisect.insort(self.q.setdefault(key, []), ts)

    def counts(self, now):
        out = {}
        for key, q in self.q.items():
            k = bisect.bisect_left(q, now - RECENT_SEC)
            if k:
                del q[:k]
            out[key] = len(q)
        return out


def latest_run():
    ds = glob.glob(RUNS + "/*/")
    if not ds:
        return None
    run = max(ds, key=os.path.getmtime).rstrip("/")
    # A practice period (ADR 0021 §6) writes runs/<competition>/<segment>/ and names the segment
    # being written in <competition>/current-segment. The competition directory itself holds no
    # events.jsonl, so reading it reported 0 tx, 0 agents and interval -1 for the whole period.
    marker = os.path.join(run, "current-segment")
    if os.path.exists(marker):
        try:
            seg = os.path.join(run, os.path.basename(open(marker).read().strip()))
            if os.path.isdir(seg):
                return seg
        except Exception:
            pass
        segs = [d.rstrip("/") for d in glob.glob(run + "/*/")]
        if segs:
            return max(segs, key=os.path.getmtime)
    return run


def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=3).read())["result"]


def block_timestamps(numbers):
    """{block number: unix timestamp}, in one batch request."""
    if not numbers:
        return {}
    body = [{"jsonrpc": "2.0", "id": n, "method": "eth_getBlockByNumber", "params": [hex(n), False]}
            for n in numbers]
    req = urllib.request.Request(RPC, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    replies = json.loads(urllib.request.urlopen(req, timeout=5).read())
    return {int(r["id"]): int(r["result"]["timestamp"], 16)
            for r in (replies if isinstance(replies, list) else [replies]) if r.get("result")}


class Exporter:
    def __init__(self):
        self.run = None
        self.events = Tail()
        self.blocks = Tail()
        self.recent = Recent()        # env failures by type, tx_submit_failed, flow_tx
        self.failure_types = set()    # every kind seen since start, so its series stays, at 0
        self.registered = set()
        self.canary_last = {}         # canary id -> last block holding a successful tx of its own
        self.first_block = None       # the earliest block the blocks.csv files read so far cover
        self.last_block = None        # the newest block whose interval has been measured
        self.last_block_ts = None
        self.newest_interval = None
        self.intervals = deque()      # (seen at, seconds) behind ascon_block_interval_max_seconds
        self.ts_cache = {}
        self.reset_run()

    def reset_run(self):
        # Per-run counts: what the run in progress has done, as before. A new segment starts again at
        # 0, which Prometheus reads as a counter reset.
        self.flow_tx = self.crashes = self.lag = self.send_failures = 0
        self.failures = {}
        self.agents = {}
        self.agent_tails = {}

    # ---- run files ----------------------------------------------------------------------------

    def read_events(self, run):
        lines, fresh = self.events.read(os.path.join(run, "events.jsonl"))
        if fresh:
            self.reset_run()
        for ln in lines:
            m = TYPE_RE.search(ln)
            if not m:
                continue
            t = m.group(1)
            if t == "tx_submitted":
                self.flow_tx += 1
                ts = parse_ts(ln)
                if ts is not None:
                    self.recent.add("flow_tx", ts)
            elif t == "round_timing":
                try:
                    self.lag += max(0, json.loads(ln).get("blocksCaughtUp", 0) - 1)
                except Exception:
                    pass
            elif t == "agents_registered":
                try:
                    self.registered = {a["id"] for a in json.loads(ln).get("agents", [])}
                except Exception:
                    pass
            elif t == SEND_FAILURE:
                self.send_failures += 1
                ts = parse_ts(ln)
                if ts is not None:
                    self.recent.add(SEND_FAILURE, ts)
            elif ENV_FAILURE.search(t):
                if t == "agent_process_exited":
                    self.crashes += 1
                self.failures[t] = self.failures.get(t, 0) + 1
                self.failure_types.add(t)
                ts = parse_ts(ln)
                if ts is not None:
                    self.recent.add(("env", t), ts)

    def read_agents(self, run):
        """Each operator-run agent's own submissions (agents/<id>.jsonl)."""
        for af in glob.glob(os.path.join(run, "agents", "*.jsonl")):
            if af.endswith(".llm.jsonl"):
                continue
            lines, _ = self.agent_tails.setdefault(af, Tail()).read(af)
            n = sum(1 for ln in lines if '"event":"submitted"' in ln)
            if n:
                aid = os.path.basename(af)[:-6]   # strip .jsonl
                self.agents[aid] = self.agents.get(aid, 0) + n

    def read_blocks(self, run):
        """blocks.csv: round,blockNumber,txIndex,hash,from,priorityFeeWei,status,ownerId,role,..."""
        lines, _ = self.blocks.read(os.path.join(run, "blocks.csv"))
        for ln in lines:
            cols = ln.split(",")
            if len(cols) < 9 or not cols[1].isdigit():
                continue          # the header
            bn = int(cols[1])
            if self.first_block is None or bn < self.first_block:
                self.first_block = bn
            if cols[6] == "success" and cols[8] == "agent" and cols[7] in CANARY_IDS:
                if bn > self.canary_last.get(cols[7], -1):
                    self.canary_last[cols[7]] = bn

    @staticmethod
    def interval_index(run):
        # intervals.jsonl since issue #140; a coordinator started before it still writes epochs.jsonl.
        ep = os.path.join(run, "intervals.jsonl")
        if not os.path.exists(ep):
            ep = os.path.join(run, "epochs.jsonl")
        interval = -1
        if os.path.exists(ep):
            with open(ep) as f:
                for ln in f:
                    if ln.strip():
                        try:
                            interval = json.loads(ln)["index"]
                        except Exception:
                            pass
        return interval

    # ---- chain --------------------------------------------------------------------------------

    def chain(self, now):
        """erigon-style block view straight off the RPC (anvil exposes no metrics itself)."""
        out = {"ascon_chain_up": 0, "ascon_chain_block_number": 0}
        try:
            blk = rpc("eth_getBlockByNumber", ["latest", False])
        except Exception:
            return out, None
        out["ascon_chain_up"] = 1
        bn = int(blk["number"], 16)
        ts = int(blk["timestamp"], 16)
        out["ascon_chain_block_number"] = bn
        gas_used = int(blk["gasUsed"], 16)
        gas_limit = int(blk["gasLimit"], 16)
        out["ascon_block_gas_used"] = gas_used
        out["ascon_block_gas_limit"] = gas_limit
        out["ascon_block_fullness_ratio"] = round(gas_used / gas_limit, 4) if gas_limit else 0
        out["ascon_block_tx_count"] = len(blk.get("transactions", []))
        if blk.get("baseFeePerGas"):
            out["ascon_block_base_fee_gwei"] = round(int(blk["baseFeePerGas"], 16) / 1e9, 4)
        try:
            out["ascon_gas_price_gwei"] = round(int(rpc("eth_gasPrice", []), 16) / 1e9, 4)
        except Exception:
            pass
        try:
            self.measure_intervals(bn, ts, now)
        except Exception:
            pass
        if self.newest_interval is not None:
            out["ascon_block_interval_seconds"] = self.newest_interval
        if self.intervals:
            out["ascon_block_interval_max_seconds"] = max(g for _, g in self.intervals)
        return out, (bn, ts)

    def measure_intervals(self, bn, ts, now):
        """Every interval since the last loop, not only the newest block's (issue #159). A dump stall
        of a few seconds used to fall between two 10 s samples of the newest interval and never show."""
        if self.last_block is not None and bn < self.last_block:
            # The chain was reset under us: block numbers mean different blocks now.
            self.canary_last.clear()
            self.first_block = None
            self.ts_cache.clear()
        if self.last_block is None or bn < self.last_block or bn - self.last_block > 300:
            # first loop, a reset, or too far behind to catch up: measure the head only
            prev = block_timestamps([bn - 1]).get(bn - 1) if bn > 0 else None
            if prev is not None:
                self.newest_interval = max(0, ts - prev)
                self.intervals.append((now, self.newest_interval))
        elif bn > self.last_block:
            stamps = block_timestamps(list(range(self.last_block + 1, bn)))
            stamps[self.last_block] = self.last_block_ts
            stamps[bn] = ts
            for n in range(self.last_block + 1, bn + 1):
                if n in stamps and n - 1 in stamps:
                    self.newest_interval = max(0, stamps[n] - stamps[n - 1])
                    self.intervals.append((now, self.newest_interval))
        self.last_block, self.last_block_ts = bn, ts
        while self.intervals and self.intervals[0][0] < now - INTERVAL_HOLD_SEC:
            self.intervals.popleft()

    def block_ts(self, n):
        if n not in self.ts_cache:
            if len(self.ts_cache) > 64:
                self.ts_cache.clear()
            self.ts_cache.update(block_timestamps([n]))
        return self.ts_cache.get(n)

    # ---- containers (issue #157) --------------------------------------------------------------

    def containers(self):
        """Memory and CPU of every Docker container, read from the host's cgroup v2 tree.

        cAdvisor v0.49 cannot identify a container under Docker's containerd image store -- it looks
        for the read-write layer under image/<driver>/layerdb, which that store does not write -- and
        drops it. No series carried a `name`, so both memory alerts evaluated to no data, which they
        treat as OK. The cgroup files and Docker's own container metadata do not depend on how the
        images are stored."""
        seen = []
        for pattern in ("system.slice/docker-*.scope", "docker/*"):   # systemd / cgroupfs driver
            for d in glob.glob(os.path.join(CGROUP_ROOT, pattern)):
                base = os.path.basename(d)
                cid = base[len("docker-"):-len(".scope")] if base.startswith("docker-") else base
                if not CONTAINER_ID.fullmatch(cid):
                    continue
                try:
                    current = int(open(os.path.join(d, "memory.current")).read())
                except Exception:
                    continue
                try:
                    with open(os.path.join(DOCKER_CONTAINERS, cid, "config.v2.json")) as f:
                        cfg = json.load(f)
                    name = cfg.get("Name", "").lstrip("/") or cid[:12]
                    role = ((cfg.get("Config") or {}).get("Labels") or {}).get("eris.role", "")
                except Exception:
                    name, role = cid[:12], ""
                stat = self.kv(os.path.join(d, "memory.stat"))
                try:
                    raw = open(os.path.join(d, "memory.max")).read().strip()
                    limit = 0 if raw == "max" else int(raw)
                except Exception:
                    limit = 0
                usage = self.kv(os.path.join(d, "cpu.stat")).get("usage_usec")
                seen.append({
                    "name": name, "eris_role": role,
                    # cAdvisor's working set: usage less what the kernel reclaims first.
                    "working_set": max(0, current - stat.get("inactive_file", 0)),
                    "limit": limit,
                    "cpu": usage / 1e6 if usage is not None else None,
                })
        return seen

    @staticmethod
    def kv(path):
        out = {}
        try:
            for ln in open(path):
                k, _, v = ln.partition(" ")
                if v.strip().isdigit():
                    out[k] = int(v)
        except Exception:
            pass
        return out

    # ---- the web side -------------------------------------------------------------------------

    @staticmethod
    def probe(url):
        # Named, because Cloudflare answers urllib's default User-Agent (Python-urllib/3.x) with 403
        # while curl and browsers get 200: through the tunnel the unnamed probe read a live
        # dashboard as down.
        req = urllib.request.Request(url, headers={"User-Agent": PROBE_USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return 1 if r.status == 200 else 0
        except Exception:
            return 0

    # ---- one sample ---------------------------------------------------------------------------

    def collect(self):
        """-> [(name, labels, value, type)]"""
        now = time.time()
        run = latest_run()
        if run != self.run:
            self.run = run
            self.events, self.blocks = Tail(), Tail()
            self.reset_run()
        interval = -1
        if run:
            self.read_events(run)
            self.read_agents(run)
            self.read_blocks(run)
            interval = self.interval_index(run)
        agent_tx = sum(self.agents.values())
        m = [
            ("ascon_tx_total", {}, self.flow_tx + agent_tx, "gauge"),
            ("ascon_flow_tx_total", {}, self.flow_tx, "gauge"),
            ("ascon_agent_tx_total", {}, agent_tx, "gauge"),
            ("ascon_unique_users", {}, len(self.agents), "gauge"),
            ("ascon_agents_active", {}, len(self.agents), "gauge"),
            ("ascon_agent_crashes_total", {}, self.crashes, "gauge"),
            ("ascon_round_lag", {}, self.lag, "gauge"),
            ("ascon_interval_index", {}, interval, "gauge"),
            # The same number under its old name, for panels built before issue #140.
            ("ascon_epoch_index", {}, interval, "gauge"),
        ]

        recent = self.recent.counts(now)
        for t in sorted(self.failure_types):
            m.append(("ascon_env_failures_total", {"type": t}, self.failures.get(t, 0), "counter"))
            m.append(("ascon_env_failures_recent", {"type": t}, recent.get(("env", t), 0), "gauge"))
        m.append(("ascon_tx_submit_failed_total", {}, self.send_failures, "counter"))
        m.append(("ascon_tx_submit_failed_recent", {}, recent.get(SEND_FAILURE, 0), "gauge"))
        m.append(("ascon_flow_tx_recent", {}, recent.get("flow_tx", 0), "gauge"))

        chain, head = self.chain(now)
        m += [(k, {}, v, "gauge") for k, v in chain.items()]

        # A registered canary's time since it last landed a transaction -- or, none seen since this
        # exporter started, since the first block it has read, a lower bound that can only alert late,
        # never early. Absent until the canary is registered, so a box without one does not page.
        if head:
            for cid in CANARY_IDS:
                if cid not in self.registered:
                    continue
                since = self.canary_last.get(cid, self.first_block)
                if since is None:
                    continue
                try:
                    since_ts = self.block_ts(since)
                except Exception:
                    since_ts = None
                if since_ts is not None:
                    m.append(("ascon_canary_seconds_since_tx", {"agent": cid},
                              max(0, head[1] - since_ts), "gauge"))

        try:
            cs = self.containers()
        except Exception:
            cs = []
        m.append(("ascon_containers_observed", {}, len(cs), "gauge"))
        for c in cs:
            labels = {"name": c["name"], "eris_role": c["eris_role"]}
            m.append(("ascon_container_memory_working_set_bytes", labels, c["working_set"], "gauge"))
            m.append(("ascon_container_memory_limit_bytes", labels, c["limit"], "gauge"))
            if c["cpu"] is not None:
                m.append(("ascon_container_cpu_seconds_total", labels, c["cpu"], "counter"))

        m.append(("ascon_dashboard_up", {}, self.probe(DASHBOARD_URL), "gauge"))
        if DASHBOARD_PUBLIC_URL:
            m.append(("ascon_dashboard_public_up", {}, self.probe(DASHBOARD_PUBLIC_URL), "gauge"))
        return m


def fmt_labels(labels):
    parts = [f'env="{ENV}"'] + [
        '%s="%s"' % (k, str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " "))
        for k, v in labels.items()]
    return "{" + ",".join(parts) + "}"


def write_textfile(exporter):
    """Atomically write the Prometheus textfile that node_exporter's textfile collector serves.
    (Delivering via a shared file avoids scraping this host-networked process across the host
    firewall; host networking is only needed so it can reach anvil on 127.0.0.1.)"""
    # Grouped by name: the text format wants a family's samples together, and node_exporter drops
    # the whole file when a family appears twice -- collect() interleaves them (per type, per container).
    families = {}
    for name, labels, value, kind in exporter.collect():
        families.setdefault(name, (kind, []))[1].append(f"{name}{fmt_labels(labels)} {value}")
    lines = []
    for name, (kind, samples) in families.items():
        lines.append(f"# TYPE {name} {kind}")
        lines += samples
    tmp = TEXTFILE + ".tmp"
    os.makedirs(os.path.dirname(TEXTFILE) or ".", exist_ok=True)
    with open(tmp, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, TEXTFILE)


if __name__ == "__main__":
    ex = Exporter()
    loops = int(os.environ.get("ASCON_LOOPS", "0"))   # 0 = forever
    print("ascon exporter env=%s -> %s (runs=%s rpc=%s cgroup=%s)"
          % (ENV, TEXTFILE, RUNS, RPC, CGROUP_ROOT), flush=True)
    done = 0
    while True:
        try:
            write_textfile(ex)
        except Exception as e:
            print("write error:", e, flush=True)
        done += 1
        if loops and done >= loops:
            break
        time.sleep(LOOP_SEC)
