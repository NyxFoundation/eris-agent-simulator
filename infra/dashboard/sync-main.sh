#!/usr/bin/env bash
# Keep the hosted dashboard at the commit the operator pinned.
#
# The dashboard container (infra/monitoring/docker-compose.yml, `ascon-dashboard`) mounts this
# checkout read-only and serves `dashboard/dist` and `runs/` out of it. So "deploy" is a build, not a
# release: put the chosen commit in the checkout, rebuild the bundle, and the next request gets the
# new one. The container is never restarted -- it opens both directories per request and holds
# nothing.
#
# Run by `eris-dashboard-sync.timer` (see README.md), and safe to run by hand.
#
#   sync-main.sh                  one tick: check out the configured ref if it moved, build if stale
#   sync-main.sh promote <ref>    pin a tag or commit in sync.env, then run one tick
#
# Which commit is built is decided by `infra/dashboard/sync.env` (ERIS_SYNC_* only; the environment
# wins over the file), three modes, logged on every tick:
#
#   ERIS_SYNC_REF=<tag|sha>        pinned. The ref is resolved, REFUSED unless it is an ancestor of
#                                  origin/main, and only then checked out (detached). Nothing moves
#                                  until the operator promotes another ref. The mode for a live week
#   (neither set)                  held. No fetch, no checkout: the box stays at whatever HEAD is,
#                                  and builds it if dist is stale. What a fresh install is in until
#                                  something is promoted
#   ERIS_SYNC_FOLLOW_BRANCH=main   following. Fast-forward to the branch tip on every tick. This is
#                                  the pre-#211 behaviour and it is now an OPT-IN: whatever lands on
#                                  that branch is checked out, and its build config (vite.config.ts
#                                  and everything it imports) is executed on this box within five
#                                  minutes
#
# Why this is worth a mode (issue #211): `vite build` evaluates dashboard/vite.config.ts, and this
# checkout sits next to .env.local (role keys), .env.practice (the period's seed), infra/monitoring/
# .env (ANVIL_MNEMONIC) and the keys directory. A build that follows main runs every commit on main
# with those in reach, review or no review. Two lines of defence, independent of each other:
#   1. the pin above: which commit runs here is a decision somebody makes, not a timer
#   2. the build runs in a container (ERIS_SYNC_BUILD=container, the default) that sees a clean
#      export of the pinned commit, this checkout's node_modules read-only, and nothing else: no
#      network, no .env*, no keys, no runs/. ERIS_SYNC_BUILD=host is the old in-place build, an
#      opt-in that is logged as such
#
# What it will not do:
#   - merge. `--ff-only` in following mode, `checkout --detach` in pinned mode: a checkout with local
#     commits stops and says so rather than being rewritten under a running competition
#   - build over a dirty tree. A half-finished edit on the box is somebody's work in progress
#   - rebuild when the bundle already matches HEAD. It is content-hashed, so rebuilding for the
#     same commit changes the file every open browser is holding, for no reason
#   - replace dist with a failed build. The container builds into a scratch export and dist is
#     swapped in only once index.html exists; the previous bundle keeps serving until then
#   - run code it did not start with. This file lives in the tree it syncs, so a checkout can
#     rewrite it mid-run. The whole script is one function, parsed before anything executes, and
#     there is no re-exec: a tick runs to the end on the version it started with, and the version
#     at the new commit governs from the next tick. (The pre-#211 script handed over to the freshly
#     pulled file with ERIS_SYNC_PHASE=build; that env var is still honoured, once, for the tick that
#     installs this version.)
set -euo pipefail
REPO="${ERIS_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO"
SELF="$REPO/infra/dashboard/sync-main.sh"
ENV_FILE="${ERIS_SYNC_ENV_FILE:-$REPO/infra/dashboard/sync.env}"
WORK=""

say() { printf '[dashboard-sync] %s\n' "$*"; }
die() { say "$*"; exit 1; }
# shellcheck disable=SC2329  # invoked by the trap
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT

# sync.env is KEY=VALUE lines, ERIS_SYNC_* only, no shell: it is read by this script alone (the unit
# does not EnvironmentFile= it), so a hand run and a timer run see the same thing. A variable already
# in the environment wins, which is how `ERIS_SYNC_REF=v1 sync-main.sh` tries a ref without editing
# the file.
load_env_file() {
  local line key val
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '' | '#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    if ! [[ "$line" == *=* && "$key" =~ ^ERIS_SYNC_[A-Z_]+$ ]]; then
      say "ignoring '$line' in $ENV_FILE (KEY=VALUE lines, ERIS_SYNC_* only)"
      continue
    fi
    [ -n "${!key:-}" ] || export "$key=$val"
  done < "$ENV_FILE"
}

