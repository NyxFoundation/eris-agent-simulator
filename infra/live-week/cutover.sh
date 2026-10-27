#!/usr/bin/env bash
# The 11/30-night cutover from the practice devnet to the live week, as steps that can be run one at
# a time or all in order. Every step prints what it did, stops at the first failure, and is safe to
# run again: a step that already happened says so and checks it instead of redoing it differently.
#
#   bash infra/live-week/cutover.sh <step> [options]
#   bash infra/live-week/cutover.sh all [options] [--from <step>]
#
# Steps, in order (README.md has the timeline):
#   preflight     practice stopped? docker address pools? ports, disk, quota, tools, anvil version
#   freeze        record `git rev-parse HEAD` to <secrets>/frozen-commit; print the hash to publish
#   dump          check backtest/state/venues-state.json against --dump-sha256 / <secrets>/dump.sha256
#   overlay       npm run gen:local-constants:from-dump (before ANY image is built, issue #310)
#   submissions   accept-submission.sh over --zips <dir>/<unit>.zip -> <secrets>/accepted.tsv
#   field         <secrets>/field.yaml = accepted units (AUTO wallets) + noop baseline; its fingerprint
#   images        rebuild base + every field image; read each image's baked overlay; images.tsv
#   plan          competition plan (k 60, 12/1 00:00 to 12/8 00:00 JST) -> <secrets>/plan.yaml; commitments
#   start         run-week.sh live in tmux session "live-week"
#
# Options (each step reads only the ones it needs; nothing is guessed):
#   --dump-sha256 <hex>     dump: the expected sha256 of the production dump (else <secrets>/dump.sha256)
#   --zips <dir>            submissions: the directory of final ZIPs, one <unit>.zip per participation unit
#   --allow-rejected        submissions: continue although some ZIPs were rejected (they are not in the field)
#   --expected-agents <N>   preflight: agents to plan docker networks for (default: field.yaml, else 100)
#   --hidden <file>         plan: default <secrets>/hidden-set.yaml
#   --lottery <file>        plan: default <secrets>/lottery-seed.yaml
#   --from <step>           all: start at this step
# Env: ERIS_LIVE_SECRETS (default ~/live-secrets), ERIS_LIVE_STATE_ROOT, ERIS_REPO,
#   ERIS_LIVE_MIN_FREE_GB (default 50), ERIS_LIVE_ANVIL_VERSION (default 1.7.1),
#   ERIS_LIVE_K / ERIS_LIVE_STARTS_AT / ERIS_LIVE_ENDS_AT (plan; defaults are the live week's).
set -euo pipefail
LW_NAME=cutover
# shellcheck source=infra/live-week/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

STEPS=(preflight freeze dump overlay submissions field images plan start)
K="${ERIS_LIVE_K:-60}"
STARTS_AT="${ERIS_LIVE_STARTS_AT:-2026-12-01T00:00:00+09:00}"
ENDS_AT="${ERIS_LIVE_ENDS_AT:-2026-12-08T00:00:00+09:00}"
MIN_FREE_GB="${ERIS_LIVE_MIN_FREE_GB:-50}"
STATE_ROOT="${ERIS_LIVE_STATE_ROOT:-$HOME/state-root-live}"

STEP="${1:-}"
[ -n "$STEP" ] || { sed -n '2,32p' "$0"; exit 2; }
shift
DUMP_SHA="" ZIPS="" ALLOW_REJECTED=0 EXPECTED_AGENTS="" HIDDEN="" LOTTERY="" FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dump-sha256) DUMP_SHA="${2:?}"; shift 2 ;;
    --zips) ZIPS="${2:?}"; shift 2 ;;
    --allow-rejected) ALLOW_REJECTED=1; shift ;;
    --expected-agents) EXPECTED_AGENTS="${2:?}"; shift 2 ;;
    --hidden) HIDDEN="${2:?}"; shift 2 ;;
    --lottery) LOTTERY="${2:?}"; shift 2 ;;
    --from) FROM="${2:?}"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
HIDDEN="${HIDDEN:-$SECRETS/hidden-set.yaml}"
LOTTERY="${LOTTERY:-$SECRETS/lottery-seed.yaml}"

