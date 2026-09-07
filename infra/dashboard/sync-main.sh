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
#   - rebuild when the bundle already matches HEAD. It is content-hashed, so rebuilding for the
#     same commit changes the file every open browser is holding, for no reason
set -euo pipefail
REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO"

say() { printf '[dashboard-sync] %s\n' "$*"; }

pull() {
  # Untracked files are fine (a scratch config, a run in progress writing under runs/); modified
  # tracked files are not, because the build would ship them.
  if ! git diff --quiet; then
    say "tracked files are modified in $REPO -- not building. \`git status\` on the box."
    return 1
  fi

  local before
  before="$(git rev-parse HEAD)"
  git fetch --quiet origin main
  if ! git merge-base --is-ancestor "$before" origin/main; then
    say "HEAD is not an ancestor of origin/main (local commits, or a force-push) -- not pulling."
    return 1
  fi
  git merge --ff-only --quiet origin/main
  local head
  head="$(git rev-parse HEAD)"
  [ "$before" = "$head" ] ||
    say "$(git log --oneline -1 --format='%h %s' "$before")  ->  $(git log --oneline -1 --format='%h %s')"
}

build() {
  # What decides a build is the bundle, not what the pull did: "did HEAD move on this run" would skip
  # a commit somebody had already pulled by hand, and leave the box serving an older page with no way
  # back to a build except noticing. The stamp lives inside dist/ so it cannot outlive what it
  # describes -- `vite build` empties that directory, and a missing stamp means "build".
  local head built stamp="dashboard/dist/.built-at"
  head="$(git rev-parse HEAD)"
  built="$(cat "$stamp" 2>/dev/null || true)"
  if [ "$built" = "$head" ] && [ -f dashboard/dist/index.html ]; then
    say "dist is already at ${head:0:8}; nothing to build"
    return 0
  fi
  npm run dashboard:build
  printf '%s\n' "$head" > "$stamp"
  say "built dashboard/dist at ${head:0:8}${built:+ (was ${built:0:8})}"
}

# The pull can rewrite this very file, and bash reads a script as it executes: carrying on here would
# run the tail of the *new* file from the *old* byte offset, which is how a shell script ends up
# executing half a line. So the two halves are two processes -- the pull, then a handover to whatever
# version of the script that pull produced.
if [ "${ERIS_SYNC_PHASE:-pull}" = "pull" ]; then
  pull || exit 0
  ERIS_SYNC_PHASE=build exec "$REPO/infra/dashboard/sync-main.sh"
fi
build
