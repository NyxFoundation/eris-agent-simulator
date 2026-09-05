#!/usr/bin/env bash
# Run ONE eris agent (example/agents/runtime/bot.ts) inside a memory/CPU-capped Docker container.
#
# Use it as an AgentSpec.command target so the operator runs each submitted agent isolated, AND so a
# participant can run their own agent under the exact same image and caps locally -- which is how you
# verify an agent stays within the memory budget before submitting (see self-test.sh / README).
#
# Two modes:
#   image (default)  -- the per-team image eris-agent:<id> (infra/docker-agent/Dockerfile.base +
#                       Dockerfile.team). Only the dynamic bits (config, runs dir) are mounted, and
#                       the coordinator's absolute host paths are remapped onto the image's /eris.
#   bind-mount       -- ERIS_AGENT_BINDMOUNT=1: stock node:24 with the repo bind-mounted at its own
#                       host path (no build; handy for iterating on runtime code on the same host).
#
# Caps default to 1 GiB / 0.5 vCPU (ERIS_DOCKER_MEM / ERIS_DOCKER_CPUS). --memory-swap is pinned to
# --memory so the limit is a hard ceiling (over-budget agents OOM-kill instead of swapping).
#
# NOTE on isolation: --network host means the container shares the host network, so run-time egress
# is NOT contained here -- it must be enforced by the operator's host/network policy. See README.
#
# Cleanup: this execs `docker run --rm`, which removes the container on graceful exit (the client
# forwards SIGTERM/SIGINT). The coordinator may SIGKILL this wrapper at run end (uncatchable, and
# there is no shell left after exec to trap it anyway) -- run reap.sh afterwards to sweep survivors.
set -euo pipefail

REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MEM="${ERIS_DOCKER_MEM:-1g}"
CPUS="${ERIS_DOCKER_CPUS:-0.5}"
NAME="eris-${ERIS_AGENT_ID:?ERIS_AGENT_ID is required (set by the coordinator)}"

# Agent-to-agent isolation (ISOLATION.md, verified): put each agent on its OWN docker network that
# only anvil also joins. Agents cannot reach each other (separate L2), can reach anvil by name, and
# still egress (NAT) so a team may use its own LLM. Opt-in; needs anvil running as a bridge
# container (ERIS_ANVIL_CONTAINER, default ascon-anvil) and ERIS_RPC_URL=http://<that>:8545.
if [ "${ERIS_AGENT_ISOLATE:-0}" = "1" ]; then
  # Hub = the container agents may reach on their private net. Default the RPC gateway so agents get the
  # cheatcode filter + rate limit and CANNOT reach anvil directly (set ERIS_RPC_URL=http://<hub>:8546).
  # Set ERIS_AGENT_HUB=ascon-anvil to expose anvil directly instead (no filter).
  HUB_CT="${ERIS_AGENT_HUB:-ascon-rpc-gateway-live}"
  ISONET="ag-${ERIS_AGENT_ID}"
  docker network create "$ISONET" >/dev/null 2>&1 || true
  docker network connect "$ISONET" "$HUB_CT" >/dev/null 2>&1 || true   # idempotent; hub multi-homes
  export ERIS_AGENT_NET="$ISONET"
fi

# Shared cap/runtime flags, so the two modes cannot drift.
# Hardening (verified not to break the agent): fork-bomb (pids), fd cap (ulimit), no privilege
# escalation, read-only rootfs + a size-capped tmpfs /tmp for scratch. NOTE: --cap-drop=ALL was
# tried and SILENTLY breaks the agent (reads/tx fail -> all noop, container looks healthy), so it
# is intentionally omitted; a targeted cap-drop is a follow-up. Egress is still open (host net) --
# agent<->agent isolation is a separate network stage.
# `--label eris.role=agent` is what the sweepers match on. Matching on the `eris-` name prefix looked
# equivalent and is not: `eris-explorer-*` is the local Blockscout stack, so a bench reset on a box
# that had the explorer running tore it down as collateral.
# `--init` runs tini as PID 1. Without it the agent's node process *is* PID 1, and Linux does not
# deliver a signal with its default disposition to PID 1 — node installs no SIGTERM handler, so the
# agent ignored the coordinator's stop entirely, `docker run` waited for a container that was never
# going to stop, and the environment's own process never exited (measured 2026-09-05: it printed
# `realtime simulation completed`, wrote summary.json, and then sat at 0% CPU forever). tini
# forwards the signal to the real process, which then stops the way it always should have.
CAPS=( --rm --init --network "${ERIS_AGENT_NET:-host}" --name "$NAME" --label eris.role=agent
  --memory="$MEM" --memory-swap="$MEM" --cpus="$CPUS"
  --pids-limit="${ERIS_DOCKER_PIDS:-256}" --ulimit nofile=2048:2048 --security-opt=no-new-privileges
  --read-only --tmpfs /tmp:rw,size=512m,mode=1777 )

