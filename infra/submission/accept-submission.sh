#!/usr/bin/env bash
# The missing link: an accepted submission ZIP -> a runnable per-team image.
#
#   ./accept-submission.sh <submission.zip> <team-id>
#
# scan-submission.py screens a ZIP and build.sh builds from `example/agents/<id>`, but nothing moved
# a ZIP into that shape, so the pipeline had a gap exactly where a competition needs an audit trail.
#
# What it does, in order, stopping at the first failure:
#   1. scan     -- scan-submission.py must accept (this is also what catches a tampered vendored sdk)
#   2. extract  -- ONLY the participant's own agent directory, into example/agents/<team-id>/
#   3. check    -- check:strategy over the extracted code (cheatcode static check, ADR 0006 §5)
#   4. build    -- eris-agent:<team-id>, and print the digest that the replay audit checks
#
# Step 2 takes the participant's directory and NOTHING else. The bundle also carries sdk/, runtime/
# and lib/; those are the operator's, step 1 has already proved they are byte-identical to this
# repo's, and copying a participant's copy over the operator's is how a tampered runtime would get
# in through the back door after passing the front one.
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"
ZIP="${1:?usage: accept-submission.sh <submission.zip> <team-id>}"
TEAM="${2:?usage: accept-submission.sh <submission.zip> <team-id>}"
echo "$TEAM" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' || { echo "invalid team id: $TEAM" >&2; exit 1; }
[ -f "$ZIP" ] || { echo "no such file: $ZIP" >&2; exit 1; }
DEST="example/agents/$TEAM"

step() { printf '\n=== %s ===\n' "$*"; }

step "1/4 scan"
python3 infra/submission/scan-submission.py "$ZIP" || { echo "REJECTED by scan — not accepting" >&2; exit 1; }

step "2/4 extract the participant's agent directory"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
unzip -q "$ZIP" -d "$TMP" || { echo "unzip failed" >&2; exit 1; }
# The agent dir is the one under agents/ that is neither runtime nor lib.
SRC=""
for d in "$TMP"/agents/*/; do
  b=$(basename "$d"); case "$b" in runtime|lib) continue;; esac
  [ -n "$SRC" ] && { echo "bundle carries more than one agent directory ($SRC and $b)" >&2; exit 1; }
  SRC="$d"
done
[ -n "$SRC" ] || { echo "no agent directory found under agents/ in the bundle" >&2; exit 1; }
[ -f "$SRC/agent.ts" ]  || { echo "$(basename "$SRC") has no agent.ts" >&2; exit 1; }
[ -f "$SRC/prompt.md" ] || { echo "$(basename "$SRC") has no prompt.md (rules §2.5)" >&2; exit 1; }
[ -e "$DEST" ] && { echo "$DEST already exists — remove it first if this is a resubmission" >&2; exit 1; }
mkdir -p "$DEST" && cp -r "$SRC". "$DEST"/
echo "  $(basename "$SRC") -> $DEST  ($(find "$DEST" -type f | wc -l) files)"

step "3/4 check:strategy"
npx tsx scripts/checkStrategyCode.ts "$DEST"/*.ts 2>&1 | tail -3
[ "${PIPESTATUS[0]}" = 0 ] || { echo "check:strategy found issues — see above" >&2; rm -rf "$DEST"; exit 1; }

step "4/4 build eris-agent:$TEAM"
npm run agent:build -- team "$TEAM" 2>&1 | tail -2
DIGEST=$(docker image inspect "eris-agent:$TEAM" --format '{{.Id}}' 2>/dev/null)
[ -n "$DIGEST" ] || { echo "image not found after build" >&2; exit 1; }

cat <<DONE

  accepted: $TEAM
  image:    eris-agent:$TEAM
  digest:   $DIGEST

  Record that digest. runs/<id>/images.jsonl logs it again at spawn, and the replay audit is the
  comparison between the two.

  Add the roster entry to the competition config:
    - id: $TEAM
      dir: $TEAM
      wallet: AUTO
DONE
