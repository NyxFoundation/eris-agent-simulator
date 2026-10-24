#!/usr/bin/env bash
# Register participants on the ASCON practice devnet (the production box), and prove they were funded.
#
#   register.sh [--participant <unit>] [--dry-run] <id> <address> [<id> <address> ...]
#
# What it does, on the box, over SSH:
#   1. checks every id/address (format; not already registered; no duplicates in this batch) -- and
#      stops before writing anything if one fails
#   2. copies config/registrations.yaml to ~/registrations.yaml.before-<first id>
#   3. appends the entries (the file is gitignored, so the dashboard sync keeps running)
#   4. waits (up to 3 min) for the coordinator's agent_external_registered, or reports
#      registration_ignored / registrations_reload_failed
#   5. reads each address's ETH / WETH / WBTC / USDC from the chain
#
# --dry-run stops after step 1. Prints addresses and balances only; no secret is read.
#
# The box is not named here (its address stays out of this public repo):
#   ERIS_OPS_BOX=ascon@<box>             required
#   ERIS_OPS_SSH_KEY=~/.ssh/<your key>   default ~/.ssh/ascon-devnet
#   ERIS_OPS_KNOWN_HOSTS=<file>          optional; the box's host key must be known either way
set -euo pipefail

BOX="${ERIS_OPS_BOX:?set ERIS_OPS_BOX=<user>@<host> (the practice devnet box)}"
KEY="${ERIS_OPS_SSH_KEY:-$HOME/.ssh/ascon-devnet}"
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes)
if [ -n "${ERIS_OPS_KNOWN_HOSTS:-}" ]; then SSH_OPTS+=(-o UserKnownHostsFile="$ERIS_OPS_KNOWN_HOSTS"); fi

PARTICIPANT=""
DRY=0
PAIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --participant) PARTICIPANT="${2:?--participant needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) PAIRS+=("$1"); shift ;;
  esac
