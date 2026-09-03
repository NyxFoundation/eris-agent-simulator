# infra/monitoring — ASCON infra observability (Prometheus + Grafana + Loki)

The standard, reusable stack. Container + host metrics, RPC method-level latency, erigon-style chain
panels, live dashboards, spike/crash alerts to Slack **with rendered chart images**, and logs for crash
context. Implements the fleet-plane monitoring recommended in the ASCON `docs/22`.

## Services

| service | role | port |
|---|---|---|
| cadvisor | per-container CPU/mem/net (the `eris-*` agent containers) | 8081 |
| node-exporter | host CPU/mem/disk (+ textfile collector for ASCON & RPC metrics) | 9100 |
| prometheus | scrape + store + query | 9090 |
| grafana | dashboards + alerting → Slack (renders + uploads chart images) | 3000 |
| renderer | grafana-image-renderer (v5) — renders alert/dashboard panels to PNG | — |
| loki + promtail | logs from `~/ascon-logs`, RPC calls (`~/ascon-logs/rpc`), each run's `agents/*.jsonl` | 3100 |
| eris-exporter | ASCON domain + erigon-style chain metrics (tx / users / crashes / block / gas) | textfile |
| rpc-gateway-live | JSON-RPC proxy in front of anvil → per-method rate/latency/timeline (`infra/rpc-gateway`) | 8546 |

## Dashboards (folder **ASCON**)

- **ASCON infra fleet** (`fleet.json`) — container/host CPU & memory, agent count, crashes.
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
| Agent container near OOM | container mem > 90% of cap | cadvisor |
| Agent crashed | `increase(ascon_agent_crashes_total[2m]) > 0` (OOM=137 etc.) | eris-exporter (events.jsonl `agent_process_exited`) |
| Chain RPC down | `ascon_chain_up == 0` | eris-exporter (eth_blockNumber probe) |

**Chart images.** Grafana renders the alert's linked dashboard panel (via the renderer) and uploads
it to Slack using the bot token. This needs a recent Grafana: older versions fail — Slack retired the
classic `files.upload` (Grafana ≤11.5 → `method_deprecated`) and the renderer pairing 408-timed-out
(11.6). **Grafana 13.2.1 + renderer v5 works** (uses Slack's current `files.getUploadURLExternal`
upload; verified end-to-end). Requirements, all set here:
- `GF_UNIFIED_ALERTING_SCREENSHOTS_CAPTURE=true` (Grafana env)
- a non-default shared token on both sides: `GF_RENDERING_RENDERER_TOKEN` (grafana) + `AUTH_TOKEN`
  (renderer), same value, in `secret.env` — Grafana 13 refuses the default.

Crash alerts also point to Grafana Explore → Loki for the recent logs.

## eris-exporter (domain + chain metrics)

`exporter/exporter.py` reads the newest `runs/<id>/` (events.jsonl for flow tx + crashes + round
lag; each `agents/<id>.jsonl` for that agent's submissions; epochs.jsonl) and probes the chain RPC,
writing a Prometheus textfile that node-exporter serves (delivering via a shared file avoids scraping
this host-networked process across the host firewall; host networking is only needed so it can reach
anvil on 127.0.0.1). Every metric carries an `env="live|test"` label (`ASCON_ENV`). Metrics:
- domain: `ascon_tx_total`, `ascon_flow_tx_total`, `ascon_agent_tx_total`, `ascon_unique_users`,
  `ascon_agents_active`, `ascon_agent_crashes_total`, `ascon_round_lag`, `ascon_epoch_index`
- chain (erigon-style, straight off `eth_getBlockByNumber` / `eth_gasPrice`): `ascon_chain_up`,
  `ascon_chain_block_number`, `ascon_block_gas_used`, `ascon_block_gas_limit`,
  `ascon_block_fullness_ratio`, `ascon_block_tx_count`, `ascon_block_base_fee_gwei`,
  `ascon_gas_price_gwei`, `ascon_block_interval_seconds`

## rpc-gateway (RPC method-level observability)

`infra/rpc-gateway/gateway.mjs` fronts anvil on `:8546` (the tunnel origin for `ascon-rpc`), exporting
`rpc_requests_total`, `rpc_request_duration_seconds` (p50/p95/p99 per method), `rpc_batch_size`,
`rpc_in_flight`, `rpc_upstream_up` via the same textfile bridge, and one Loki line per call (with the
caller's Access `common_name`). See `infra/rpc-gateway/README.md`; load-test it with
`infra/rpc-gateway/loadtest.mjs`.

## Notes

- `cadvisor` uses host port 8081 (8080 is taken on gohanserver).
- Per-epoch stats (blocks/tx/tx-per-block/standings) are intentionally NOT pushed to Slack (too
  verbose); they live in the Grafana dashboard / Loki. Slack carries only spikes and faults.
- Thresholds are set for a 16-core / 187 GB host; adjust the rule params in
  `grafana/provisioning/alerting/rules.yml` for other hardware.
- `renderer` is pinned to `:latest` because the Go renderer (v5) publishes no semver tag; it must be
  v5+ to pair with Grafana 13.