# A ref is a tag or a commit name, nothing that git could read as an option.
valid_ref() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; }

# The commit a sha or a tag names -- and only those two forms. A branch name, FETCH_HEAD or
# origin/main would resolve too, and quietly turn "pinned" into "following" under the wrong log
# line. A tag that is not local yet is fetched by name; a tag that is local is used as is (a tag
# rewritten upstream is not followed -- repin a sha to move).
resolve_ref() {
  local ref="$1" sha
  if [[ "$ref" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    sha="$(git rev-parse --verify --quiet "${ref}^{commit}")" || return 1
  else
    git show-ref --verify --quiet "refs/tags/$ref" ||
      git fetch --quiet origin "refs/tags/$ref:refs/tags/$ref" 2>/dev/null || true
    sha="$(git rev-parse --verify --quiet "refs/tags/${ref}^{commit}")" || return 1
  fi
  printf '%s\n' "$sha"
}

# resolve_ref's stdout is the sha, so the explanation of a failure has to come from the caller --
# and from the main shell: a `die` inside `$(...)` ends the subshell and becomes the captured text.
unresolvable() {
  die "cannot resolve '$1': a pin is a commit sha (7-40 hex) or a tag on origin, and this is neither. A branch name? Following one is ERIS_SYNC_FOLLOW_BRANCH=$1, and it is loud for a reason."
}

# What a pin has to pass before anything is checked out.
#   1. the commit went through main. Everything the box runs is then something that was merged
#      there, whatever the branch protection on main is (README.md says what it is, and that this
#      check is the only line if it is nothing)
#   2. the commit carries this script. The timer runs sync-main.sh FROM THE CHECKOUT, so pinning a
#      commit older than the pin would put the pre-#211 script back on the timer, and its next tick
#      would fast-forward to main and build on the host -- the pin undoing itself
verify_pin() {
  local ref="$1" sha="$2" script
  git merge-base --is-ancestor "$sha" origin/main ||
    die "REFUSED: $ref (${sha:0:12}) is not an ancestor of origin/main. A pin names a commit that went through main; this one did not (or main was rewritten). Not checking out."
  # Read the blob into a variable rather than piping it into `grep -q`. Under `pipefail` that pipe
  # refuses the commit whenever grep matches and exits before git has finished writing: git takes
  # SIGPIPE, the pipeline reports 141, and the operator is told the pin "predates the pinned sync"
  # -- about a commit that carries it. This file is past the pipe buffer, so the match is in the
  # first chunk and the rest of the write has nowhere to go; measured 200/200 refusals on a blob of
  # 200 KB and intermittently on this one. A missing path leaves the variable empty, which is the
  # same answer for the same reason: no script, no pin.
  script="$(git show "$sha:infra/dashboard/sync-main.sh" 2>/dev/null || true)"
  case "$script" in
    *ERIS_SYNC_REF*) ;;
    *) die "REFUSED: $ref (${sha:0:12}) predates the pinned sync (issue #211). Its infra/dashboard/sync-main.sh follows main, and the timer runs the script from the checkout: the tick after this one would undo the pin. Pin a commit that has #211." ;;
  esac
}

clean_tree() {
  # Untracked files are fine (a scratch config, a run in progress writing under runs/); modified
  # tracked files are not, because the build would ship them.
  if ! git diff --quiet; then
    say "tracked files are modified in $REPO -- not building. \`git status\` on the box."
    return 1
  fi
}

# Checked up front, in the main shell: a `die` inside `$(mode)` would end only the subshell, and
# the tick would carry on into a build with no mode line at all.
check_config() {
  if [ -n "${ERIS_SYNC_REF:-}" ] && [ -n "${ERIS_SYNC_FOLLOW_BRANCH:-}" ]; then
    die "both ERIS_SYNC_REF and ERIS_SYNC_FOLLOW_BRANCH are set in $ENV_FILE or the environment -- pick one"
  fi
  case "${ERIS_SYNC_BUILD:-container}" in
    container | host) ;;
    *) die "ERIS_SYNC_BUILD='$ERIS_SYNC_BUILD' is neither 'container' (default) nor 'host'" ;;
  esac
}

mode() {
  if [ -n "${ERIS_SYNC_FOLLOW_BRANCH:-}" ]; then echo following
  elif [ -n "${ERIS_SYNC_REF:-}" ]; then echo pinned
  else echo held
  fi
}

