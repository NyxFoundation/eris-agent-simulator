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
# Caps default to what the competition rules promise a participant: 4 GiB / 2 vCPU
# (ERIS_DOCKER_MEM / ERIS_DOCKER_CPUS). --memory-swap is pinned to --memory so the limit is a hard
# ceiling (over-budget agents OOM-kill instead of swapping).
#
# The defaults used to be 1 GiB / 0.5 vCPU, which is a quarter of the promise on both axes. That is
# the wrong direction to be wrong in twice over: an agent sized against the published budget gets
# OOM-killed here (code 137, which the coordinator reports as an early exit), and a participant
# self-testing with this script -- which is what it is for -- tunes against a budget they were never
# held to. The headroom is nominal, not reserved: 100 containers measured ~19 GB of host memory in
# total (~190 MiB each), so raising the ceiling costs nothing until an agent actually misbehaves.
#
# NOTE on isolation: --network host means the container shares the host network, so run-time egress
# is NOT contained here -- it must be enforced by the operator's host/network policy. See README.
#
# Cleanup: this execs `docker run --rm`, which removes the container on graceful exit (the client
# forwards SIGTERM/SIGINT). The coordinator may SIGKILL this wrapper at run end (uncatchable, and
# there is no shell left after exec to trap it anyway) -- run reap.sh afterwards to sweep survivors.
set -euo pipefail

REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MEM="${ERIS_DOCKER_MEM:-4g}"
CPUS="${ERIS_DOCKER_CPUS:-2}"
NAME="eris-${ERIS_AGENT_ID:?ERIS_AGENT_ID is required (set by the coordinator)}"

# The network the container joins. `host` shares the host's (no egress control); the operator's
# internal network -- with the RPC gateway and the inference proxy attached to it -- is what makes
# rules §2.3's "no direct external connection" true.
NET="${ERIS_AGENT_NETWORK:-host}"
# Shared cap/runtime flags, so the two modes cannot drift.
CAPS=( --rm --network "$NET" --name "$NAME" --memory="$MEM" --memory-swap="$MEM" --cpus="$CPUS" )

# Env forwarded by name. Two are silent if lost under command-override:
#   ERIS_AGENT_DIR    -- command-override skips the directory convention; set it in the roster env:.
#   ERIS_LOCAL_DEPLOY -- from the operator process env; without it constants.local is ignored and
#                        Multicall3 + every venue address fall back to the fork chain, so all reads
#                        and tx builds fail while docker stats still looks healthy.
# Every ERIS_* the coordinator set is forwarded by name, except the three host paths that each
# mode maps itself below (ERIS_RUN_DIR / ERIS_AGENT_DIR / ERIS_CONFIG) and ERIS_REPO. A fixed list
# here used to drop whatever the coordinator added later (the vulnerability factory, the segment
# pointer, the liquidation victims), and an agent missing one of those fails quietly.
COMMON_ENV=()
while IFS= read -r name; do
  case "$name" in
    ERIS_RUN_DIR|ERIS_AGENT_DIR|ERIS_CONFIG|ERIS_REPO) ;;
    *) COMMON_ENV+=( -e "$name" ) ;;
  esac
done < <(compgen -e | grep '^ERIS_' || true)
# Inference credentials reach the agent only when no inference proxy is named: with a proxy
# (ERIS_INFERENCE_BASE_URL) the keys live in the proxy and the agent holds a per-agent token instead.
if [ -z "${ERIS_INFERENCE_BASE_URL:-}" ]; then
  COMMON_ENV+=( -e OLLAMA_API_KEY -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e OPENAI_BASE_URL )
fi

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
