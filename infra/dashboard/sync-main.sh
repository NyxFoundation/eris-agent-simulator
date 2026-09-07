#!/usr/bin/env bash
# Keep the hosted dashboard on main.
#
# The dashboard container (infra/monitoring/docker-compose.yml, `ascon-dashboard`) mounts this
# checkout read-only and serves `dashboard/dist` and `runs/` out of it. So "deploy" is a build, not a
# release: fast-forward the checkout, rebuild the bundle, and the next request gets the new one. The
# container is never restarted -- it opens both directories per request and holds nothing.
#
# Run by `eris-dashboard-sync.timer` (see README.md), and safe to run by hand.
#
# What it will not do:
#   - merge. `--ff-only`, so a checkout with local commits stops and says so rather than being
#     rewritten under a running competition
#   - build over a dirty tree. A half-finished edit on the box is somebody's work in progress
#   - rebuild when nothing moved. The bundle is content-hashed; rebuilding it for the same commit
#     changes the file the browser is holding for no reason
set -euo pipefail
REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO"

say() { printf '[dashboard-sync] %s\n' "$*"; }

# Untracked files are fine (a scratch config, a run in progress writing under runs/); modified
# tracked files are not, because the build would ship them.
if ! git diff --quiet; then
  say "tracked files are modified in $REPO -- not building. \`git status\` on the box."
  exit 0
fi

before="$(git rev-parse HEAD)"
git fetch --quiet origin main
if ! git merge-base --is-ancestor "$before" origin/main; then
  say "HEAD is not an ancestor of origin/main (local commits, or a force-push) -- not pulling."
  exit 0
fi
git merge --ff-only --quiet origin/main
after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  say "already at ${after:0:8}; nothing to build"
  exit 0
fi

say "$(git log --oneline -1 --format='%h %s' "$before")  ->  $(git log --oneline -1 --format='%h %s')"
npm run dashboard:build
say "built dashboard/dist at ${after:0:8}"
