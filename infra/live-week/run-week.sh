#!/usr/bin/env bash
# The one command that starts the live week, and the same command after any stop.
#
#   bash infra/live-week/run-week.sh live                 # inputs in ~/live-secrets ($ERIS_LIVE_SECRETS)
#   bash infra/live-week/run-week.sh rehearsal            # inputs in ~/rehearsal-secrets (same layout)
#   START=<ISO> bash infra/live-week/run-week.sh rehearsal   # first rehearsal start: re-time the plan
#   bash infra/live-week/run-week.sh void <s> <reason>    # rules §4.4.2 for an epoch that completed
#
# Run it inside tmux (cutover.sh start does). The first start opens runs/matrix-<id> and records it in
# <secrets>/matrix-dir; every later start resumes that matrix (--resume): complete epochs are skipped,
# an epoch that was running when the process stopped runs again from its start with the same seed,
# and the agents' state is restored from the checkpoint of the epoch before it. The runner itself
# refuses a resume whose plan, field, scenario key or state root differ.
#
# Inputs, all from the one secrets directory (README.md):
#   live-week.env         the four role keys the dump was deployed with (+ ADMIN_ADDRESS)
#   wallet-secret.yaml    AUTO / flow / victim wallet keys (issue #249): same file, same addresses
#   scenario-key.yaml     the generation key K (ADR 0027)
#   plan.yaml             the ordered plan (cutover.sh plan)
#   field.yaml            the roster (cutover.sh field)
#   models.yaml, inference-keys.yaml (mode 600), inference-secret   the inference proxy
#   inference-stats-token  optional: opens the proxy's GET /admin/recording for the operator
# Live mode also checks what cutover.sh recorded: frozen-commit, dump.sha256, roster-fingerprint,
# images.tsv.
#
# Env overrides: ERIS_LIVE_SECRETS, ERIS_LIVE_STATE_ROOT (default ~/state-root-<mode>),
# ERIS_LIVE_LOG (default ~/run-week-<mode>.log), ERIS_REPO, ERIS_LIVE_ANVIL_VERSION,
# ERIS_LIVE_GATEWAY_HOST_PORT.
set -euo pipefail
LW_NAME=run-week
# shellcheck source=infra/live-week/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

USAGE="usage: run-week.sh live | rehearsal | void <s> <reason>"
MODE="${1:-}"
case "$MODE" in
  live) ;;
  rehearsal) [ -n "${ERIS_LIVE_SECRETS:-}" ] || SECRETS="$HOME/rehearsal-secrets" ;;
  void)
    S="${2:?$USAGE}"
    shift 2
    [ $# -gt 0 ] || die "$USAGE (the reason goes into matrix.json)"
    [ -s "$SECRETS/matrix-dir" ] || die "no $SECRETS/matrix-dir: this week has not opened a matrix"
    if pgrep -f 'core/src/cli/backtest.ts' >/dev/null; then
      die "the runner is still running: stop it first (tmux attach -t $TMUX_SESSION, Ctrl-C), then void, then start again"
    fi
    MD="$(cat "$SECRETS/matrix-dir")"
    (cd "$REPO" && node --import tsx scripts/liveWeek.ts void "$MD" "$S" "$*")
    say "start the week again (bash infra/live-week/run-week.sh live): the resume re-runs s=$S with its seed"
    exit 0
    ;;
  *) die "$USAGE" ;;
esac

STATE_ROOT="${ERIS_LIVE_STATE_ROOT:-$HOME/state-root-$MODE}"
LOG="${ERIS_LIVE_LOG:-$HOME/run-week-$MODE.log}"
cd "$REPO"
say "mode $MODE, secrets $SECRETS, repo $REPO"

# ---- inputs: all present, or nothing starts ----
[ -d "$SECRETS" ] || die "no secrets directory $SECRETS"
[ "$(stat -c %a "$SECRETS" 2>/dev/null || stat -f %Lp "$SECRETS")" = 700 ] || warn "$SECRETS is not mode 700"
for f in live-week.env wallet-secret.yaml scenario-key.yaml plan.yaml field.yaml models.yaml inference-keys.yaml inference-secret; do
  [ -s "$SECRETS/$f" ] || die "missing $SECRETS/$f"