banner() { printf '\n[cutover] ==== %s  (%s) ====\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
need_secrets() {
  [ -d "$SECRETS" ] || die "no secrets directory $SECRETS (mkdir -m 700 $SECRETS and copy the inputs in; README.md)"
}
free_gb() { df -Pk "$1" | awk 'NR==2 {printf "%d", $4 / 1048576}'; }
fs_of() { df -P "$1" | awk 'NR==2 {print $1}'; }
runner_running() { pgrep -f 'core/src/cli/backtest.ts' >/dev/null; }

# ---------------------------------------------------------------- 1. preflight
step_preflight() {
  banner "1/9 preflight"
  need_secrets
  [ "$(mode_of "$SECRETS")" = 700 ] || die "$SECRETS is mode $(mode_of "$SECRETS"); chmod 700 it"
  ok "secrets directory $SECRETS (mode 700)"

  local t
  for t in docker git node npm python3 unzip zip tmux curl ip ss awk sed; do
    command -v "$t" >/dev/null || die "missing tool: $t"
  done
  node -v | grep -q '^v24' || die "node is $(node -v), the week runs on v24"
  docker buildx version >/dev/null 2>&1 || die "docker buildx is missing (apt-get install docker-buildx): Dockerfile.team needs BuildKit"
  docker info >/dev/null 2>&1 || die "cannot talk to docker as $USER (in the docker group? log in again)"
  ok "tools: docker + buildx, node $(node -v), git, python3, zip/unzip, tmux, curl, ip, ss"
  check_anvil_version
  check_node_version

  # -- docker networks: one per agent (ERIS_AGENT_ISOLATE=1); docker's built-in pools stop at ~27
  [ -n "$(docker0_addr)" ] || die "docker0 has no IPv4 address (anvil listens there: --anvil-host)"
  ok "docker0 $(docker0_addr)"
  local need cap have
  if [ -n "$EXPECTED_AGENTS" ]; then need="$EXPECTED_AGENTS"
  elif [ -s "$SECRETS/field.yaml" ]; then need=$(lw images "$SECRETS/field.yaml" | wc -l | tr -d ' ')
  else need=100; warn "no field.yaml yet: planning networks for 100 agents (--expected-agents N to change)"
  fi
  [ -r /etc/docker/daemon.json ] || die "no /etc/docker/daemon.json: add { \"default-address-pools\": [ { \"base\": \"10.64.0.0/10\", \"size\": 24 } ] } and restart docker (infra/docker-agent/ISOLATION.md)"
  cap=$(lw pools /etc/docker/daemon.json)
  have=$(docker network ls -q | wc -l | tr -d ' ')
  [ "$cap" -gt 0 ] || die "/etc/docker/daemon.json has no default-address-pools: the 28th agent network cannot be created"
  [ $((cap - have)) -ge $((need + 5)) ] || die "address pools yield $cap networks, $have exist, the field needs $need (+5 margin)"
  ok "address pools: $cap networks, $have in use, $need agents"
  local stale
  stale=$(docker network ls --format '{{.Name}}' | grep -c '^ag-' || true)
  [ "$stale" = 0 ] || warn "$stale ag-* networks left from earlier runs (infra/docker-agent/reap.sh removes the unused ones)"

  # -- disk and quota
  local path dr
  dr=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  for path in "$REPO" "$(dirname "$STATE_ROOT")" "$dr"; do
    [ -e "$path" ] || continue
    local gb
    gb=$(free_gb "$path")
    [ "$gb" -ge "$MIN_FREE_GB" ] || die "$path has ${gb} GB free, below $MIN_FREE_GB GB (ERIS_LIVE_MIN_FREE_GB)"
    ok "$path: ${gb} GB free ($(df -P "$path" | awk 'NR==2 {print $5}') used, $(fs_of "$path"))"
  done
  if [ -d "$HOME/.foundry/anvil/tmp" ]; then
    warn "anvil per-block state under ~/.foundry/anvil/tmp: $(du -sh "$HOME/.foundry/anvil/tmp" 2>/dev/null | cut -f1) (remove anvil-state-* only when no anvil runs)"
  fi
  local sfs
  sfs=$(fs_of "$(dirname "$STATE_ROOT")")
  if [ "$sfs" = "$(fs_of "$REPO")" ]; then
    warn "the state root ($STATE_ROOT) is on the same filesystem as runs/: no host quota keeps a participant's writes from filling the coordinator's disk (CHECKLIST §5). The coordinator's own per-agent quota still applies"
  else
    ok "state root on its own filesystem $sfs ($(findmnt -no FSTYPE,SIZE -T "$(dirname "$STATE_ROOT")" 2>/dev/null || echo '?'))"
  fi
  ok "host: $(nproc 2>/dev/null || echo '?') vCPU, $(awk '/MemTotal/ {printf "%d GiB", $2/1048576}' /proc/meminfo 2>/dev/null || echo '?')"

  local f missing=""
  for f in live-week.env wallet-secret.yaml scenario-key.yaml models.yaml inference-keys.yaml inference-secret hidden-set.yaml lottery-seed.yaml; do
    [ -s "$SECRETS/$f" ] || missing="$missing $f"
  done
  if [ -n "$missing" ]; then warn "not yet in $SECRETS:$missing (needed by later steps)"; else ok "operator inputs present in $SECRETS"; fi

  # Last, so that a run before 11/30 24:00 (practice still up) checks everything else first.
  preflight_practice_and_ports
}

preflight_practice_and_ports() {
  # -- the practice period is stopped, and stays stopped across a reboot
  if command -v systemctl >/dev/null; then
    if systemctl --user is-active --quiet ascon-devnet.service; then
      die "the practice coordinator is running: finish the period's end steps, then systemctl --user stop ascon-devnet.service"
    fi
    if systemctl --user is-enabled --quiet ascon-devnet.service 2>/dev/null; then
      die "ascon-devnet.service is still enabled, so a reboot during the week starts the practice period again: systemctl --user disable ascon-devnet.service"
    fi
    ok "practice coordinator (ascon-devnet.service) stopped and disabled"
    if systemctl is-active --quiet cloudflared 2>/dev/null; then
      warn "cloudflared is active. Practice published the gateway on localhost:8546; the live gateway is on 127.0.0.1:$GATEWAY_HOST_PORT and no tunnel route may point at it (ops runbook step 13)"
    fi
  else
    warn "no systemctl: cannot check ascon-devnet.service"
  fi
  if pgrep -f 'core/src/cli/sim-realtime.ts' >/dev/null; then
    die "a sim:realtime coordinator is running (pgrep -af sim-realtime): the practice period is not stopped"
  fi
  local ct proj running
  for ct in ascon-anvil "$GATEWAY_CT" "$PROXY_CT"; do
    proj=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$ct" 2>/dev/null || true)
    running=$(docker inspect -f '{{.State.Running}}' "$ct" 2>/dev/null || echo false)
    if [ -n "$proj" ] && [ "$running" = true ]; then
      die "$ct (compose project '$proj', the practice stack) is running: (cd infra/monitoring && docker compose stop anvil rpc-gateway-live rpc-gateway-test)"
    fi
  done
  ok "practice chain and gateway containers stopped"

  # -- ports: the backtest anvil, the proxy and the gateway's host port
  local port
  if runner_running; then
    warn "a backtest runner is already running (the week itself?): port checks skipped"
  else
    for port in "$ANVIL_PORT" "$PROXY_PORT" "$GATEWAY_HOST_PORT"; do
      if ss -Hltn "sport = :$port" | grep -q .; then
        # Ours from an earlier run-week start is fine: run-week recreates both containers.
        if docker ps --format '{{.Names}} {{.Ports}}' | grep -E "^($GATEWAY_CT|$PROXY_CT) " | grep -q ":$port->"; then continue; fi
        die "port $port is in use: $(ss -Hltnp "sport = :$port" 2>/dev/null | head -1)"
      fi
    done
    ok "ports $ANVIL_PORT / $PROXY_PORT / $GATEWAY_HOST_PORT free (or held by this week's own containers)"
  fi
}

# ---------------------------------------------------------------- 2. freeze
step_freeze() {
  banner "2/9 freeze the evaluation code"
  need_secrets
  local head dirty
  head=$(git -C "$REPO" rev-parse HEAD)
  dirty=$(git -C "$REPO" diff --name-only HEAD | grep -vx 'sdk/src/constants.local.ts' || true)
  [ -z "$dirty" ] || die "tracked files differ from HEAD: $(echo "$dirty" | tr '\n' ' '): the frozen commit must be what runs"
  if [ -s "$SECRETS/frozen-commit" ]; then
    [ "$(cat "$SECRETS/frozen-commit")" = "$head" ] \
      || die "already frozen at $(cat "$SECRETS/frozen-commit"), HEAD is $head. Check out the frozen commit, or (before the week starts, deliberately) remove $SECRETS/frozen-commit"
    ok "already frozen at $head"
  else
    echo "$head" >"$SECRETS/frozen-commit"
    ok "recorded $head in $SECRETS/frozen-commit"
  fi
  git -C "$REPO" fetch -q origin 2>/dev/null || warn "git fetch origin failed: cannot check the commit is on main"
  if git -C "$REPO" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then ok "the commit is on origin/main"
  else warn "$head is not on origin/main: participants cannot see the code you publish"
  fi
  say "commit: $(git -C "$REPO" log -1 --format='%H  %cI  %s')"
  say "PUBLISH (rules §4.4.3 / §7.1): the frozen commit $head"
  say "  https://github.com/NyxFoundation/eris-agent-simulator/commit/$head"
  say "  together with the Appendix A values, in the ascon-web changelog and on Discord"
}

# ---------------------------------------------------------------- 3. dump
step_dump() {
  banner "3/9 production state dump"
  need_secrets
  local stored=""
  [ -s "$SECRETS/dump.sha256" ] && stored=$(tr -d ' \n' <"$SECRETS/dump.sha256")
  if [ -n "$DUMP_SHA" ] && [ -n "$stored" ] && [ "$DUMP_SHA" != "$stored" ]; then
    die "--dump-sha256 $DUMP_SHA differs from $SECRETS/dump.sha256 ($stored)"
  fi
  local want="${DUMP_SHA:-$stored}"
  [ -n "$want" ] || die "pass --dump-sha256 <hex>: the sha256 recorded for the production dump in the operator runbook"
  echo "$want" | grep -qE '^[0-9a-f]{64}$' || die "--dump-sha256 must be 64 lowercase hex characters"
  [ -s "$DUMP" ] && [ -s "$MANIFEST" ] || die "copy the production dump's venues-state.json and manifest.json into $STATE_DIR"
  local got
  got=$(sha256_of "$DUMP")
  [ "$got" = "$want" ] || die "$DUMP sha256 is $got, expected $want"
  [ -n "$stored" ] || echo "$want" >"$SECRETS/dump.sha256"
  ok "venues-state.json sha256 $got (recorded in $SECRETS/dump.sha256)"
  ok "manifest deployments fingerprint $(manifest_fp)"
  check_anvil_version
  check_node_version
}

# ---------------------------------------------------------------- 4. overlay
step_overlay() {
  banner "4/9 address overlay from the dump (before any image is built)"
  [ -s "$MANIFEST" ] || die "no $MANIFEST: run the dump step first"
  if [ "$(overlay_fp_stdin <"$OVERLAY")" = "$(manifest_fp)" ]; then
    ok "sdk/src/constants.local.ts already names the dump's deployment"
  else
    (cd "$REPO" && npm run -s gen:local-constants:from-dump)
    say "regenerated sdk/src/constants.local.ts (the one tracked file allowed to differ from the frozen commit)"
  fi
  check_overlay
  (cd "$REPO" && node --import tsx scripts/checkAgentOverlay.ts) # agent:build's own gate says "matches"
}

# ---------------------------------------------------------------- 5. submissions
step_submissions() {
  banner "5/9 accept the final submissions"
  need_secrets
  check_frozen
  check_overlay
  [ -n "$ZIPS" ] || die "pass --zips <dir>: the directory of final ZIPs, one <unit>.zip per participation unit"
  [ -d "$ZIPS" ] || die "no directory $ZIPS"
  local zips=()
  while IFS= read -r z; do zips+=("$z"); done < <(find "$ZIPS" -maxdepth 1 -type f -name '*.zip' | sort)
  [ "${#zips[@]}" -gt 0 ] || die "no *.zip in $ZIPS"
  local tsv="$SECRETS/accepted.tsv" rej="$SECRETS/rejected.tsv" logs="$SECRETS/accept-logs"
  mkdir -p "$logs"
  [ -s "$tsv" ] || printf 'unit\tzip\tzipSha256\timageId\tacceptedAt\n' >"$tsv"
  printf 'unit\tzip\tzipSha256\treason\tlog\n' >"$rej"
  local z unit sha prev log digest reason accepted=0 skipped=0 rejected=0
  for z in "${zips[@]}"; do
    unit=$(basename "$z" .zip)
    sha=$(sha256_of "$z")
    log="$logs/$unit.log"
    reason=""
    if ! echo "$unit" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'; then reason="file name is not a valid unit id"
    elif [ "$unit" = noop ] || [ "$unit" = runtime ] || [ "$unit" = lib ]; then reason="unit id is reserved"
    fi
    prev=$(awk -F'\t' -v u="$unit" 'NR > 1 && $1 == u {print $3}' "$tsv")
    if [ -z "$reason" ] && [ -n "$prev" ]; then
      if [ "$prev" = "$sha" ]; then
        docker image inspect "eris-agent:$unit" >/dev/null 2>&1 || die "$unit is in accepted.tsv but eris-agent:$unit is gone: the images step rebuilds it"
        ok "$unit: already accepted (same ZIP)"
        skipped=$((skipped + 1))
        continue
      fi
      reason="the ZIP changed since it was accepted ($prev). If this is the unit's final ZIP, remove example/agents/$unit and its accepted.tsv line, then run this step again"
    fi
    if [ -z "$reason" ] && [ -n "$(git -C "$REPO" ls-files "example/agents/$unit" | head -1)" ]; then
      reason="the unit id is the name of a reference agent in example/agents/ (rename the unit)"
    fi
    if [ -z "$reason" ]; then
      say "$unit: accept-submission.sh $(basename "$z") (log $log)"
      if "$REPO/infra/submission/accept-submission.sh" "$z" "$unit" </dev/null >"$log" 2>&1; then
        digest=$(sed -n 's/^  digest: *//p' "$log" | tail -1)
        echo "$digest" | grep -qE '^sha256:[0-9a-f]{64}$' || die "$unit: accepted but no digest in $log"
        printf '%s\t%s\t%s\t%s\t%s\n' "$unit" "$z" "$sha" "$digest" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$tsv"
        ok "$unit: ACCEPTED $digest"
        accepted=$((accepted + 1))
        continue
      fi
      reason="accept-submission.sh refused: $(grep -E 'REJECTED|failed|refus|invalid|no prompt|neither|already exists|found issues' "$log" | tail -1)"
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$unit" "$z" "$sha" "$reason" "$log" >>"$rej"
    warn "$unit: REJECTED -- $reason"
    rejected=$((rejected + 1))
  done
  say "accepted now $accepted, already accepted $skipped, rejected $rejected (of ${#zips[@]} ZIPs)"
  say "ledger: $tsv ; rejections: $rej"
  local gone
  gone=$(awk -F'\t' 'NR > 1 {print $1}' "$tsv" | while read -r u; do [ -f "$ZIPS/$u.zip" ] || echo "$u"; done | tr '\n' ' ')
  [ -z "$gone" ] || warn "in accepted.tsv but no longer in $ZIPS: $gone(they stay in the field unless you remove their line)"
  if [ "$rejected" -gt 0 ] && [ "$ALLOW_REJECTED" != 1 ]; then
    die "$rejected ZIP(s) rejected. Decide each one (see $rej): fix and run this step again, or continue without them with --allow-rejected"
  fi
}

# ---------------------------------------------------------------- 6. field
step_field() {
  banner "6/9 the field"
  need_secrets
  local tsv="$SECRETS/accepted.tsv" out="$SECRETS/field.yaml" tmp fp
  [ -s "$tsv" ] || die "no $tsv: run the submissions step first"
  tmp=$(mktemp "$SECRETS/.tmp.XXXXXX")
  fp=$(lw field "$tsv" "$tmp")
  if [ -s "$out" ] && cmp -s "$tmp" "$out"; then
    rm -f "$tmp"
    ok "field.yaml unchanged"
  else
    if [ -s "$out" ]; then
      [ ! -s "$SECRETS/matrix-dir" ] || { rm -f "$tmp"; die "the week has started ($(cat "$SECRETS/matrix-dir")): the field cannot change (the runner refuses a resume on another field)"; }
      cp "$out" "$out.prev-$(date +%Y%m%dT%H%M%S)"
      diff -u "$out" "$tmp" || true
    fi
    mv "$tmp" "$out"
    chmod 600 "$out"
    ok "wrote $out"
  fi
  local id
  while IFS=$'\t' read -r id _tag dir; do
    [ -d "$REPO/example/agents/$dir" ] || die "$id: no example/agents/$dir"
  done < <(lw images "$out")
  echo "$fp" >"$SECRETS/roster-fingerprint"
  ok "$(lw images "$out" | wc -l | tr -d ' ') agents, the noop baseline included"
  say "rosterFingerprint $fp (matrix.json will carry the same value; saved to $SECRETS/roster-fingerprint)"
}

# ---------------------------------------------------------------- 7. images
step_images() {
  banner "7/9 images at the frozen commit"
  need_secrets
  check_frozen
  check_dump
  check_overlay
  [ -s "$SECRETS/field.yaml" ] || die "no field.yaml: run the field step first"
  local logs="$SECRETS/build-logs" want out tmp
  mkdir -p "$logs"
  want=$(manifest_fp)
  say "base image (log $logs/base.log)"
  (cd "$REPO" && npm run -s agent:build) >"$logs/base.log" 2>&1 || die "base build failed: $logs/base.log"
  ok "$(tail -1 "$logs/base.log")"
  out="$SECRETS/images.tsv"
  tmp=$(mktemp "$SECRETS/.tmp.XXXXXX")
  printf 'id\ttag\timageId\toverlayFingerprint\tacceptedImageId\n' >"$tmp"
  local id tag dir img fp acc n=0 changed=0
  while IFS=$'\t' read -r id tag dir; do
    (cd "$REPO" && npm run -s agent:build -- team "$dir") </dev/null >"$logs/$dir.log" 2>&1 || { rm -f "$tmp"; die "$id: build failed: $logs/$dir.log"; }
    img=$(docker image inspect "$tag" --format '{{.Id}}')
    fp=$(image_overlay_fp "$tag")
    [ "$fp" = "$want" ] || { rm -f "$tmp"; die "$id: $tag carries overlay ${fp:-none}, the dump is $want (issue #310)"; }
    acc=$(awk -F'\t' -v u="$id" 'NR > 1 && $1 == u {print $4}' "$SECRETS/accepted.tsv" 2>/dev/null || true)
    if [ -n "$acc" ] && [ "$acc" != "$img" ]; then changed=$((changed + 1)); warn "$id: image id $img differs from the one at acceptance ($acc); the ledger records both"; fi
    printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$tag" "$img" "$fp" "${acc:--}" >>"$tmp"
    ok "$id: $tag $img, overlay matches"
    n=$((n + 1))
  done < <(lw images "$SECRETS/field.yaml")
  mv "$tmp" "$out"
  chmod 600 "$out"
  ok "$n images verified -> $out ($changed differ from their acceptance digest)"
  say "record these digests in the submission ledger; runs/<id>/images.jsonl logs them again at spawn"
}

# ---------------------------------------------------------------- 8. plan
step_plan() {
  banner "8/9 the plan"
  need_secrets
  [ -s "$HIDDEN" ] || die "no hidden set $HIDDEN"
  [ -s "$LOTTERY" ] || die "no lottery seed $LOTTERY"
  [ -s "$SECRETS/scenario-key.yaml" ] || die "no $SECRETS/scenario-key.yaml"
  local out="$SECRETS/plan.yaml" tmp errf
  tmp=$(mktemp "$SECRETS/.tmp.XXXXXX")
  errf=$(mktemp "$SECRETS/.tmp.XXXXXX")
  (cd "$REPO" && npm run -s competition -- plan --hidden "$HIDDEN" --lottery "$LOTTERY" --k "$K" \
    --starts-at "$STARTS_AT" --ends-at "$ENDS_AT" --out "$tmp") 2>"$errf" || { cat "$errf" >&2; rm -f "$tmp" "$errf"; die "competition plan failed"; }
  cat "$errf"
  if [ -s "$out" ]; then
    cmp -s "$tmp" "$out" || { rm -f "$tmp" "$errf"; die "$out exists and differs from the plan these inputs give: move it aside deliberately if the inputs changed"; }
    rm -f "$tmp"
    ok "plan.yaml unchanged"
  else
    mv "$tmp" "$out"
    chmod 600 "$out"
    ok "wrote $out ($K epochs, $STARTS_AT to $ENDS_AT)"
  fi
  local hidden_c lottery_c key_c
  hidden_c=$(sed -n 's/^\[competition\] hidden set *//p' "$errf")
  lottery_c=$(sed -n 's/^\[competition\] lottery seed *//p' "$errf")
  rm -f "$errf"
  key_c=$(cd "$REPO" && npm run -s competition -- commit "$SECRETS/scenario-key.yaml")
  {
    echo "hiddenSet    $hidden_c"
    echo "lotterySeed  $lottery_c"
    echo "scenarioKey  $key_c"
  } >"$SECRETS/commitments.txt"
  say "commitments (saved to $SECRETS/commitments.txt):"
  sed 's/^/[cutover]     /' "$SECRETS/commitments.txt"
  say "PUBLISH now: the lottery seed commitment (rules §7.1, at the end of the submission period)."
  say "CHECK: the hidden-set and generation-key commitments equal the values already published; publish any that is not yet."
}

# ---------------------------------------------------------------- 9. start
step_start() {
  banner "9/9 start the week"
  need_secrets
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    ok "tmux session $TMUX_SESSION already exists: tmux attach -t $TMUX_SESSION"
    return
  fi
  runner_running && die "a backtest runner is already running outside tmux (pgrep -af core/src/cli/backtest.ts)"
  local envs="" v
  for v in ERIS_LIVE_SECRETS ERIS_LIVE_STATE_ROOT ERIS_LIVE_LOG ERIS_REPO ERIS_LIVE_ANVIL_VERSION ERIS_LIVE_GATEWAY_HOST_PORT; do
    if [ -n "${!v+x}" ]; then envs="$envs $v=$(printf '%q' "${!v}")"; fi
  done
  local cmd
  cmd="env$envs bash $(printf '%q' "$LW_DIR/run-week.sh") live; echo; echo '[run-week] stopped. To continue: bash infra/live-week/run-week.sh live'; exec bash"
  tmux new-session -d -s "$TMUX_SESSION" -c "$REPO" "$cmd"
  ok "started tmux session $TMUX_SESSION"
  sleep 30
  tmux capture-pane -p -t "$TMUX_SESSION" | grep -v '^$' | tail -25 | sed 's/^/[cutover]   | /'
  say "watch: tmux attach -t $TMUX_SESSION (detach: Ctrl-b d). Expect '[live-week] posture checked' and 's=1 ...: waiting ... for its planned start'"
}

run_step() {
  case "$1" in
    preflight | freeze | dump | overlay | submissions | field | images | plan | start) "step_$1" ;;
    *) die "unknown step $1 (one of: ${STEPS[*]} all)" ;;
  esac
}

if [ "$STEP" = all ]; then
  started=0
  [ -n "$FROM" ] || started=1
  for s in "${STEPS[@]}"; do
    if [ "$s" = "$FROM" ]; then started=1; fi
    if [ "$started" = 1 ]; then run_step "$s"; fi
  done
  [ "$started" = 1 ] || die "--from $FROM is not a step (${STEPS[*]})"
  say "all steps done"
else
  run_step "$STEP"
fi
