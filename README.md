# Eris Competition MVP

Local multi-protocol DeFi strategy simulation on an Anvil **Arbitrum One** fork. Agents do not receive RPC access, private keys, pending transactions, or txpool data. The coordinator gives each agent only confirmed-state observations and converts accepted JSON actions into transactions.

Supported protocols are pluggable via a protocol adapter registry (`src/protocols/`). Phase 1 ships Uniswap V3; Balancer v2, Curve, Aave v3, and GMX v2 are added in later phases. Select active protocols per run with `ENABLED_PROTOCOLS` (comma-separated, e.g. `ENABLED_PROTOCOLS=uniswap,aave,gmx`). Aave v3 and GMX v2 prices are driven by controllable mock oracles updated each round.

## Setup

```bash
npm install
cp .env.example .env.local
cp agents.local.example.json agents.local.json
```

Fill `ARB_RPC_URL` (an Arbitrum One RPC endpoint) in `.env.local`. `FORK_BLOCK_NUMBER` is optional (defaults to the RPC's latest block).
Load it before running commands, or export the same variables in your shell.

Recommended local defaults:

```bash
ANVIL_PORT=8545
ANVIL_RPC_URL=http://127.0.0.1:8545
CHAIN_ID=42161
ROUNDS=1
ENABLED_PROTOCOLS=uniswap
AGENTS_CONFIG=agents.local.json
REPORT_DIR=./runs
```

Build the mock oracle contracts (required once Aave v3 / GMX v2 are enabled; needs Foundry):

```bash
npm run build:contracts
```

Private key variables can be left empty for local Anvil runs; the coordinator falls back to Anvil's default dev keys.

## Smoke Test

In one terminal:

```bash
set -a
source .env.local
set +a
npm run anvil
```

In another terminal:

```bash
set -a
source .env.local
set +a
export ROUNDS=1 ENABLED_PROTOCOLS=uniswap
npm run sim
```

Outputs are written under `runs/<run_id>/`.

Expected smoke-test coverage:

- Wallet setup completes for all agents and flow wallets.
- WETH deposit, token approvals, and the initial WETH -> USDC swap complete.
- One round submits flow transactions and any valid agent transactions.
- `anvil_mine` produces receipts for submitted transactions.
- `events.jsonl`, `blocks.csv`, `summary.json`, and `history.json` are written under the run directory.

## Output Checks

Review `summary.json` for each agent's final balances, net PnL, gas usage, revert count, and submitted/included transaction counts.

Review `blocks.csv` to confirm Anvil's fee ordering:

```bash
npm run check:ordering -- runs/<run_id>
```

Review `events.jsonl` for `tx_submit_failed`, `tx_receipt_failed`, `action_rejected`, `revert`, or `timeout` events. Transaction-level submit and receipt failures are logged and skipped so one bad transaction does not stop the full run.

## Full Run

After the smoke test passes, run the configured longer simulation:

```bash
set -a
source .env.local
set +a
npm run sim
```
