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
# NOTE on isolation: the default --network host shares the host network, so nothing is contained.
# ERIS_AGENT_ISOLATE=1 gives each agent its own network with the RPC gateway as the hub, and
# ERIS_AGENT_INTERNAL=1 makes that network egress-free (see below and ISOLATION.md).
#
# Cleanup: this execs `docker run --rm`, which removes the container on graceful exit (the client
# forwards SIGTERM/SIGINT). The coordinator may SIGKILL this wrapper at run end (uncatchable, and
# there is no shell left after exec to trap it anyway) -- run reap.sh afterwards to sweep survivors.
set -euo pipefail

REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MEM="${ERIS_DOCKER_MEM:-4g}"
CPUS="${ERIS_DOCKER_CPUS:-2}"
NAME="eris-${ERIS_AGENT_ID:?ERIS_AGENT_ID is required (set by the coordinator)}"

# Agent-to-agent isolation (ISOLATION.md, verified): put each agent on its OWN docker network that
# only the hub also joins. Agents cannot reach each other (separate L2) and reach the chain only
# through the hub. Opt-in; needs the hub running as a bridge container.
#   ERIS_AGENT_HUB        the container agents may reach: default the RPC gateway, so they get the
#                         cheatcode filter + rate limit and cannot reach anvil directly
#                         (set ERIS_RPC_URL=http://<hub>:8546). ascon-anvil exposes anvil (no filter).
#   ERIS_AGENT_INTERNAL=1 create the network with --internal: no NAT, no egress at all. This is what
#                         makes rules §2.3 ("no direct external connection") true. Inference then goes
#                         through the operator's proxy (core/src/inference/proxy.ts), which has to be
#                         on the network too -- name its container in ERIS_INFERENCE_HUB and point
#                         ERIS_INFERENCE_BASE_URL at it. Unset = NAT egress (the 2026-09-04 own-LLM
#                         variant, kept as the verified fallback).
if [ "${ERIS_AGENT_ISOLATE:-0}" = "1" ]; then
  HUB_CT="${ERIS_AGENT_HUB:-ascon-rpc-gateway-live}"
  ISONET="ag-${ERIS_AGENT_ID}"
  if [ "${ERIS_AGENT_INTERNAL:-0}" = "1" ]; then
    docker network create --internal "$ISONET" >/dev/null 2>&1 || true
  else
    docker network create "$ISONET" >/dev/null 2>&1 || true
  fi
  docker network connect "$ISONET" "$HUB_CT" >/dev/null 2>&1 || true   # idempotent; hub multi-homes
  if [ -n "${ERIS_INFERENCE_HUB:-}" ]; then
    docker network connect "$ISONET" "$ERIS_INFERENCE_HUB" >/dev/null 2>&1 || true
  fi
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
# Every ERIS_* the coordinator set is forwarded by name, except the host paths each mode maps itself
# below (ERIS_RUN_DIR / ERIS_AGENT_DIR / ERIS_CONFIG) and ERIS_REPO. A fixed list here used to drop
# whatever the coordinator added later (the vulnerability factory, the market registry, the segment
# pointer, the liquidation victims), and an agent missing one of those fails quietly -- it reads an
# empty registry and an absent venue, which is exactly what a run where nobody deployed anything looks
# like. HOME=/tmp because the rootfs is read-only; NODE_ENV / REPORT_DIR are set by the coordinator
# for every child and the image has no useful default for either.
# Docker Desktop on macOS does not share the host's network namespace under --network host (a
# container's 127.0.0.1 is the container; measured ECONNREFUSED on 2026-09-07 while the same probe
# through host.docker.internal on the bridge answered eth_chainId). The agent's preflight then exits
# 1 on purpose. On Darwin, unless the operator named a network, use the bridge and point the
# loopback URLs the coordinator handed us at the host instead.
if [ "$(uname -s)" = "Darwin" ]; then
  : "${ERIS_AGENT_NET:=bridge}"
  for v in ERIS_RPC_URL ERIS_INFERENCE_BASE_URL; do
    val="${!v:-}"; [ -n "$val" ] || continue
    val="${val//127.0.0.1/host.docker.internal}"; val="${val//localhost/host.docker.internal}"
    export "$v=$val"
  done
