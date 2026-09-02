#!/usr/bin/env bash
# Build the agent images.
#   build.sh base            -> eris-agent-base:local   (shared runtime, no team code)
#   build.sh team <agent-id> -> eris-agent:<agent-id>   (base + that one team's agent)
# Overrides: ERIS_BASE_IMAGE (base tag).
set -euo pipefail
REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BASE="${ERIS_BASE_IMAGE:-eris-agent-base:local}"
cd "$REPO"

build_base() { docker build -f infra/docker-agent/Dockerfile.base -t "$BASE" .; }

case "${1:-}" in
  base)
    build_base ;;
  team)
    id="${2:?usage: build.sh team <agent-id>}"
    docker image inspect "$BASE" >/dev/null 2>&1 || build_base
    docker build -f infra/docker-agent/Dockerfile.team \
      --build-arg BASE="$BASE" --build-arg AGENT_ID="$id" -t "eris-agent:$id" . ;;
  *)
    echo "usage: build.sh base | build.sh team <agent-id>" >&2; exit 1 ;;
esac
