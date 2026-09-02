# infra/monitoring — ASCON infra observability (Prometheus + Grafana + Loki)

The standard, reusable stack instead of a bespoke script. Container + host metrics, live dashboards,
spike/crash alerts to Slack **with rendered chart images**, and logs for crash context. This is the
implementation of the fleet-plane monitoring recommended in `../../docs/22` (ASCON docs) / the eris
side of it.

## Services

| service | role | port |
|---|---|---|
| cadvisor | per-container CPU/mem/net (the `eris-*` agent containers) | 8081 |
| node-exporter | host CPU/mem/disk (+ textfile collector for ASCON metrics) | 9100 |
| prometheus | scrape + store + query | 9090 |
| grafana (+ renderer) | dashboards + alerting → Slack (uploads chart images) | 3000 |
| loki + promtail | logs from `~/ascon-bench/logs` and each run's `agents/*.jsonl` | 3100 |
| eris-exporter | ASCON domain metrics (tx / unique users / crashes / chain / epoch) | textfile |

## Run

```bash
# one-time: create the gitignored secret file (Slack bot token + Grafana admin password)
cat > grafana/secret.env <<EOF
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=<choose-one>
SLACK_BOT_TOKEN=$(grep -oE 'xox[a-z]-[A-Za-z0-9-]+' ~/.hermes/.env | head -1)
EOF

docker compose up -d
```

Grafana at `http://<host>:3000` (dashboard **ASCON infra fleet**). Do NOT expose these ports
publicly — reach them via the Cloudflare tunnel / registered-users only, per `../../docs/20`.

## Alerts (→ Slack `#notif-ascon-infra`, with a chart image of the relevant panel)

| rule | condition | source |
|---|---|---|
| CPU load high | `node_load1 > cores` | node-exporter |
| Host memory high | host mem used > 85% | node-exporter |
| Agent container near OOM | container mem > 90% of cap | cadvisor |
| Agent crashed | `increase(ascon_agent_crashes_total[2m]) > 0` (OOM=137 etc.) | eris-exporter (events.jsonl `agent_process_exited`) |
| Chain RPC down | `ascon_chain_up == 0` | eris-exporter (eth_blockNumber probe) |

Grafana renders the alert's linked dashboard panel and uploads it to Slack via the bot token
(`GF_UNIFIED_ALERTING_SCREENSHOTS_CAPTURE=true` + the image-renderer container). Crash alerts point
to Grafana Explore → Loki for the recent logs.

## eris-exporter (domain metrics)

`exporter/exporter.py` reads the newest `runs/<id>/` and the chain RPC, writing a Prometheus
textfile that node-exporter serves (delivering via a shared file avoids scraping this host-networked
process across the host firewall; host networking is only needed so it can reach anvil on
127.0.0.1). Metrics: `ascon_tx_total`, `ascon_flow_tx_total`, `ascon_agent_tx_total`,
`ascon_unique_users`, `ascon_agents_active`, `ascon_agent_crashes_total`, `ascon_round_lag`,
`ascon_epoch_index`, `ascon_chain_up`, `ascon_chain_block_number`.

## Notes

- `cadvisor` uses host port 8081 (8080 is taken on gohanserver).
- Per-epoch stats (blocks/tx/tx-per-block/standings) are intentionally NOT pushed to Slack (too
  verbose); they live in the Grafana dashboard / Loki. Slack carries only spikes and faults.
- Thresholds are set for a 16-core / 187 GB host; adjust the rule params in
  `grafana/provisioning/alerting/rules.yml` for other hardware.