# Env forwarded by name. Two are silent if lost under command-override:
#   ERIS_AGENT_DIR    -- command-override skips the directory convention; set it in the roster env:.
#   ERIS_LOCAL_DEPLOY -- from the operator process env; without it constants.local is ignored and
#                        Multicall3 + every venue address fall back to the fork chain, so all reads
#                        and tx builds fail while docker stats still looks healthy.
COMMON_ENV=(
  -e ERIS_AGENT_ID -e ERIS_RPC_URL -e ERIS_AGENT_ADDRESS -e ERIS_AGENT_PRIVATE_KEY
  -e ERIS_PRICE_FEED_ADDRESS -e ERIS_RUN_ID -e ERIS_RUN_BLOCKS -e ERIS_AGENT_FROZEN
  -e ERIS_LLM_MODEL -e ERIS_LOCAL_DEPLOY -e ERIS_OLLAMA_BASE_URL -e ERIS_OLLAMA_API_KEY
  -e OLLAMA_API_KEY -e ANTHROPIC_API_KEY -e HOME=/tmp
  -e ERIS_MAX_TXS_PER_ROUND -e ERIS_MAX_TX_GAS
)

# Run the container with this wrapper supervising it, and make sure the *container* dies when the
# wrapper is asked to stop.
#
# Not `exec`: killing the docker **client** does not stop a daemon-managed container, so an `exec`d
# wrapper left the agent running with its key and its RPC connection after the run had ended and
# been scored. `--init` above fixes the graceful path (tini forwards the signal to a process that is
# otherwise PID 1 and therefore ignores it); this is what fixes the ungraceful one.
#
# Both modes go through here. The bind-mount path used to have its own `exec` and its own hole.
supervise() {
  "$@" &
  CHILD=$!
  trap stop TERM INT
  wait "$CHILD"
}

stop() {
  # Removal, then verification. A failed `docker rm -f` that is shrugged off leaves exactly the
  # container this function exists to remove, so retry briefly and say so if it survives -- an agent
  # that outlives the run still holds its key and its RPC connection.
  for _ in 1 2 3; do
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker ps -q --filter "name=^${NAME}$" | grep -q . || break
    sleep 1
  done
  if docker ps -q --filter "name=^${NAME}$" | grep -q .; then
    echo "run-agent: FAILED to remove container $NAME; it is still running" >&2
  fi
  kill "$CHILD" 2>/dev/null || true
  wait "$CHILD" 2>/dev/null || true
  exit 0
}

if [ "${ERIS_AGENT_BINDMOUNT:-0}" = "1" ]; then
  # Bind-mount mode: same host path inside the container, so coordinator paths resolve as-is.
  supervise docker run "${CAPS[@]}" "${COMMON_ENV[@]}" \
    -e ERIS_RUN_DIR -e ERIS_AGENT_DIR -e ERIS_CONFIG \
    -v "$REPO:$REPO:ro" -v "$REPO/runs:$REPO/runs" -w "$REPO" \
    "${ERIS_AGENT_IMAGE:-node:24-bookworm-slim}" \
    node --import tsx "$REPO/example/agents/runtime/bot.ts"
  exit $?
fi

# Image mode: remap the coordinator's host paths ($REPO/...) onto the image's /eris.
remap() { printf '%s' "${1/$REPO//eris}"; }
# Default to this team's own image (base + only their agent). The tag is the agent dir's basename, so
# build.sh team <id>, the ERIS_AGENT_DIR basename, and ERIS_AGENT_ID must all be the same <id>.
# Override with ERIS_AGENT_IMAGE.
IMG="${ERIS_AGENT_IMAGE:-eris-agent:$(basename "${ERIS_AGENT_DIR:?ERIS_AGENT_DIR is required in image mode (set it in the roster env)}")}"
MOUNTS=( -v "$REPO/runs:/eris/runs" )
ENVS=( -e "ERIS_RUN_DIR=$(remap "${ERIS_RUN_DIR:-$REPO/runs}")" )
[ -n "${ERIS_AGENT_DIR:-}" ] && ENVS+=( -e "ERIS_AGENT_DIR=$(remap "$ERIS_AGENT_DIR")" )
# The config is generated at run time and may not be baked in the image; mount the file in. The
# coordinator passes ERIS_CONFIG verbatim from --config, which is usually RELATIVE -- resolve it
# against $REPO first, because docker -v requires an absolute source path.
if [ -n "${ERIS_CONFIG:-}" ]; then
  case "$ERIS_CONFIG" in
    /*) CFG_HOST="$ERIS_CONFIG" ;;
    *)  CFG_HOST="$REPO/$ERIS_CONFIG" ;;
  esac
  CFG_IMG="$(remap "$CFG_HOST")"
  ENVS+=( -e "ERIS_CONFIG=$CFG_IMG" )
  MOUNTS+=( -v "$CFG_HOST:$CFG_IMG:ro" )
fi

supervise docker run "${CAPS[@]}" "${COMMON_ENV[@]}" "${ENVS[@]}" "${MOUNTS[@]}" "$IMG"
