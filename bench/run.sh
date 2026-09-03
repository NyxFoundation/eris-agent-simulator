#!/usr/bin/env bash
# ASCON load-test bench — single monorepo entrypoint.
# Reset chain -> generate an N-agent roster -> run the realtime sim with each agent in a memory/CPU
# capped container (infra/docker-agent) -> sample host+container resources -> aggregate -> write a
# Markdown summary (consumed by CI to comment on the PR).
#
#   bench/run.sh [--agents N] [--blocks B] [--block-time S] [--mode frozen|llm] [--mem 1g] [--out DIR]
#
# Env: ANVIL_PORT (default 8545). For CI on a shared host, set a dedicated port so it won't touch a
# running monitoring/production anvil.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$REPO"

AGENTS=12; BLOCKS=200; BT=2; MODE=frozen; MEM="${ERIS_DOCKER_MEM:-1g}"; OUT=""
while [ $# -gt 0 ]; do case "$1" in
  --agents) AGENTS=$2; shift 2;; --blocks) BLOCKS=$2; shift 2;; --block-time) BT=$2; shift 2;;
  --mode) MODE=$2; shift 2;; --mem) MEM=$2; shift 2;; --out) OUT=$2; shift 2;;
  *) echo "unknown arg: $1" >&2; exit 1;; esac; done
OUT="${OUT:-$REPO/bench/results/$(date +%Y%m%d-%H%M%S)-${AGENTS}${MODE}}"
mkdir -p "$OUT"
CFG="$REPO/config/_bench.yaml"

# Point the whole run at ANVIL_PORT so the chain, coordinator and agents all agree (this is what lets
# a bench on a dedicated port stay isolated from a monitoring/production anvil on 8545).
export ANVIL_PORT="${ANVIL_PORT:-8545}"
export ANVIL_RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
export ERIS_RPC_URL="$ANVIL_RPC_URL"

echo "[1/5] reset chain";  bash "$REPO/bench/lib/reset-chain.sh"
echo "[2/5] config";       python3 "$REPO/bench/lib/mkconfig.py" "$AGENTS" "$BLOCKS" "$BT" "$MODE" "$CFG"
echo "[3/5] sampler";      setsid python3 "$REPO/bench/lib/sampler.py" "$OUT/stats.csv" 1800 >"$OUT/sampler.log" 2>&1 & SAMP=$!
echo "[4/5] sim ($AGENTS agents, $BLOCKS blocks, ${BT}s block, mem $MEM)"
# bind-mount mode: stock node:24 + this checkout mounted (no per-team image build needed for a bench).
export ERIS_AGENT_BINDMOUNT="${ERIS_AGENT_BINDMOUNT:-1}"
ERIS_LOCAL_DEPLOY=1 ERIS_DOCKER_MEM="$MEM" npm run sim:realtime -- --config "$CFG" >"$OUT/run.log" 2>&1 || true
bash "$REPO/infra/docker-agent/reap.sh" >/dev/null 2>&1 || true      # sweep any orphaned containers
kill "$SAMP" 2>/dev/null || true
echo "[5/5] aggregate"
LABEL="$AGENTS agents / $MODE / ${BT}s block"
python3 "$REPO/bench/lib/agg.py" "$OUT/stats.csv" "$LABEL" | tee "$OUT/summary.txt"
python3 "$REPO/bench/lib/agg.py" "$OUT/stats.csv" "$LABEL" --md > "$OUT/summary.md"
grep -q "simulation completed" "$OUT/run.log" && echo "run: completed" || echo "run: DID NOT COMPLETE (see run.log)"
echo "summary -> $OUT/summary.md"