done
if grep -q "REPLACE-WITH" "$SECRETS/inference-keys.yaml"; then die "inference-keys.yaml still has REPLACE-WITH placeholders"; fi
[ "$(stat -c %a "$SECRETS/inference-keys.yaml" 2>/dev/null || stat -f %Lp "$SECRETS/inference-keys.yaml")" = 600 ] \
  || die "inference-keys.yaml must be mode 600 (the proxy refuses it otherwise)"
ok "inputs present"

PLAN="$SECRETS/plan.yaml"
if [ "$MODE" = rehearsal ]; then
  # A rehearsal re-times its plan once, at the first start; every restart reuses the same file.
  if [ -s "$SECRETS/plan-run.yaml" ]; then
    PLAN="$SECRETS/plan-run.yaml"
  elif [ -n "${START:-}" ]; then
    node --import tsx scripts/liveWeek.ts restamp "$SECRETS/plan.yaml" "$START" "${EVERY_MINUTES:-20}" "$SECRETS/plan-run.yaml"
    chmod 600 "$SECRETS/plan-run.yaml"
    PLAN="$SECRETS/plan-run.yaml"
    ok "plan re-timed from $START, every ${EVERY_MINUTES:-20} min -> plan-run.yaml"
  fi
else
  [ -z "${START:-}" ] || die "START applies to a rehearsal only: the live plan's times come from cutover.sh plan"
fi
FIELD="$SECRETS/field.yaml"

# ---- what the cutover recorded (required live; checked when present in a rehearsal) ----
recorded() { [ -s "$SECRETS/$1" ] || { [ "$MODE" = rehearsal ] && { warn "no $1 (rehearsal: not checked)"; return 1; }; die "missing $SECRETS/$1 (cutover.sh)"; }; }
if recorded frozen-commit; then check_frozen; fi
if recorded dump.sha256; then check_dump; fi
check_overlay
check_anvil_version
check_node_version
FP=$(node --import tsx scripts/liveWeek.ts fingerprint "$FIELD")
if recorded roster-fingerprint; then
  [ "$FP" = "$(cat "$SECRETS/roster-fingerprint")" ] || die "field.yaml is $FP, cutover recorded $(cat "$SECRETS/roster-fingerprint")"
  ok "field fingerprint $FP"
fi
# Every launched agent's image exists, and is the one cutover.sh images verified (its overlay was
# read out of the image and matched the dump).
N=0
while IFS=$'\t' read -r id tag _dir; do
  N=$((N + 1))
  img=$(docker image inspect "$tag" --format '{{.Id}}' 2>/dev/null) || die "$id: no image $tag (cutover.sh images)"
  if [ -s "$SECRETS/images.tsv" ]; then
    want=$(awk -F'\t' -v t="$tag" '$2 == t {print $3}' "$SECRETS/images.tsv")
    [ "$want" = "$img" ] || die "$id: $tag is $img, cutover.sh images verified ${want:-nothing}: re-run cutover.sh images"
  elif [ "$MODE" = live ]; then
    die "missing $SECRETS/images.tsv (cutover.sh images)"
  fi
done < <(node --import tsx scripts/liveWeek.ts images "$FIELD")
[ "$N" -gt 0 ] || die "field.yaml launches no agent"
ok "$N agent images present$([ -s "$SECRETS/images.tsv" ] && echo ', each the one cutover.sh images verified')"
MISSING=$(node --import tsx scripts/liveWeek.ts keys-missing "$FIELD" "$SECRETS/inference-keys.yaml" | tr '\n' ' ')
[ -z "$MISSING" ] || warn "no inference key on file for: $MISSING(their revisions will be refused with 403)"

