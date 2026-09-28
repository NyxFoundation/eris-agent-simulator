# infra/monitoring — ASCON infra observability (Prometheus + Grafana + Loki)

The standard, reusable stack. Container + host metrics, RPC method-level latency, erigon-style chain
panels, live dashboards, spike/crash alerts to Slack **with rendered chart images**, and logs for crash
context. Implements the fleet-plane monitoring recommended in the ASCON `docs/22`.

## Services

| service | role | port |
|---|---|---|
| cadvisor | per-container CPU/mem/net — **blind under Docker's containerd image store** (the practice box); nothing reads its container series any more, see [Container metrics](#container-metrics-issue-157) | 8081 |
| node-exporter | host CPU/mem/disk (+ textfile collector for ASCON & RPC metrics) | 9100 |
| prometheus | scrape + store + query | 9090 |
| grafana | dashboards + alerting → Slack (renders + uploads chart images) | 3000 |
| renderer | grafana-image-renderer (v5) — renders alert/dashboard panels to PNG | — |
| loki + promtail | logs from `~/ascon-logs`, RPC calls (`~/ascon-logs/rpc`), each run's `agents/*.jsonl` — at any depth, so a practice period's `runs/<period>/<segment>/agents/` too | 3100 |
| eris-exporter | ASCON domain + erigon-style chain metrics (tx / users / crashes / block / gas), container memory/CPU from the cgroup tree, the dashboard probe | textfile |
| rpc-gateway-live | JSON-RPC proxy in front of anvil → per-method rate/latency/timeline (`infra/rpc-gateway`) | 8546 |

## Dashboards (folder **ASCON**)

- **ASCON infra fleet** (`fleet.json`) — container/host CPU & memory, agent count, crashes, and the
  chain container's memory against the host's (what `ascon_anvil_mem_growth` projects).
- **ASCON — RPC & Chain** (`rpc.json`, uid `ascon-rpc`) — RPC request rate + p50/p95/p99 latency **per
  method**, errors, in-flight; erigon-style chain panels (block number, block interval, tx/block, gas
  used vs limit, fullness, base fee / gas price); and a Loki **RPC call timeline**. An `$env` selector
  switches between `live` and `test` (every metric carries an `env` label).

## Run

```bash
# one-time: gitignored secrets (Slack bot token, Grafana admin pw, renderer↔grafana shared token)
cat > grafana/secret.env <<EOF
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=<choose-one>
SLACK_BOT_TOKEN=$(grep -oE 'xox[a-z]-[A-Za-z0-9-]+' ~/.hermes/.env | head -1)
GF_RENDERING_RENDERER_TOKEN=<any-shared-secret>
AUTH_TOKEN=<same-shared-secret>
EOF

docker compose up -d                       # add: --profile test  to also start rpc-gateway-test
```

Grafana at `http://<host>:3000`. Do NOT expose these ports publicly — reach them via the Cloudflare
tunnel (`ascon-monitor.nyx.foundation`) / registered-users only, per the ASCON `docs/20`.

## Alerts (→ Slack `#notif-ascon-infra`, each with a chart image of the relevant panel)