# Puts the configured commit in the checkout. Returns 1 when there is nothing to do (said why).
# Called as `checkout_configured || return 0`, which switches errexit OFF inside it: every git
# command that can fail says so explicitly, or the tick would carry on with a stale origin/main.
checkout_configured() {
  local before target branch
  before="$(git rev-parse HEAD)"
  case "$(mode)" in
    held)
      say "held at HEAD ${before:0:12} ($(git log -1 --format=%s)): no ERIS_SYNC_REF in $ENV_FILE, nothing is fetched. To move: $SELF promote <tag|sha>"
      ;;
    pinned)
      valid_ref "$ERIS_SYNC_REF" || die "ERIS_SYNC_REF='$ERIS_SYNC_REF' is not a tag or commit name"
      git fetch --quiet origin main || die "git fetch origin main failed -- not checking anything out against a stale origin/main"
      target="$(resolve_ref "$ERIS_SYNC_REF")" || unresolvable "$ERIS_SYNC_REF"
      verify_pin "$ERIS_SYNC_REF" "$target"
      say "pinned to $ERIS_SYNC_REF = ${target:0:12} ($(git log -1 --format=%s "$target"))"
      if [ "$target" != "$before" ]; then
        git checkout --quiet --detach "$target" || die "git checkout --detach ${target:0:12} failed (untracked files in the way? \`git status\` on the box)"
        say "$(git log --oneline -1 --format='%h %s' "$before")  ->  $(git log --oneline -1 --format='%h %s')"
      fi
      ;;
    following)
      branch="$ERIS_SYNC_FOLLOW_BRANCH"
      valid_ref "$branch" || die "ERIS_SYNC_FOLLOW_BRANCH='$branch' is not a branch name"
      say "FOLLOWING origin/$branch (ERIS_SYNC_FOLLOW_BRANCH): every commit that lands there is checked out and its build config executed on this box within one timer tick, reviewed or not. Unset it and promote a ref to pin."
      git fetch --quiet origin "$branch" || die "git fetch origin $branch failed -- not pulling against a stale origin/$branch"
      if ! git merge-base --is-ancestor "$before" "origin/$branch"; then
        say "HEAD is not an ancestor of origin/$branch (local commits, or a force-push) -- not pulling."
        return 1
      fi
      git merge --ff-only --quiet "origin/$branch" || die "git merge --ff-only origin/$branch failed"
      target="$(git rev-parse HEAD)"
      [ "$before" = "$target" ] ||
        say "$(git log --oneline -1 --format='%h %s' "$before")  ->  $(git log --oneline -1 --format='%h %s')"
      ;;
    *) die "unreachable: mode '$(mode)'" ;;
  esac
}

build_on_host() {
  say "building on the HOST (ERIS_SYNC_BUILD=host): \`npm run dashboard:build\` runs as $(id -un) in $REPO, with everything this user can read in reach"
  if [ -n "${ERIS_SYNC_DRY_RUN:-}" ]; then
    say "dry run: would run \`npm run dashboard:build\` here"
    return 0
  fi
  npm run dashboard:build || die "the host build failed (above)"
}