set -a
# shellcheck disable=SC1091
. "$SECRETS/live-week.env"
set +a
export ERIS_WALLET_SECRET_FILE="$SECRETS/wallet-secret.yaml"
ERIS_INFERENCE_SECRET="$(cat "$SECRETS/inference-secret")"
export ERIS_INFERENCE_SECRET
STATS_ENV=()
if [ -s "$SECRETS/inference-stats-token" ]; then
  ERIS_INFERENCE_STATS_TOKEN="$(cat "$SECRETS/inference-stats-token")"
  export ERIS_INFERENCE_STATS_TOKEN
  STATS_ENV=(-e ERIS_INFERENCE_STATS_TOKEN)
fi

# ---- the two hubs on ascon-chain: the RPC gateway and the inference proxy ----
# anvil listens on docker0's address (--anvil-host, issue #305): reachable from the gateway
# container, not from outside the host and not from the agents (their networks join only the hubs).
DOCKER0=$(docker0_addr)
[ -n "$DOCKER0" ] || die "docker0 has no IPv4 address"
for ct in "$GATEWAY_CT" "$PROXY_CT"; do
  proj=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$ct" 2>/dev/null || true)
  [ -z "$proj" ] || die "$ct belongs to the compose project '$proj' (the practice stack): stop it there first (cutover.sh preflight)"
done
docker network inspect "$CHAIN_NET" >/dev/null 2>&1 || docker network create "$CHAIN_NET" >/dev/null
# Every account the environment signs with has its pending nonce answered as of "latest": the role
# keys (the deployer's named a gap's block), every flow wallet (an informed one's bump said where the
# next price was), the whale, the launch slots, the vuln pool owner, the victims. The union over the
# official regimes and this plan's, under this week's wallet secret (scripts/liveWeek.ts).
SEALED=$(node --import tsx scripts/liveWeek.ts sealed-senders --wallet-secret "$SECRETS/wallet-secret.yaml" \
  --scenarios config/scenarios/public.yaml --scenarios "$PLAN") \
  || die "cannot list the environment's signers for the gateway (live-week.env role keys, wallet-secret.yaml)"
ok "gateway seals the pending nonce of $(echo "$SEALED" | tr ',' '\n' | grep -c .) environment addresses"
docker rm -f "$GATEWAY_CT" "$PROXY_CT" >/dev/null 2>&1 || true
mkdir -p "runs/rpc-gateway-$MODE" "runs/inference-$MODE"
LOGOPTS=(--log-opt max-size=100m --log-opt max-file=5)
docker run -d --name "$GATEWAY_CT" --network "$CHAIN_NET" "${LOGOPTS[@]}" \
  -p "127.0.0.1:$GATEWAY_HOST_PORT:8546" \
  -v "$REPO/infra/rpc-gateway:/app:ro" -v "$REPO/runs/rpc-gateway-$MODE:/var/log/ascon" \
  -e PORT=8546 -e UPSTREAM="http://$DOCKER0:$ANVIL_PORT" -e ENV_NAME=live -e RPC_MAX_PRIORITY_FEE_WEI=0 \
  -e RPC_PENDING_SEALED_SENDERS="$SEALED" \
  -e LOG_FILE=/var/log/ascon/rpc-gateway-live.log \
  node:24.22.1-bookworm-slim node /app/gateway.mjs >/dev/null
ok "gateway $GATEWAY_CT -> http://$DOCKER0:$ANVIL_PORT (host 127.0.0.1:$GATEWAY_HOST_PORT)"
docker run -d --name "$PROXY_CT" --network "$CHAIN_NET" "${LOGOPTS[@]}" -p "127.0.0.1:$PROXY_PORT:8790" \
  -v "$REPO:/app" -v "$SECRETS:/secrets:ro" -w /app -e ERIS_INFERENCE_SECRET "${STATS_ENV[@]}" \
  node:24.22.1-bookworm-slim npx tsx core/src/cli/inferenceProxy.ts \
  --models /secrets/models.yaml --keys /secrets/inference-keys.yaml \
  --listen 0.0.0.0:8790 --record "/app/runs/inference-$MODE" >/dev/null
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PROXY_PORT/healthz" >/dev/null && break; sleep 2; done
HEALTH=$(curl -s "http://127.0.0.1:$PROXY_PORT/healthz" || true)
echo "$HEALTH" | grep -q '"credentials":"participant"' \
  || die "inference proxy is not in participant mode (healthz: ${HEALTH:-no answer}; docker logs $PROXY_CT)"