| rule | condition | source |
|---|---|---|
| CPU load high | `node_load1 > cores` | node-exporter |
| Host memory high | host mem used > 85% | node-exporter |
| Agent container near OOM | capped agent container mem > 90% of cap | eris-exporter (cgroup, `eris.role=agent`) |
| Agent crashed | `increase(ascon_agent_crashes_total[2m]) > 0` (OOM=137 etc.) | eris-exporter (events.jsonl `agent_process_exited`) |
| Chain RPC down | `ascon_chain_up == 0` | eris-exporter (eth_blockNumber probe) |
| Devnet stalled | reachable but no new block in 10m | eris-exporter (`ascon_chain_block_number`) |
| Chain memory on course to fill the host within a week | `predict_linear` of `ascon-anvil`'s working set, 6 h slope, 7 days out > 80% of host | eris-exporter (cgroup) |
| Container memory not measured | `ascon-anvil` has no memory series for 10 m (the reader is broken — the two memory rules above would be green over nothing) | eris-exporter |
| Environment failure | any `*_failed` / `_stuck` / `_reverted` / `_incomplete` / `_exhausted` / `_capped`, `realtime_block_error`, `flow_process_exited` in the last 10 m (`agent_process_exited` is "Agent crashed") | eris-exporter (events.jsonl) |
| Flow orders failing to send | `tx_submit_failed` > 1% of the last 10 m's flow orders, and ≥ 5 | eris-exporter (events.jsonl) |
| Flow bot sent nothing | no flow order for 10 m while blocks are produced | eris-exporter (events.jsonl) |
| Canary silent | a registered canary (`ASCON_CANARY_IDS`, default `ops-canary`) has landed no tx for 1 h | eris-exporter (blocks.csv) |
| Block-production stalls growing | longest interval of the last hour − the same 6 h earlier > 2 s | eris-exporter (every block's timestamp) |
| RPC gateway cannot reach the chain | `rpc_upstream_up` 0 while anvil answers on loopback | rpc-gateway |
| RPC gateway refusing keys | > 200 `rpc_key_denied_total` in 10 m | rpc-gateway |
| Dashboard not answering / unreachable from outside | `/healthz` on :5174, and (with `ASCON_DASHBOARD_PUBLIC_URL`) through the tunnel | eris-exporter |

**A rule that reads nothing is green.** Every rule here has `noDataState: OK` except `Chain RPC down`,
so an empty query cannot page — which is how both memory rules watched nothing through the whole
26-hour rehearsal (issue #157). A new rule gets checked once by running its query in Grafana Explore
and seeing a series come back (infra/devnet/CHECKLIST.md 1.3), and a rule whose input can silently
disappear gets a companion that alerts on the absence (`Container memory not measured`).

**Why the routine rules read `*_recent` gauges and not `increase()`.** A counter series that first
appears with a non-zero value — the first failure of its kind, or one already in the file when the
exporter restarts — has no earlier sample, so `increase()` reads 0 and the alert stays silent for
exactly the event it exists for. The exporter counts events whose own timestamp is in the last 10
minutes instead (`ASCON_RECENT_WINDOW_SEC`).

**Chart images.** Grafana renders the alert's linked dashboard panel (via the renderer) and uploads
it to Slack using the bot token. This needs a recent Grafana: older versions fail — Slack retired the
classic `files.upload` (Grafana ≤11.5 → `method_deprecated`) and the renderer pairing 408-timed-out
(11.6). **Grafana 13.2.1 + renderer v5 works** (uses Slack's current `files.getUploadURLExternal`
upload; verified end-to-end). Requirements, all set here:
- `GF_UNIFIED_ALERTING_SCREENSHOTS_CAPTURE=true` (Grafana env)
- a non-default shared token on both sides: `GF_RENDERING_RENDERER_TOKEN` (grafana) + `AUTH_TOKEN`
  (renderer), same value, in `secret.env` — Grafana 13 refuses the default.

Crash alerts also point to Grafana Explore → Loki for the recent logs.

**Why "devnet stalled" is a separate rule from "chain RPC down".** anvil answers `eth_blockNumber`
forever with nobody driving it, so a dead coordinator leaves `ascon_chain_up` at 1 while the market
is frozen — the fault the operator actually cares about is invisible to the liveness probe. The rule
watches the block number instead, guarded on `ascon_chain_up == 1` so a genuinely dead node pages
once rather than twice. The unit it names is `ascon-devnet.service` (`infra/devnet`).

## eris-exporter (domain + chain metrics)

`exporter/exporter.py` reads the newest `runs/<id>/` -- for a practice period, the segment its
`current-segment` names, since the period directory itself holds none of these files -- (events.jsonl
for flow tx + crashes + round lag; each `agents/<id>.jsonl` for that agent's submissions;
intervals.jsonl, or epochs.jsonl from a coordinator started before issue #140) and probes the chain RPC,
writing a Prometheus textfile that node-exporter serves (delivering via a shared file avoids scraping
this host-networked process across the host firewall; host networking is only needed so it can reach
anvil on 127.0.0.1). Every metric carries an `env="live|test"` label (`ASCON_ENV`). Metrics:
- domain: `ascon_tx_total`, `ascon_flow_tx_total`, `ascon_agent_tx_total`, `ascon_unique_users`,
  `ascon_agents_active`, `ascon_agent_crashes_total`, `ascon_round_lag`, `ascon_interval_index`
  (also exported as `ascon_epoch_index`, its name before issue #140, until the results are published)
- chain (erigon-style, straight off `eth_getBlockByNumber` / `eth_gasPrice`): `ascon_chain_up`,
  `ascon_chain_block_number`, `ascon_block_gas_used`, `ascon_block_gas_limit`,
  `ascon_block_fullness_ratio`, `ascon_block_tx_count`, `ascon_block_base_fee_gwei`,
  `ascon_gas_price_gwei`, `ascon_block_interval_seconds` (the newest block's), and
  `ascon_block_interval_max_seconds` — the longest interval among **every** block mined in the last
  minute. The exporter reads the timestamps of the blocks it missed between two loops, so a dump stall
  of a few seconds no longer falls between two samples (issue #159)
- routine checks (issue #159): `ascon_env_failures_total{type}` / `ascon_env_failures_recent{type}`,
  `ascon_tx_submit_failed_total` / `_recent`, `ascon_flow_tx_recent`,
  `ascon_canary_seconds_since_tx{agent}` (a registered canary's time since its last landed tx),
  `ascon_dashboard_up` / `ascon_dashboard_public_up`
- containers (issue #157): `ascon_container_memory_working_set_bytes{name,eris_role}`,
  `ascon_container_memory_limit_bytes`, `ascon_container_cpu_seconds_total`, `ascon_containers_observed`

Files are read incrementally — an offset per file, restarted when the file is replaced — rather than
the whole of `events.jsonl` every 10 s (a practice day writes ~60 MB of it).

### Container metrics (issue #157)

cAdvisor v0.49.1 exports **no per-container series** on the practice box: it runs Docker 29 with the
containerd image store, and cAdvisor looks for each container's read-write layer under
`/var/lib/docker/image/<driver>/layerdb`, which that store does not write (`failed to identify the
read-write layer ID`, logged for every container). Every `container_*` series was a systemd cgroup
with no `name`, and the rules reading `name="ascon-anvil"` / `container_label_eris_role="agent"`
evaluated to no data — OK.

eris-exporter reads the numbers itself, from two read-only mounts that do not depend on how images
are stored: the host's cgroup v2 tree (`/sys/fs/cgroup` → `memory.current`, `memory.stat`
`inactive_file`, `memory.max`, `cpu.stat`, under `system.slice/docker-<id>.scope` or `docker/<id>`)
and Docker's per-container metadata (`/var/lib/docker/containers/<id>/config.v2.json` → the name and
the `eris.role` label). Working set is cAdvisor's definition, `memory.current − inactive_file`. Not the
Docker socket: that would hand a host-networked Python process the daemon.

## rpc-gateway (RPC method-level observability)

`infra/rpc-gateway/gateway.mjs` fronts anvil on `:8546` (the tunnel origin for `ascon-rpc`), exporting
`rpc_requests_total`, `rpc_request_duration_seconds` (p50/p95/p99 per method), `rpc_batch_size`,
`rpc_in_flight`, `rpc_upstream_up` via the same textfile bridge, and one Loki line per call (with the
caller's Access `common_name`). See `infra/rpc-gateway/README.md`; load-test it with
`infra/rpc-gateway/loadtest.mjs`.

## Notes

- `cadvisor` uses host port 8081 (8080 is taken on gohanserver).
- **Agent series are selected by the `eris.role=agent` label (`eris_role="agent"` on the exporter's
  series, `container_label_eris_role` on cAdvisor's), never by the `eris-` name prefix.** The prefix also matches `eris-explorer-*`, the local Blockscout stack, which runs
  uncapped — and cadvisor reports `container_spec_memory_limit_bytes=0` for an uncapped container,
  so `working_set / limit` is `+Inf` and the OOM rule fired permanently against five containers that
  are not agents. The fleet panels had the same collision and were charting the explorer as the
  agent fleet. `run-agent.sh` and the sweepers already matched on the label; the dashboards and the
  rule did not.
- Per-interval stats (blocks/tx/tx-per-block/standings) are intentionally NOT pushed to Slack (too
  verbose); they live in the Grafana dashboard / Loki. Slack carries only spikes and faults.
- Thresholds are set for a 16-core / 187 GB host; adjust the rule params in
  `grafana/provisioning/alerting/rules.yml` for other hardware.
- `renderer` is pinned to `:latest` because the Go renderer (v5) publishes no semver tag; it must be
  v5+ to pair with Grafana 13.