fi
# A local venv path is not a container executable. Keep interpreter selection independent so
# exporting ERIS_PYTHON for local development does not break agent:selftest / Docker backtests.
COMMON_ENV=( -e HOME=/tmp -e NODE_ENV -e REPORT_DIR
  -e "ERIS_PYTHON=${ERIS_DOCKER_PYTHON:-python3}" )
while IFS= read -r name; do
  case "$name" in
    # ERIS_AGENT_STATE_DIR is a host path too (issue #77): the image maps it to /eris/state and the
    # bind mount keeps it where it is, so each mode sets it itself alongside the mount rather than
    # forwarding a path that does not exist inside the image.
    ERIS_RUN_DIR|ERIS_AGENT_DIR|ERIS_CONFIG|ERIS_REPO|ERIS_AGENT_STATE_DIR|ERIS_PYTHON) ;;
    *) COMMON_ENV+=( -e "$name" ) ;;
  esac
done < <(compgen -e | grep '^ERIS_' || true)
# Inference credentials reach the agent only when no inference proxy is named: with a proxy
# (ERIS_INFERENCE_BASE_URL) the keys live in the proxy and the agent holds a per-agent token instead.
if [ -z "${ERIS_INFERENCE_BASE_URL:-}" ]; then
  COMMON_ENV+=( -e OLLAMA_API_KEY -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e OPENAI_BASE_URL )
fi

