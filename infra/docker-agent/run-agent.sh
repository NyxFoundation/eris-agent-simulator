#!/usr/bin/env bash
# Run ONE eris agent (example/agents/runtime/bot.ts) inside a memory/CPU-capped Docker container.
#
# Intended as an AgentSpec.command target so the operator can run each submitted agent isolated
# (the autonomous-container execution form): the coordinator sets up the chain, funds the wallet
# and drives the run exactly as before, but the agent process itself runs in a capped container.
#
# The container image is stock node:24 with the repo bind-mounted -- the repo's tsx/esbuild is
# statically linked, so no image build is needed. For production with per-team code, bake a
# per-team image instead and point IMAGE at it; the env contract below is identical.
#
# Resource caps default to 1 GiB / 0.5 vCPU. Measured footprint of a reference agent (venue-arb,
# with or without the LLM improve loop) is ~130-170 MiB RSS -- inference runs off-container via the
# LLM provider, so memory does not depend on LLM activity. 100 such containers ran on-budget at a
# 4 s block time on a 16-core / 187 GB host (see the load-test notes).
set -euo pipefail

REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
IMAGE="${ERIS_AGENT_IMAGE:-node:24-bookworm-slim}"
MEM="${ERIS_DOCKER_MEM:-1g}"
CPUS="${ERIS_DOCKER_CPUS:-0.5}"
NAME="eris-${ERIS_AGENT_ID:?ERIS_AGENT_ID is required (set by the coordinator)}"

# Reaper for the signals we can catch. NOTE: the coordinator may SIGKILL this wrapper at run end,
# which is uncatchable and leaves a detached --rm container running; run reap.sh after the sim to
# sweep any survivors by name prefix. This trap covers graceful SIGTERM/SIGINT and normal exit.
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# Env contract. RPC / key / address / run dir / run id are injected by the coordinator's process
# env and forwarded by name. Two are easy to lose under command-override and both are silent:
#   ERIS_AGENT_DIR    -- command-override skips the directory-convention path, so set it in the
#                        agent's roster `env:` (e.g. env: { ERIS_AGENT_DIR: "<repo>/example/agents/<id>" }).
#   ERIS_LOCAL_DEPLOY -- comes from the operator's process env; without it sdk/src/constants.ts
#                        ignores constants.local and Multicall3 + every venue/token address fall
#                        back to the wrong (fork) chain, so every read and tx build fails while
#                        `docker stats` still looks healthy.
exec docker run --rm --network host --name "$NAME" \
  --memory="$MEM" --memory-swap="$MEM" --cpus="$CPUS" \
  -e ERIS_AGENT_ID -e ERIS_RPC_URL -e ERIS_AGENT_ADDRESS -e ERIS_AGENT_PRIVATE_KEY \
  -e ERIS_PRICE_FEED_ADDRESS -e ERIS_RUN_ID -e ERIS_RUN_DIR -e ERIS_AGENT_DIR \
  -e ERIS_RUN_BLOCKS -e ERIS_AGENT_FROZEN -e ERIS_LLM_MODEL -e ERIS_LOCAL_DEPLOY \
  -e ERIS_CONFIG -e ERIS_OLLAMA_BASE_URL -e ERIS_OLLAMA_API_KEY -e OLLAMA_API_KEY \
  -e ANTHROPIC_API_KEY \
  -v "$REPO:$REPO:ro" -v "$REPO/runs:$REPO/runs" -w "$REPO" \
  "$IMAGE" \
  node --import tsx "$REPO/example/agents/runtime/bot.ts"