done
[ ${#PAIRS[@]} -ge 2 ] && [ $((${#PAIRS[@]} % 2)) -eq 0 ] || { echo "usage: register.sh [--participant <unit>] [--dry-run] <id> <address> [<id> <address> ...]" >&2; exit 2; }

# Checked here as well as on the box: these values are spliced into a shell script and a YAML file.
NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
NEW=""
for ((i = 0; i < ${#PAIRS[@]}; i += 2)); do
  id="${PAIRS[i]}"; addr="${PAIRS[i+1]}"
  [[ "$id" =~ $NAME_RE ]] || { echo "bad id: $id (letters, digits, . _ -; up to 64)" >&2; exit 2; }
  [[ "$addr" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "bad address for $id: $addr" >&2; exit 2; }
  NEW+="$id $addr"$'\n'
done
if [ -n "$PARTICIPANT" ] && ! [[ "$PARTICIPANT" =~ $NAME_RE ]]; then echo "bad participant: $PARTICIPANT" >&2; exit 2; fi

ssh "${SSH_OPTS[@]}" "$BOX" "NEW='$NEW' PARTICIPANT='$PARTICIPANT' DRY=$DRY bash -s" <<'REMOTE'
set -euo pipefail
cd ~/workspace/eris-agent-simulator
export PATH=$HOME/.foundry/bin:$PATH
F=config/registrations.yaml
TODAY=$(TZ=Asia/Tokyo date +%F)

# The env lists every period the dashboard serves, in no promised order (after the 10/5 cutover the
# finished period stayed first). The running one is the one whose current segment is still written.
P=""; NEWEST=0
for c in $(grep '^ERIS_DASHBOARD_COMPETITIONS=' infra/monitoring/.env | cut -d= -f2- | tr ',' ' '); do
  [ -f "runs/$c/current-segment" ] || continue
  E="$(cat "runs/$c/current-segment")/events.jsonl"
  [ -f "$E" ] || continue
  M=$(stat -c %Y "$E")
  [ "$M" -gt "$NEWEST" ] && { NEWEST=$M; P=$c; }
done
[ -n "$P" ] || { echo "cannot find the running period (ERIS_DASHBOARD_COMPETITIONS=$(grep '^ERIS_DASHBOARD_COMPETITIONS=' infra/monitoring/.env | cut -d= -f2-))"; exit 1; }
S=$(cat "runs/$P/current-segment")
echo "period $P, segment $(basename "$S")"

python3 - "$F" "$NEW" <<'PY'
import re, sys, yaml
f, new = sys.argv[1], [l.split() for l in sys.argv[2].splitlines() if l.strip()]
d = yaml.safe_load(open(f)) or []
ids = {e["id"] for e in d}; addrs = {e["address"].lower(): e["id"] for e in d}
bad = []
for i, a in new:
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", a): bad.append(f"{i}: bad address {a}")
    if i in ids: bad.append(f"{i}: id already registered")
    if a.lower() in addrs: bad.append(f"{i}: address already registered as {addrs[a.lower()]}")
if len({i for i, _ in new}) != len(new): bad.append("the same id twice in this batch")
if len({a.lower() for _, a in new}) != len(new): bad.append("the same address twice in this batch")
if bad:
    print("REFUSED, nothing written:"); [print("  " + b) for b in bad]; sys.exit(1)
print(f"checks passed ({len(new)} new); registered so far: {len(d)}")
PY
[ "$DRY" = 1 ] && { echo "dry run: nothing written"; exit 0; }

FIRST=$(printf '%s\n' "$NEW" | head -1 | cut -d' ' -f1)
cp -p "$F" ~/registrations.yaml.before-"$FIRST"
while read -r ID ADDR; do
  [ -n "$ID" ] || continue
  {
    printf '\n- id: %s\n  address: "%s"\n' "$ID" "$ADDR"
    [ -n "$PARTICIPANT" ] && printf '  participant: %s\n' "$PARTICIPANT"
    printf '  description: registered %s\n' "$TODAY"
  } >> "$F"
done <<< "$NEW"
python3 -c "import yaml; d=yaml.safe_load(open('$F')); print('registrations file:', len(d), 'entries')"

IDS=$(printf '%s\n' "$NEW" | awk 'NF{print $1}' | paste -sd'|' -)
WANT=$(printf '%s\n' "$NEW" | awk 'NF' | wc -l)
for _ in $(seq 1 45); do
  GOT=$(grep -cE "\"agent_external_registered\".*\"agentId\":\"($IDS)\"" "$S/events.jsonl" || true)
  [ "$GOT" -ge "$WANT" ] && break
  grep -q '"registrations_reload_failed"' "$S/events.jsonl" && break
  sleep 4
done
{ grep -hE "\"agent_external_registered\".*\"agentId\":\"($IDS)\"|\"registration_ignored\"|\"registration_failed\"|\"registrations_reload_failed\"" "$S/events.jsonl" || echo '{"type":"no verdict from the coordinator within 3 minutes"}'; } \
  | python3 -c '
import json, sys
for l in sys.stdin:
    e = json.loads(l)
    print(" ", e["type"], e.get("agentId", "") or e.get("id", ""), e.get("address", ""), e.get("reason", "") or e.get("error", ""))'

R=http://127.0.0.1:8545
tok() { grep -A3 "^\s*$1: {" sdk/src/constants.local.ts | grep -o "0x[0-9a-fA-F]\{40\}" | head -1; }
while read -r ID A; do
  [ -n "$ID" ] || continue
  line="$ID: ETH $(cast from-wei "$(cast balance "$A" --rpc-url $R)" | sed 's/\.0*$//')"
  for s in WETH WBTC USDC; do
    t=$(tok $s); d=$(cast call "$t" "decimals()(uint8)" --rpc-url $R)
    b=$(cast call "$t" "balanceOf(address)(uint256)" "$A" --rpc-url $R | cut -d' ' -f1)
    line="$line / $s $(python3 -c "print($b/10**$d)")"
  done
  echo "$line"
done <<< "$NEW"
REMOTE
