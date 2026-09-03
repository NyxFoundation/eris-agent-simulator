# infra/rpc-gateway — JSON-RPC observability proxy

anvil exposes **no per-method metrics** (every call is `POST /`). `gateway.mjs` is a thin, zero-dependency
Node reverse proxy that sits in front of anvil, reads each request's `method` (batch-aware), times the
upstream round-trip, and turns the RPC path into observable signals. It is the origin the Cloudflare
tunnel points `ascon-rpc.nyx.foundation` at (`:8546`), so **all external RPC is metered**.

```
team / external  --(ascon-rpc.nyx.foundation, CF Access)-->  gateway :8546  -->  anvil :8545
```

## Metrics (Prometheus)

| metric | meaning |
|---|---|
| `rpc_requests_total{env,method,status}` | call count per method (batch expands to members); status ok / rpc_error / upstream_error |
| `rpc_request_duration_seconds{env,method}` | latency histogram → p50/p95/p99 per method |
| `rpc_batch_size{env}` | JSON-RPC batch sizes |
| `rpc_in_flight{env}` | concurrent upstream requests |
| `rpc_upstream_up{env}` | 1 if the last upstream call connected |

The host firewall blocks Prometheus (bridge) from scraping this host-networked process, so metrics are
delivered via the **node-exporter textfile bridge**: the gateway writes `METRICS_FILE` (a `.prom` in the
shared `ascon-textfile` volume) every 10s and node-exporter serves it. Same pattern as `eris-exporter`.

## Call timeline (Loki)

One JSON line per call → `LOG_FILE` (under `~/ascon-logs/rpc/`, tailed by promtail as `job=ascon-rpc`):
`{ts, env, method, dur_ms, status, http, client, ip}`. `client` is the caller's identity — Cloudflare
Access does not forward `CF-Access-Client-Id`, so the gateway reads the **`common_name` claim from the
`Cf-Access-Jwt-Assertion` JWT** (= the service token's client_id). Issue one service token per team and
this column tells you who called what, when.

## Config (env)

`PORT` (8546) · `UPSTREAM` (http://127.0.0.1:8545) · `ENV_NAME` (live|test) · `LOG_FILE` · `METRICS_FILE`.
Runs as the `rpc-gateway-live` service in `infra/monitoring/docker-compose.yml` (host-net,
`restart: unless-stopped`); `rpc-gateway-test` (compose profile `test`) is ready for a second env.

## Load test — `loadtest.mjs`

Drives sustained traffic through the **full external path** (CF edge → Access → tunnel → gateway → anvil):
measures client-side throughput + latency and lights up the Grafana "RPC & Chain" dashboard. Read-only
(safe against a live chain). Counterpart to `npm run stress:rpc` (which hits the node directly).

```bash
set -a; . cf-service-token.env; set +a          # CF_ACCESS_CLIENT_ID / _SECRET
node infra/rpc-gateway/loadtest.mjs --concurrency 50 --seconds 120
# --url (default https://ascon-rpc.nyx.foundation) --timeout 15000
```

Reports total/throughput, p50/p95/p99, and a per-method breakdown; compare against the server-side
numbers in Grafana (they should agree, minus the CF edge round-trip that only the client sees).

## Write capacity — `writeload.mjs`

Answers "how many participants can we hold?" by measuring how many **transactions** the chain mines per
block at the competition block time. Runs against a DEDICATED anvil (default `:8555`) so it never
touches the live chain, sets the block gas limit to the competition's 320M (`--load-state` otherwise
leaves it at the state's 3B — the same gotcha `reset.sh` guards), funds throwaway accounts, and blasts
signed txs. Signing is CPU-bound, so it is spread across `worker_threads` to actually saturate anvil; a
SharedArrayBuffer bounds the unmined backlog. Two tx types, equal volume per contract: `transfer` (ETH,
21k gas) and `approve` (ERC20, spread over each token) — light/medium writes that isolate the pipeline
ceiling from heavy DeFi-tx execution.

```bash
# dedicated anvil:  anvil --port 8555 --base-fee 0 --load-state backtest/state/venues-state.json ...
node infra/rpc-gateway/writeload.mjs --url http://127.0.0.1:8555 --senders 400 --workers 12 --seconds 40 --blocktime 2 --type transfer|approve
```

Reports tx/block (gas-bound, identical at 2s/4s), mined tx/s, and derived participant capacity. Result:
the pipeline handles thousands of light tx/s (12k–15k tx/block), so capacity is bound by heavy DeFi-tx
*execution*, not RPC ingestion or gas — see the ASCON `docs/18` §17.

## Per-client rate limit (anti-abuse)

The gateway rate-limits each caller with a token bucket, so no single team can hammer the shared node
(e.g. `eth_call`/`simulateTx` spam). Heavy, EVM-executing reads cost more than light ones. Caller key is
the Access `common_name` (falls back to IP). Over-limit requests get HTTP 429 + a JSON-RPC error before
anvil is touched, and are counted in `rpc_ratelimited_total`.

| env | default | meaning |
|---|--:|---|
| `RPC_RATE_REFILL` | 100 | tokens/sec/client (**0 disables** — set 0 for load tests) |
| `RPC_RATE_BURST` | 300 | bucket capacity (short-burst allowance) |
| `RPC_HEAVY_WEIGHT` | 5 | cost of a heavy read (`eth_call`, `eth_estimateGas`, `eth_createAccessList`, `eth_getLogs`, `debug_*`, `trace_*`); light calls cost 1 |

A legit agent does ~1 observation/block (well under 1 req/s), so it never hits the limit; only spam does.
Verified: 400 `eth_call` from one client → 96 pass / 304 rejected (429); tune the envs on the service.

## Cheatcode / method allowlist (4.22: cheatcode-free chain for callers)

The dev anvil ships state-manipulation cheatcodes (`anvil_setBalance`, `evm_mine`, `setStorageAt`,
impersonation, snapshots) and mempool introspection (`txpool_content`). The gateway is the participant's
RPC boundary, so it **default-denies** everything except standard reads/sends and blocks the privileged
namespaces before anvil is touched. The operator hits anvil directly (not the gateway), so setup
cheatcodes still work.

| env | default | meaning |
|---|---|---|
| `RPC_FILTER` | 1 | enable the method allowlist (0 disables — internal all-access gateway) |
| `RPC_METHOD_ALLOW` | `^(eth_\|net_\|web3_)` | regex of permitted method prefixes |

Denied methods get HTTP 403 + a JSON-RPC error and are counted in `rpc_method_denied_total`. Verified:
`anvil_setBalance`/`evm_mine`/`hardhat_setBalance`/`txpool_content`/`debug_traceTransaction` → 403,
`eth_blockNumber`/`eth_call` → 200, both locally and over the external `ascon-rpc` tunnel (closing the
prior exposure where an Access-authenticated caller could call cheatcodes).
