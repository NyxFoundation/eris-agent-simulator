# Local Blockscout explorer for the run anvil (issue #31)

Stock Blockscout — official images pinned by tag, no source vendored or patched — pointed
at whichever sim anvil is running. Gives blocks / txs / addresses / logs a browsable UI
instead of raw `cast` calls, and gives the Eris dashboard (#32) a link target for tx and
address detail pages.

```
npm run explorer          # start → http://localhost:3100
npm run explorer:reset    # wipe the indexer DB and reindex (run after every chain reset)
npm run explorer:tag      # name agent wallets from the latest run's summary.json
npm run explorer:down     # stop (indexer DB survives)
```

All knobs live in [`explorer.env`](explorer.env): anvil port, chain id, explorer port,
image tags. Defaults match local-deploy mode (deployer anvil on 8545, chain 31337), which
is also what `npm run sim:realtime` runs on out of the box.

## Lifecycle: reset the explorer whenever the chain resets

Every run rewinds the chain — local-deploy mode snapshot/reverts to the clean deploy
cross-section, fork mode re-forks. A block-height rewind is something no indexer can
follow (it has indexed blocks that no longer exist), so the supported lifecycle is:

1. chain resets (new run starts)
2. `npm run explorer:reset` — drops the postgres volume, reindexes from scratch
3. optionally `npm run explorer:tag` once the run has a `runs/<id>/summary.json`

Reindexing a run-sized chain (hundreds of blocks) takes well under a minute. Skipping the
reset does not crash anything, but the explorer will show a mix of stale and current
blocks at the same heights.

## Pointing it at the different anvils

| target | `RPC_PORT` | `CHAIN_ID` | `FIRST_BLOCK` |
|---|---|---|---|
| deployer anvil (local-deploy mode, default) | 8545 | 31337 | 0 |
| backtest replay anvil (`npm run backtest`) | 8547 | 31337 | 0 |
| Arbitrum fork anvil (`npm run anvil`) | 8545 | 42161 | **the fork block** |

Edit `explorer.env`, then `npm run explorer:reset`. `explorer.sh` cross-checks the
configured `CHAIN_ID` against what the anvil actually reports and refuses to start on a
mismatch.

Fork-mode caveats:

- **`FIRST_BLOCK` is mandatory** (set it to `FORK_BLOCK_NUMBER`). Without it the indexer
  walks all of Arbitrum history backwards from the head.
- **Receipts are fetched per transaction.** `ETHEREUM_JSONRPC_VARIANT=anvil` uses
  `eth_getTransactionReceipt`, not `eth_getBlockReceipts` — required because
  `eth_getBlockReceipts` is known-broken on anvil Arbitrum forks in this project.
- Historical state on a fork is ~1,050 blocks deep, so
  `ETHEREUM_JSONRPC_DISABLE_ARCHIVE_BALANCES=true` is set: balances are fetched at the
  current block only.

## Agent wallet naming

`npm run explorer:tag` (optionally `-- runs/<id>`) reads `agents[].{id,address}` from a
run's `summary.json` and inserts them as Blockscout address tags (`address_tags` /
`address_to_tags` in the indexer DB — config-level; no Blockscout change). Each agent id
becomes a badge on its address pages, plus `env:deployer` for anvil account 0, whose txs
(venue seeding, liquidityPull reconciles) would otherwise read as a participant's. Tags
live in the indexer DB, so a `reset` wipes them; re-tag after the next run.

## What runs, and what was deliberately dropped

`db` (postgres 17) / `redis-db` / `backend` / `frontend` / nginx `proxy`, following the
official `docker-compose/anvil.yml`. Dropped from that layout: `stats` (+ its db),
`visualizer` (sol2uml), `sig-provider`, `user-ops-indexer`, `nft_media_handler` — spectator
polish, not debugging. The homepage consequently shows no per-day counters; blocks and txs
are unaffected. Internal-transaction and pending-transaction fetchers are disabled exactly
as the official anvil compose does (the former needs `debug_traceBlockByNumber`, and both
add RPC load to the anvil that is also serving every agent's observe loop).

**Egress**: the only outbound dependency is contract verification through Blockscout's
hosted eth-bytecode-db, which names canonical bytecode (Uniswap V3, Aave, …) without a
local verifier. Set `MICROSERVICE_SC_VERIFIER_ENABLED=false` in
`envs/common-blockscout.env` to run fully offline; everything else keeps working.

Linux note: the compose reaches the host's anvil via `host.docker.internal` (mapped with
`host-gateway`). On Linux that resolves to the docker bridge, so an anvil bound to
127.0.0.1 is unreachable — start it with `--host 0.0.0.0` there. macOS Docker Desktop
forwards to loopback and needs nothing.
