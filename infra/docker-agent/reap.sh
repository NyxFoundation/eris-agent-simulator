#!/usr/bin/env bash
# Force-remove any eris agent containers left running, and clean up per-agent isolation networks
# (ISOLATION.md). run-agent.sh execs `docker run --rm`, which removes the container on graceful exit,
# but the coordinator can SIGKILL the wrapper (uncatchable), leaving a detached --rm container and its
# ag-<id> network with only anvil still attached. Run this after a sim to sweep survivors. Idempotent.
set -euo pipefail
HUB_CT="${ERIS_AGENT_HUB:-ascon-rpc-gateway-live}"

survivors=$(docker ps -aq --filter "name=^eris-" 2>/dev/null || true)
if [ -n "$survivors" ]; then
  echo "reaping $(echo "$survivors" | wc -l) container(s)..."
  docker rm -f $survivors >/dev/null 2>&1 || true
fi

# Remove per-agent isolation networks that have no agent container left (only anvil, or empty).
cleaned=0
for net in $(docker network ls --format '{{.Name}}' | grep -E '^ag-' || true); do
  others=$(docker network inspect "$net" --format '{{range .Containers}}{{.Name}}
{{end}}' 2>/dev/null | grep -vE "^$HUB_CT$" | grep -cv '^$' || true)
  if [ "${others:-0}" -eq 0 ]; then
    docker network disconnect -f "$net" "$HUB_CT" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 && cleaned=$((cleaned+1)) || true
  fi
done
echo "done; remaining containers: $(docker ps -aq --filter "name=^eris-" | wc -l), isolation nets removed: $cleaned"
