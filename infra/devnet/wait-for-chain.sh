#!/usr/bin/env bash
# Block until the chain named by .env.local answers, or give up.
#
# The coordinator's first act is an RPC call, so starting it before anvil is listening is a crash.
# Under systemd that crash spends one of three restarts an hour (ascon-devnet.service), and at boot
# the chain is a container that has not been scheduled yet — so the budget would be gone before
# docker finished. Waiting here separates "not up yet" from "not working", which is the distinction
# the restart budget exists to make.
#
# Reads ANVIL_RPC_URL out of .env.local by grep rather than sourcing it: that file holds private
# keys, and this script has no reason to have them in its environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"
TIMEOUT_SEC="${WAIT_FOR_CHAIN_TIMEOUT:-180}"
INTERVAL_SEC=3

url="${ANVIL_RPC_URL:-}"
if [ -z "$url" ] && [ -f "$ENV_FILE" ]; then
  url="$(grep -E '^[[:space:]]*ANVIL_RPC_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
if [ -z "$url" ]; then
  echo "[wait-for-chain] no ANVIL_RPC_URL in the environment or $ENV_FILE" >&2
  exit 1
fi

deadline=$(( $(date +%s) + TIMEOUT_SEC ))
attempt=0
while :; do
  attempt=$((attempt + 1))
  if out=$(curl -sf -m 5 -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}' "$url" 2>/dev/null) \
     && [ "${out#*\"result\"}" != "$out" ]; then
    echo "[wait-for-chain] $url answered after ${attempt} attempt(s): $out"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[wait-for-chain] $url did not answer within ${TIMEOUT_SEC}s (${attempt} attempts)" >&2
    exit 1
  fi
  sleep "$INTERVAL_SEC"
done
