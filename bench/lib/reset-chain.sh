#!/usr/bin/env bash
# Fresh anvil with every venue pre-loaded, for a bench run. Repo-relative.
# Isolates by PORT: it stops only the anvil on ANVIL_PORT (not every anvil on the box), so a bench
# on a dedicated port won't kill a production/monitoring anvil elsewhere.
#   ANVIL_PORT (default 8545), ANVIL_LOG (default /tmp/ascon-bench-anvil.log)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:$PORT"
LOG="${ANVIL_LOG:-/tmp/ascon-bench-anvil.log}"

# stop leftover bench agents (containers) and any sim, then the anvil on THIS port only
# Agent containers only. The name prefix `eris-` also matches `eris-explorer-*`, the local
# Blockscout stack, and a bench reset is not entitled to take that down.
for c in $(docker ps -aq --filter "label=eris.role=agent" 2>/dev/null || true); do docker rm -f "$c" >/dev/null 2>&1 || true; done
for pid in $(pgrep -x node 2>/dev/null || true); do
  tr "\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q "cli/sim-realtime" && kill "$pid" 2>/dev/null || true
done
oldpid=$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
[ -n "${oldpid:-}" ] && kill "$oldpid" 2>/dev/null || true
sleep 3

nohup anvil --port "$PORT" --code-size-limit 50000 --base-fee 0 \
  --gas-limit 320000000 --accounts 10 --balance 1000000 \
  --load-state "$REPO/backtest/state/venues-state.json" \
  > "$LOG" 2>&1 &

for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
curl -s -X POST "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"anvil_setBlockGasLimit","params":["0x1312D000"]}' >/dev/null || true
echo "anvil up on :$PORT (block $(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '?'))"