# The build sees: a clean `git archive` of the commit (tracked files only -- so no .env.local, no
# .env.practice, no runs/, no state dump), this checkout's node_modules read-only (npm install is
# not part of a sync, so the box's lockfile-resolved tree is what gets used), and
# dashboard/.env.production.local if it exists (the explorer URL vite compiles into the bundle,
# README.md "Explorer links" -- the one untracked input the build has). No network. The host user's
# uid, so what comes out is owned like everything else in the checkout.
build_in_container() {
  local head="$1" image="${ERIS_SYNC_BUILD_IMAGE:-node:24-bookworm-slim}" nm
  local -a mounts cmd
  command -v docker >/dev/null 2>&1 ||
    die "docker is not on PATH, and ERIS_SYNC_BUILD is not 'host'. Install docker, or opt into the in-place build with ERIS_SYNC_BUILD=host (it runs the build with this user's files in reach)."
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
    die "the docker daemon is not answering ($(id -un) in the docker group? \`docker version\` says what). ERIS_SYNC_BUILD=host opts into the in-place build instead."
  [ -d "$REPO/node_modules" ] || die "$REPO/node_modules is missing -- \`npm ci\` on the box first; the sync never installs"

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/eris-dashboard-build.XXXXXX")"
  git archive --format=tar "$head" | tar -xf - -C "$WORK"
  if [ -f dashboard/.env.production.local ]; then cp dashboard/.env.production.local "$WORK/dashboard/"; fi

  # dashboard/node_modules is copied, not mounted read-only: `vite build` bundles vite.config.ts and
  # writes the bundle into `.vite-temp` inside the *nearest* node_modules, which for
  # dashboard/vite.config.ts is dashboard/node_modules. Vite falls back to another directory only
  # when creating `.vite-temp` is refused; where the directory already exists -- which is the state
  # of a box that has built in place before -- the write itself throws and the config never loads.
  # It is ~7 MB here (nested only because the root asks for @types/node 24 and the dashboard for
  # 26). `.vite-temp` / `.vite` are dropped from the copy so no stale bundle is reused. The root
  # node_modules stays read-only: it is large and nothing writes into it.
  mounts=( -v "$WORK:/build" )
  for nm in node_modules core/node_modules sdk/node_modules; do
    if [ -d "$REPO/$nm" ]; then mounts+=( -v "$REPO/$nm:/build/$nm:ro" ); fi
  done
  # Refused rather than skipped when it is absent. The only reason dashboard/node_modules exists is
  # that the root asks for @types/node ^24 and the dashboard for ^26, so npm cannot hoist it; raise
  # the root to ^26 and it disappears. Then the nearest node_modules to dashboard/vite.config.ts is
  # the root one, which is mounted read-only, and the build goes back to the failure this copy
  # exists to avoid -- silently, because `if [ -d ]` alone would just not copy. A build that cannot
  # be done correctly should say so, not produce a stale dist for five minutes at a time.
  if [ -d "$REPO/dashboard/node_modules" ]; then
    cp -a "$REPO/dashboard/node_modules" "$WORK/dashboard/node_modules" ||
      die "could not copy dashboard/node_modules into the build export"
    rm -rf "$WORK/dashboard/node_modules/.vite-temp" "$WORK/dashboard/node_modules/.vite"
  else
    die "$REPO/dashboard/node_modules is missing. The container build needs a writable node_modules next to dashboard/vite.config.ts, because \`vite build\` writes the bundled config into its .vite-temp; with only the read-only root one in reach the build fails at config load. Run \`npm ci\` on the box (it creates this directory while the root and the dashboard disagree on @types/node), or build with ERIS_SYNC_BUILD=host."
  fi

  # Same hardening as infra/docker-agent/run-agent.sh where it applies: non-root, no privilege
  # escalation, read-only rootfs with a tmpfs /tmp (npm's cache and logs go there via HOME), a pid
  # cap, tini as PID 1 so a timeout's SIGTERM reaches npm. --network none is new here: the build has
  # nothing to fetch. --cap-drop ALL is fine for a non-root user (it holds no capability anyway).
  cmd=( docker run --rm --init --network none --read-only --tmpfs "/tmp:rw,size=1g,mode=1777"
        --user "$(id -u):$(id -g)" --security-opt no-new-privileges --cap-drop ALL
        --pids-limit "${ERIS_SYNC_BUILD_PIDS:-512}" --label eris.role=dashboard-build
        -e HOME=/tmp -e CI=1 -e npm_config_update_notifier=false
        "${mounts[@]}" -w /build "$image" npm run dashboard:build )
  say "building ${head:0:12} in $image (--network none, export of the commit + the root node_modules:ro, nothing else mounted)"
  if [ -n "${ERIS_SYNC_DRY_RUN:-}" ]; then
    say "dry run: would run: ${cmd[*]}"
    return 0
  fi
  "${cmd[@]}" || die "the build in $image failed (above); dist is left as it was and the next tick retries"
  [ -f "$WORK/dashboard/dist/index.html" ] ||
    die "the build produced no dashboard/dist/index.html; dist is left as it was"

  # Swap, not overwrite: the serving container reads dist per request, and `vite build` in place
  # empties the directory first -- a failed build used to leave nothing to serve.
  rm -rf dashboard/dist.new dashboard/dist.old
  cp -a "$WORK/dashboard/dist" dashboard/dist.new
  if [ -d dashboard/dist ]; then mv dashboard/dist dashboard/dist.old; fi
  mv dashboard/dist.new dashboard/dist
  rm -rf dashboard/dist.old
}

