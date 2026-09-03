#!/usr/bin/env bash
# Self-test one agent's resource budget end-to-end, in the SAME image and caps production uses.
# Builds the team image, runs a short live environment (funds wallets + deploys venues) with only
# this agent + a noop baseline -- each in a capped container -- and tells you if the agent stayed
# within the memory cap. An agent that exceeds the cap is OOM-killed (the coordinator reports it as
# an early exit, code 137).
#
#   infra/docker-agent/self-test.sh <agent-id>
#
# Memory cap: ERIS_DOCKER_MEM (default 1g). Chain: ERIS_RPC_URL (default http://127.0.0.1:8545).
# A local-deploy chain (anvil + all venues) must already be running. In another terminal:
#   cd deployer && npm run deploy -- --keep-fresh   # leave running; wait for it to print addresses
# then, at the repo root (deploy finished), import the addresses:
#   npm run gen:local-constants
# (`npm run anvil` is fork-mode only and refuses under ERIS_LOCAL_DEPLOY=1. Don't gen before the
#  deploy finishes -- --keep-fresh resets deployments.json first.)
set -euo pipefail
ID="${1:?usage: self-test.sh <agent-id> (a directory under example/agents/)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEM="${ERIS_DOCKER_MEM:-1g}"
RPC="${ERIS_RPC_URL:-http://127.0.0.1:8545}"
cd "$REPO"
[ -d "example/agents/$ID" ] || { echo "no such agent: example/agents/$ID" >&2; exit 1; }

# The environment needs a reachable chain; fail early with a clear message rather than mid-run.
if ! curl -s -o /dev/null --max-time 3 -X POST "$RPC" \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'; then
  echo "no chain at $RPC -- start the local-deploy chain first:" >&2
  echo "  cd deployer && npm run deploy -- --keep-fresh   (then: npm run gen:local-constants)" >&2
  echo "  or set ERIS_RPC_URL to an existing local-deploy chain" >&2
  exit 1
fi

echo "[1/3] build image eris-agent:$ID"
infra/docker-agent/build.sh team "$ID"

echo "[2/3] generate a 2-agent self-test config (noop + $ID)"
CFG="config/_selftest-$ID.yaml"
trap 'rm -f "$CFG"' EXIT
sed '/^agents:/,$d' config/local.yaml > "$CFG"
cat >> "$CFG" <<YAML
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true
  - id: $ID
    dir: $ID
    wallet: AUTO
    command: $REPO/infra/docker-agent/run-agent.sh
    env: { ERIS_AGENT_DIR: "$REPO/example/agents/$ID" }
YAML

echo "[3/3] run the environment (memory cap=$MEM). In another terminal: docker stats eris-$ID"
ERIS_LOCAL_DEPLOY=1 ERIS_DOCKER_MEM="$MEM" ERIS_RPC_URL="$RPC" \
  npm run sim:realtime -- --config "$CFG"

echo
echo "self-test done. If agent '$ID' exited early with code 137 it exceeded $MEM (OOM); otherwise it fit."
echo "reap any leftover container: infra/docker-agent/reap.sh"
