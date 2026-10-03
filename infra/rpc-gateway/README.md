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

`PORT` (8546) · `UPSTREAM` (http://127.0.0.1:8545) · `ENV_NAME` (live|test) · `LOG_FILE` · `METRICS_FILE` ·
`RPC_MAX_TX_GAS` (30000000) · `RPC_MAX_PRIORITY_FEE_WEI` (5000000000) — these two are the
[transaction checks](#transaction-checks-at-entry-gas-cap-and-fee-rule) ·
`RPC_MAX_PARAM_DEPTH` (64) · `RPC_MAX_PARAM_NODES` (100000) — the [request shape limit](#request-shape-limit) ·
`RPC_KEYS_FILE` · `RPC_SENDERS_FILE` · `RPC_SENDER_CHECK` (1) — the [sender check](#sender-check-a-key-sends-only-from-its-bound-addresses).
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
touches the live chain, sets the block gas limit to the competition's 30M (`--load-state` otherwise
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
| `RPC_METHOD_ALLOW` | *(explicit list in `gateway.mjs`)* | regex that replaces the built-in list of permitted methods |

The built-in list (`ALLOWED_METHODS`) names each standard read, the filter calls for mined logs and
blocks, and `eth_sendRawTransaction`. It used to be the prefix `^(eth_|net_|web3_)`, which passed every
`eth_` method the node has unless the deny regex named it. anvil has `eth_` methods that act without a
signature: `eth_sendUnsignedTransaction` is accepted from any `from`, unlocked or not. And
`eth_sendRawTransactionSync` skipped the gas cap and the fee rule, which read only
`eth_sendRawTransaction`. Both checks now read every raw-send method, whichever list is in force.

Denied methods get HTTP 403 + a JSON-RPC error and are counted in `rpc_method_denied_total`. Verified:
`anvil_setBalance`/`evm_mine`/`hardhat_setBalance`/`txpool_content`/`debug_traceTransaction` → 403,
`eth_blockNumber`/`eth_call` → 200, both locally and over the external `ascon-rpc` tunnel (closing the
prior exposure where an Access-authenticated caller could call cheatcodes).

### What the allowlist cannot cover: the chain's own keys (issue #74)

`eth_sendRawTransaction` is on the permitted side, and it has to be — it is how a participant trades.
So the filter cannot protect an account whose key is public, and on a chain deployed from anvil's
default mnemonic every prefunded account is exactly that, including the deployer that holds Aave's
`POOL_ADMIN`, GMX's `CONFIG_KEEPER` and every seeded LP position. Narrowing the allowlist does not
help: the key is the credential, not the method.

The fix is on the chain, not at this boundary — redeploy from a secret mnemonic and restart anvil
with it (`deployer/README.md` → "Deploying with a secret mnemonic", and the rotation runbook in
`docs/guide/practice-devnet.md`).

### Pending-transaction visibility (issue #87)

The default filter keeps the priority-fee auction sealed at this RPC boundary. It refuses
`eth_pendingTransactions`, `eth_newPendingTransactionFilter`, `eth_getFilterChanges`,
`eth_getFilterLogs`, and `eth_subscribe`. Filter reads are refused even for filters created through
another connection; otherwise an existing pending filter would bypass the creation ban. Use
`eth_getLogs` for mined logs and `eth_blockNumber` for block polling.

The `pending` tag is refused in **any parameter position and inside objects** (case-insensitive), on
every method but `eth_getTransactionCount`. It used to be refused only as `params[0]` of the five
block-enumeration methods, but anvil executes a state read at `pending` (`eth_call`, `eth_getBalance`,
`eth_getStorageAt`, `eth_estimateGas`, ...) against a block built from the pool, so those reads showed
unmined transactions, including the oracle update. A mixed batch containing a forbidden call is rejected in full before being
forwarded.

An **omitted block parameter** is the same leak without the string: anvil runs `eth_estimateGas`
without one against the pending block (measured, anvil 1.5.1, `--no-mining`: with a reverting contract
deployed in the pool, `eth_estimateGas [{to}]` reverted while `[{to}, "latest"]` returned `0x5208`), and
viem's `estimateGas` sends exactly `[request]`. The gateway writes `"latest"` into an `eth_estimateGas`
whose block parameter is missing or `null` rather than refusing it, so client defaults keep working.
`eth_call` and `eth_createAccessList` default to latest on anvil (measured the same way) and are
forwarded unchanged. The consequence for senders: **a gas estimate never sees your own pending
transactions either**, so a leg that needs an earlier one (approve → swap) fails its estimate while the
earlier leg is unmined. The reference runtime (`example/agents/runtime/send.ts`) sends such a leg with
a fixed limit (`ERIS_DEPENDENT_TX_GAS`, 2,000,000, inside the 30M per-tx and per-block budgets) when it
has transactions of its own pending, and drops it as before when it has none. Mined block reads and **`eth_getTransactionCount(address, "pending")` remain available**:
`Sender` seeds its nonce with the latter and must account for already pending submissions.
`eth_sendRawTransaction` remains available subject to the gas cap and the fee rule (below).

`RPC_METHOD_DENY` overrides the default method-deny regex; replacing it is an operator policy
change and must preserve these bans on participant endpoints. Parameter checks still apply while
`RPC_FILTER=1`. `RPC_FILTER=0` is an internal all-access endpoint. Direct access to the upstream node
also bypasses filtering; the operator must keep it private.

Measured locally **before the fix**, 2026-09-07, Anvil **v1.7.1**, `--no-mining`, `RPC_FILTER=1`,
with one transaction in the pool and the latest block still at 0:

| Gateway call | Before | After |
|---|---|---|
| `eth_pendingTransactions` | HTTP 200, upstream `-32601 Method not found` in this Anvil version | HTTP 403 |
| `eth_newPendingTransactionFilter` then `eth_getFilterChanges` | HTTP 200, pending transaction hash returned | HTTP 403 on both |
| `eth_getBlockByNumber("pending", true)` | HTTP 200, full pending transaction including calldata and fees | HTTP 403 |
| `eth_getBlockTransactionCountByNumber("pending")` | HTTP 200, `0x1` | HTTP 403 |
| `eth_getTransactionByBlockNumberAndIndex("pending", "0x0")` | HTTP 200, `null` in this Anvil version | HTTP 403 (do not rely on upstream behavior) |
| `eth_getTransactionCount(sender, "pending")` | HTTP 200, `0x1` | HTTP 200, `0x1` |

Reproduce the regression against a real Anvil with
`node --import tsx --test test/rpcGateway.test.ts test/runtimeSender.test.ts`. The sender test also
submits two actions through the gateway on top of an existing pending transaction, checks consecutive
nonces and submission records, and mines all three. These tests need Anvil, already installed in CI.

### Request shape limit

Every request is walked iteratively before any check reads it, and one nesting deeper than
`RPC_MAX_PARAM_DEPTH` (64) or holding more than `RPC_MAX_PARAM_NODES` (100,000) values is refused with
HTTP 400 + JSON-RPC `-32600`, counted in `rpc_params_denied_total`. The pending check used to recurse:
~6,000 nested arrays (a 12KB body) ran the stack out inside the request handler, uncaught, and ended the
process every participant shares. Standard methods nest a handful of levels (`eth_getLogs` topics,
`eth_call` state overrides). The handler is also wrapped so an unexpected exception answers 500
(`-32603`) instead of ending the process. The limit applies with `RPC_FILTER=0` too.

## Transaction checks at entry (gas cap and fee rule)

`eth_sendRawTransaction` is the one write a participant has, so the gateway decodes each signed
transaction (`txGas.mjs`, a minimal RLP reader — nothing is executed) and refuses, with HTTP 403 and
JSON-RPC error `-32003`, what would break the competition's rules. A batch is refused whole. A
transaction whose fields cannot be read (an envelope type other than legacy / `0x01`–`0x04`) is
refused too: a check that passes what it cannot parse is bypassed by choosing a type it does not know.

| check | refuses | env | counter |
|---|---|---|---|
| gas cap (issue #40 T0) | a gas limit above the per-transaction cap | `RPC_MAX_TX_GAS` (30,000,000; 0 disables) | `rpc_gas_denied_total` |
| fee rule | typed (`0x02`/`0x03`/`0x04`): `maxFeePerGas > maxPriorityFeePerGas`, or `maxPriorityFeePerGas` above the cap. Legacy / `0x01`: `gasPrice` above the cap | `RPC_MAX_PRIORITY_FEE_WEI` (5,000,000,000 = `fees.maxPriorityFeeWei`; 0 disables the cap half only) | `rpc_fee_denied_total` |

**Why the fee rule compares maxFeePerGas with the tip.** Rules §2.6 order a block by the priority fee,
highest first. anvil `--order fees` sorts its pool on **maxFeePerGas** (foundry v1.7.1,
`crates/anvil/src/eth/pool/transactions.rs`: `TransactionPriority(tx.max_fee_per_gas())`), and on the
competition chain (base fee 0) a transaction pays min(maxFeePerGas, maxPriorityFeePerGas) per gas. The
order and the payment agree only when maxFeePerGas ≤ maxPriorityFeePerGas — then the transaction pays
exactly its maxFeePerGas. Measured 2026-09-27 on anvil 1.7.1 `--order fees --base-fee 0`, one block each:

| transactions (arrival order) | order in the block | paid per gas |
|---|---|---|
| A tip 1 / maxFee 1 gwei · B tip 0.1 / maxFee 3 · C legacy gasPrice 2 | B, C, A (also with arrival reversed) | B 0.1 · C 2 · A 1 gwei |
| D 6 / 6 gwei (the oracle update's shape) · E tip 0.1 / maxFee 7 | E, D (also under 2 s interval mining) | E 0.1 · D 6 gwei |

So without the check, a self-signed transaction could take txIndex 0 — ahead of the environment's
oracle update, which the cap exists to keep first — while paying a fifth of the cap. **Sign
maxFeePerGas equal to maxPriorityFeePerGas.** The reference runtime does (`sdk/src/feeRule.ts`
`participantFees`); a self-signer who does not is refused here, and a transaction that reaches the node
another way is flagged after the run from `blocks.csv` (`core/src/postRunCheck.ts`, the authority).
Under the economic gas profile (ADR 0011 §2) set `RPC_MAX_PRIORITY_FEE_WEI=0`: that retires the cap,
not the maxFeePerGas half, which has no switch. `npm run check:ordering -- --live` reports which field
a chain's builder sorts on (run it against the node: its overbid probe is exactly what this refuses).

Reproduce with `node --import tsx --test test/rpcGateway.test.ts`.

## Sender check: a key sends only from its bound addresses

With `RPC_KEYS_FILE` set, every `eth_sendRawTransaction` (and `eth_sendRawTransactionSync`) has its
signer recovered (`txSender.mjs`: keccak-256 and secp256k1 recovery in BigInt, ~1 ms per transaction,
because Node's crypto has neither) and is refused with HTTP 403 + JSON-RPC `-32003` unless the signer is
an address bound to the caller's key. A batch is refused whole. A signature that cannot be recovered is
refused (fail closed, like the gas cap). Counted in `rpc_sender_denied_total`; the log line carries the
recovered `from`.

Before this, the key said *who* was calling and nothing tied that to *what they signed*: a participant
with a valid key could send a transaction signed by any private key they knew -- one derived from a
public seed (issue #189) or one of anvil's public test accounts -- and trade as that address.

**Where the bindings come from.** Two sources, unioned, both reloaded every 15 s:

| source | written by | when to use |
|---|---|---|
| `RPC_SENDERS_FILE` | the coordinator (`run.sendersFile`), from the registered field: the startup roster's `external` entries plus every accepted entry of `run.registrationsFile` | always. Registering a participant in `config/registrations.yaml` is the only edit; ~1 min later (coordinator poll ~30 blocks + gateway 15 s) the key can send |
| `RPC_KEYS_FILE` `"senders"` | by hand, `infra/access/issue-key.sh --bind <id> <address>` | a gateway with no coordinator beside it, or an address the registrations do not hold |

The coordinator's file is keyed by the registration's `participant` (or its `id` when it has none),
and the gateway matches that against the key's id — so **issue the key under that name**
(`issue-key.sh --issue team-alice`). One key per participant unit; its agents (`alice`, `alice-2`)
all send through it. Agents the coordinator runs itself are never listed (they do not use the
gateway). Neither file needs a restart: no coordinator restart, no chain restart.

A key with no binding can read but not send. The check runs **after** the rate limit, so a refused submission still
costs the caller's tokens. The environment's own wallets (oracle, keeper, flow, setup) talk to anvil
directly and never pass through here. Without `RPC_KEYS_FILE` there is no identity to bind and the check
is off; `RPC_SENDER_CHECK=0` turns it off with keys (an internal gateway).

Reproduce with `node --import tsx --test test/rpcGateway.test.ts`.