build() {
  # What decides a build is the bundle, not what the checkout did: "did HEAD move on this run" would
  # skip a commit somebody had already checked out by hand, and leave the box serving an older page
  # with no way back to a build except noticing. The stamp lives inside dist/ so it cannot outlive
  # what it describes -- a build replaces that directory, and a missing stamp means "build".
  local head built stamp="dashboard/dist/.built-at"
  head="$(git rev-parse HEAD)"
  built="$(cat "$stamp" 2>/dev/null || true)"
  if [ "$built" = "$head" ] && [ -f dashboard/dist/index.html ]; then
    say "dist is already at ${head:0:12}; nothing to build"
    return 0
  fi
  case "${ERIS_SYNC_BUILD:-container}" in
    container) build_in_container "$head" ;;
    host) build_on_host ;;
    *) die "unreachable: ERIS_SYNC_BUILD='$ERIS_SYNC_BUILD' (check_config)" ;;
  esac
  if [ -n "${ERIS_SYNC_DRY_RUN:-}" ]; then return 0; fi
  printf '%s\n' "$head" > "$stamp"
  # The same commit, plus when it was built, where something outside the box can read it:
  # dashboard/server/serve.ts reports it on /healthz (alongside the value it read when the serving
  # process started), and dist/ is served as files, so `curl .../.build-info.json` works too. Without
  # it a forgotten `promote` and a sync that stopped three days ago look exactly like a box that is
  # up to date -- `{"ok":true}` either way. The repo is public, so a commit sha discloses nothing
  # that a reader could not already clone; the pin's *name* is deliberately not written here, since a
  # tag can say more about the operator's plans than a sha does. `.built-at` stays the file the
  # build-skip compares against: every tick reads it, the journal names it, and a second source of
  # truth for "which commit is in dist" is how the two drift.
  printf '{"commit":"%s","builtAt":"%s"}\n' "$head" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > dashboard/dist/.build-info.json
  say "built dashboard/dist at ${head:0:12}${built:+ (was ${built:0:12})}"
}

tick() {
  check_config
  clean_tree || return 0
  checkout_configured || return 0
  build
}

# `sync-main.sh promote <tag|sha>`: the manual step that moves the box. Verifies the ref the same way
# a tick does, writes it to sync.env (replacing any ERIS_SYNC_FOLLOW_BRANCH -- promoting is choosing
# a commit, and that is the opposite of following), then runs one tick so the change is live now and
# not at the next timer boundary.
promote() {
  local ref="$1" sha tmp
  valid_ref "$ref" || die "'$ref' is not a tag or commit name"
  git fetch --quiet origin main || die "git fetch origin main failed -- not promoting against a stale origin/main"
  sha="$(resolve_ref "$ref")" || unresolvable "$ref"
  verify_pin "$ref" "$sha"
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  {
    if [ -f "$ENV_FILE" ]; then grep -v -E '^[[:space:]]*(ERIS_SYNC_REF|ERIS_SYNC_FOLLOW_BRANCH)=' "$ENV_FILE" || true; fi
    printf '# promoted %s by %s: %s = %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(id -un)" "$ref" "$sha"
    printf 'ERIS_SYNC_REF=%s\n' "$ref"
  } > "$tmp"
  mv "$tmp" "$ENV_FILE"
  say "pinned $ref = ${sha:0:12} in $ENV_FILE"
  export ERIS_SYNC_REF="$ref"
  unset ERIS_SYNC_FOLLOW_BRANCH
  tick
}

usage() {
  cat <<EOF
usage: $SELF                 one sync tick (what the timer runs)
       $SELF promote <ref>   pin a tag or commit (must be on origin/main) and sync now
EOF
  exit 2
}

main() {
  load_env_file
  case "${1:-}" in
    '')
      if [ "${ERIS_SYNC_PHASE:-}" = "build" ]; then
        # The handover from the pre-#211 script: it has already fast-forwarded this checkout to
        # origin/main under its own ancestor check and exec'd this file to build. Build once; from
        # the next tick this box is held at HEAD until a ref is promoted.
        say "handover from a pre-#211 sync-main.sh: building HEAD $(git rev-parse --short=12 HEAD) once. From the next tick this box holds at HEAD until \`$SELF promote <tag|sha>\`."
        check_config
        clean_tree || return 0
        build
      else
        tick
      fi
      ;;
    promote) [ $# -eq 2 ] || usage; promote "$2" ;;
    *) usage ;;
  esac
}

# One call, then exit on the same line: bash has parsed every function above by the time this line
# runs, and reads nothing from the file afterwards -- so a checkout that rewrites this file during
# the tick cannot change what this tick executes (header, "run code it did not start with").
main "$@"; exit