# The narrowest directory the agent still needs write access to (issue #77).
#
# It used to be the whole of `runs/`, which is every run of every epoch: an agent could read another
# epoch's events.jsonl, and could keep its own state anywhere under it -- a carry-over path nobody
# designed, through the one mount that was meant for logs. Narrow it to the run the agent is
# actually in, and give persistence its own directory.
#
# When the period is segmented (ADR 0021 §6) the run directory rolls underneath a running agent and
# the pointer file naming the current segment lives one level up, so the competition directory is
# the narrowest mount that still works -- which means a segmented period *does* let an agent read
# the earlier segments of that period. That is a knowing trade: the alternative is a segment roll
# that writes into a directory the container cannot see, and the only thing that runs segmented is
# the practice devnet, which participants self-host anyway (ADR 0021). The live competition is one
# coordinator per epoch and takes the branch below.
# The coordinator passes ERIS_RUN_DIR verbatim from the config's reportDir, which every regime
# writes RELATIVE (`reportDir: ./runs`), and the process launches from the repo root. Resolve both
# run-dir variables against $REPO before they reach a mount or a remap: docker -v refuses a relative
# source ("mount path must be absolute"), and with 32 agents that was 32 exit-125s and a run that
# still completed and wrote summary.json as if it had been contested.
case "${ERIS_RUN_DIR:-}" in
  ""|/*) ;;
  *) export ERIS_RUN_DIR="$REPO/$ERIS_RUN_DIR" ;;
esac
case "${ERIS_RUN_DIR_POINTER:-}" in
  ""|/*) ;;
  *) export ERIS_RUN_DIR_POINTER="$REPO/$ERIS_RUN_DIR_POINTER" ;;
esac
if [ -n "${ERIS_RUN_DIR_POINTER:-}" ]; then
  LOG_HOST="$(dirname "$ERIS_RUN_DIR_POINTER")"
else
  LOG_HOST="${ERIS_RUN_DIR:-$REPO/runs}"
fi

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
  # The trap is installed *before* the container starts. Installing it after backgrounding leaves a
  # window in which a TERM terminates the wrapper normally and the container survives -- small, but
  # this whole function exists because of a window exactly that shape.
  trap stop TERM INT
  "$@" &
  CHILD=$!
  wait "$CHILD"
}

# Is the container gone? "yes" only when docker answered and said so. A daemon that will not answer
# is not evidence of absence, and treating it as such is how the container this function exists to
# remove ends up surviving it.
gone() {
  local out
  out=$(docker ps -q --filter "name=^${NAME}$" 2>/dev/null) || return 1
  [ -z "$out" ]
}

stop() {
  # Removal, then verification. A failed `docker rm -f` that is shrugged off leaves exactly the
  # container this handler exists to remove, so retry briefly and say so if it survives -- an agent
  # that outlives the run still holds its key and its RPC connection.
  for _ in 1 2 3; do
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    gone && break
    sleep 1
  done
  if ! gone; then
    echo "run-agent: could not confirm container $NAME is gone; it may still be running" >&2
  fi
  # CHILD is unset if the signal arrived before the container was backgrounded, which is exactly the
  # case the removal above covers.
  if [ -n "${CHILD:-}" ]; then
    kill "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
  exit 0
}

if [ "${ERIS_AGENT_BINDMOUNT:-0}" = "1" ]; then
  DEFAULT_BIND_IMAGE=node:24-bookworm-slim
  if [ -f "${ERIS_AGENT_DIR:-}/strategy.py" ]; then
    DEFAULT_BIND_IMAGE="${ERIS_BASE_IMAGE:-eris-agent-base:local}"
  fi
  # Bind-mount mode: same host path inside the container, so coordinator paths resolve as-is.
  BIND_MOUNTS=( -v "$REPO:$REPO:ro" -v "$LOG_HOST:$LOG_HOST" )
  BIND_ENVS=( -e ERIS_RUN_DIR -e ERIS_AGENT_DIR -e ERIS_CONFIG -e ERIS_RUN_DIR_POINTER )
  # Same host path inside the container, so the coordinator's paths resolve as-is -- including the
  # state directory, which the coordinator names per agent.
  if [ -n "${ERIS_AGENT_STATE_DIR:-}" ]; then
    mkdir -p "$ERIS_AGENT_STATE_DIR"
    BIND_MOUNTS+=( -v "$ERIS_AGENT_STATE_DIR:$ERIS_AGENT_STATE_DIR" )
    BIND_ENVS+=( -e ERIS_AGENT_STATE_DIR )
  fi
  supervise docker run "${CAPS[@]}" "${COMMON_ENV[@]}" \
    "${BIND_ENVS[@]}" \
    "${BIND_MOUNTS[@]}" -w "$REPO" --entrypoint node \
    "${ERIS_AGENT_IMAGE:-$DEFAULT_BIND_IMAGE}" \
    --import tsx "$REPO/example/agents/runtime/bot.ts"
  exit $?
fi

# Image mode: remap the coordinator's host paths ($REPO/...) onto the image's /eris.
remap() { printf '%s' "${1/$REPO//eris}"; }
# Default to this team's own image (base + only their agent). The tag is the agent dir's basename, so
# build.sh team <id>, the ERIS_AGENT_DIR basename, and ERIS_AGENT_ID must all be the same <id>.
# Override with ERIS_AGENT_IMAGE.
IMG="${ERIS_AGENT_IMAGE:-eris-agent:$(basename "${ERIS_AGENT_DIR:?ERIS_AGENT_DIR is required in image mode (set it in the roster env)}")}"
MOUNTS=( -v "$LOG_HOST:$(remap "$LOG_HOST")" )
ENVS=( -e "ERIS_RUN_DIR=$(remap "${ERIS_RUN_DIR:-$REPO/runs}")" )
[ -n "${ERIS_RUN_DIR_POINTER:-}" ] && ENVS+=( -e "ERIS_RUN_DIR_POINTER=$(remap "$ERIS_RUN_DIR_POINTER")" )
# Issue #77: one directory per agent, at a fixed path inside the container so a participant's
# runtime can hard-code it. It is the only writable place that outlives the epoch.
if [ -n "${ERIS_AGENT_STATE_DIR:-}" ]; then
  mkdir -p "$ERIS_AGENT_STATE_DIR"
  MOUNTS+=( -v "$ERIS_AGENT_STATE_DIR:/eris/state" )
  ENVS+=( -e "ERIS_AGENT_STATE_DIR=/eris/state" )
fi
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
