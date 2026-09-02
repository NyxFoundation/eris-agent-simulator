#!/usr/bin/env bash
# Force-remove any eris agent containers left running. run-agent.sh reaps on graceful signals, but
# the coordinator can SIGKILL the wrapper at run end (uncatchable), leaving a detached --rm
# container. Run this after a sim to sweep survivors. Idempotent.
set -euo pipefail
survivors=$(docker ps -aq --filter "name=eris-" 2>/dev/null || true)
if [ -z "$survivors" ]; then echo "no eris- containers to reap"; exit 0; fi
echo "reaping $(echo "$survivors" | wc -l) container(s)..."
docker rm -f $survivors >/dev/null 2>&1 || true
echo "done; remaining: $(docker ps -aq --filter "name=eris-" | wc -l)"
