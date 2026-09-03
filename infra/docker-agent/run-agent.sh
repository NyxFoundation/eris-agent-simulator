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

# Shared cap/runtime flags, so the two modes cannot drift.
CAPS=( --rm --network host --name "$NAME" --memory="$MEM" --memory-swap="$MEM" --cpus="$CPUS" )

# Env forwarded by name. Two are silent if lost under command-override:
#   ERIS_AGENT_DIR    -- command-override skips the directory convention; set it in the roster env:.
#   ERIS_LOCAL_DEPLOY -- from the operator process env; without it constants.local is ignored and
#                        Multicall3 + every venue address fall back to the fork chain, so all reads
#                        and tx builds fail while docker stats still looks healthy.
COMMON_ENV=(
  -e ERIS_AGENT_ID -e ERIS_RPC_URL -e ERIS_AGENT_ADDRESS -e ERIS_AGENT_PRIVATE_KEY
  -e ERIS_PRICE_FEED_ADDRESS -e ERIS_RUN_ID -e ERIS_RUN_BLOCKS -e ERIS_AGENT_FROZEN
  -e ERIS_LLM_MODEL -e ERIS_LOCAL_DEPLOY -e ERIS_OLLAMA_BASE_URL -e ERIS_OLLAMA_API_KEY
  -e OLLAMA_API_KEY -e ANTHROPIC_API_KEY
)

if [ "${ERIS_AGENT_BINDMOUNT:-0}" = "1" ]; then
  # Bind-mount mode: same host path inside the container, so coordinator paths resolve as-is.
  exec docker run "${CAPS[@]}" "${COMMON_ENV[@]}" \
    -e ERIS_RUN_DIR -e ERIS_AGENT_DIR -e ERIS_CONFIG \
    -v "$REPO:$REPO:ro" -v "$REPO/runs:$REPO/runs" -w "$REPO" \
    "${ERIS_AGENT_IMAGE:-node:24-bookworm-slim}" \
    node --import tsx "$REPO/example/agents/runtime/bot.ts"
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

exec docker run "${CAPS[@]}" "${COMMON_ENV[@]}" "${ENVS[@]}" "${MOUNTS[@]}" "$IMG"