ok "inference proxy $HEALTH, recording to runs/inference-$MODE"

export ERIS_AGENT_ISOLATE=1 ERIS_AGENT_INTERNAL=1
export ERIS_AGENT_HUB="$GATEWAY_CT" ERIS_AGENT_RPC_URL="http://$GATEWAY_CT:8546"
export ERIS_INFERENCE_HUB="$PROXY_CT" ERIS_INFERENCE_BASE_URL="http://$PROXY_CT:8790"
export ERIS_INFERENCE_PROBE_URL="http://127.0.0.1:$PROXY_PORT"

# ---- new matrix or resume ----
# The state root is fixed at the first start (the runner refuses a resume under another one).
if [ -s "$SECRETS/state-root" ]; then
  [ "$(cat "$SECRETS/state-root")" = "$STATE_ROOT" ] || die "this week's state root is $(cat "$SECRETS/state-root"), not $STATE_ROOT (unset ERIS_LIVE_STATE_ROOT or set it to that)"
fi
nonempty() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }
ARGS=(--scenarios "$PLAN" --agents "$FIELD" --follow-schedule
  --scenario-key "$SECRETS/scenario-key.yaml" --agent-state-root "$STATE_ROOT" --anvil-host "$DOCKER0")
if [ -s "$SECRETS/matrix-dir" ]; then
  MD=$(cat "$SECRETS/matrix-dir")
  if [ -s "$MD/matrix.json" ]; then
    ARGS+=(--resume "$MD")
    say "resuming $MD"
  else
    # matrix.json is written when epoch 1 ends. Without it the previous start stopped before any
    # epoch completed, so there is nothing to resume: start the matrix again on an empty state root.
    say "$MD has no matrix.json (no epoch completed): starting the matrix afresh"
    if nonempty "$STATE_ROOT"; then
      mv "$STATE_ROOT" "$STATE_ROOT.abandoned-$(date +%Y%m%dT%H%M%S)"
      warn "moved the previous start's state root aside: $STATE_ROOT.abandoned-*"
    fi
    rm -f "$SECRETS/matrix-dir"
  fi
elif nonempty "$STATE_ROOT"; then
  die "$STATE_ROOT is not empty but no matrix is recorded in $SECRETS/matrix-dir. If this week already has a matrix, write its path (runs/matrix-<id>) there; otherwise move the state root aside"
fi
mkdir -p "$STATE_ROOT"
echo "$STATE_ROOT" >"$SECRETS/state-root"

if [ ! -s "$SECRETS/matrix-dir" ]; then
  # Record which matrix this week is, as soon as the runner opens its directory (before the first
  # epoch's wait), so a restart at any later point resumes it.
  matrices() { find runs -maxdepth 1 -type d -name 'matrix-*' 2>/dev/null | sort; }
  BEFORE=$(matrices)
  (
    for _ in $(seq 1 1800); do
      NEW=$(comm -13 <(echo "$BEFORE") <(matrices) | head -1)
      if [ -n "$NEW" ]; then
        echo "$NEW" >"$SECRETS/matrix-dir"
        echo "[run-week] this week's matrix is $NEW (recorded in $SECRETS/matrix-dir)"
        break
      fi
      sleep 2
    done
  ) &
fi

say "npm run backtest -- ${ARGS[*]}"
say "log: $LOG"
set +e
npm run backtest -- "${ARGS[@]}" 2>&1 | tee -a "$LOG"
CODE=${PIPESTATUS[0]}
set -e
say "the runner exited with code $CODE. To continue: bash infra/live-week/run-week.sh $MODE (resumes $(cat "$SECRETS/matrix-dir" 2>/dev/null || echo 'a new matrix'))"
exit "$CODE"
