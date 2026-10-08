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
#
# Step 2 also re-scans what `unzip` actually wrote, because the scan in step 1 reads the archive
# with Python's zipfile and the extraction uses Info-ZIP. They disagree on symlinks (zipfile writes
# the link target as a small text file; unzip makes a real link that the copy then follows into
# another team's directory) and can disagree on malformed archives. Accepting what was scanned
# rather than what was extracted is how a submission smuggles in code nobody looked at.
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
# Only regular files and directories. A symlink here would be followed by the copy below (macOS
# `cp -r` dereferences) or by the image build, pulling in files from outside the submission.
ODD=$(find "$TMP" ! -type f ! -type d)
[ -z "$ODD" ] || { echo "REJECTED: bundle contains symlinks or special files:" >&2; echo "$ODD" | sed "s|^$TMP/|  |" >&2; exit 1; }
python3 infra/submission/scan-submission.py "$TMP" >/dev/null \
  || { python3 infra/submission/scan-submission.py "$TMP" >&2; echo "REJECTED by scan of the extracted tree" >&2; exit 1; }
# The agent dir is the one under agents/ that is neither runtime nor lib.
SRC=""
for d in "$TMP"/agents/*/; do
  b=$(basename "$d"); case "$b" in runtime|lib) continue;; esac
  [ -n "$SRC" ] && { echo "bundle carries more than one agent directory ($SRC and $b)" >&2; exit 1; }
  SRC="$d"
done
[ -n "$SRC" ] || { echo "no agent directory found under agents/ in the bundle" >&2; exit 1; }
# TypeScript or Python (ADR 0025): bundleAgent makes the two entry points exclusive, so a Python
# submission carries strategy.py and no agent.ts. Requiring agent.ts rejected every Python bundle the
# documented path tells participants to build.
if   [ -f "$SRC/agent.ts" ];    then ENTRY=agent.ts
elif [ -f "$SRC/strategy.py" ]; then ENTRY=strategy.py
else echo "$(basename "$SRC") has neither agent.ts nor strategy.py" >&2; exit 1
fi
[ -f "$SRC/prompt.md" ] || { echo "$(basename "$SRC") has no prompt.md (rules §2.5)" >&2; exit 1; }
[ -e "$DEST" ] && { echo "$DEST already exists — remove it first if this is a resubmission" >&2; exit 1; }
mkdir -p "$DEST" && cp -RP "$SRC". "$DEST"/
[ -z "$(find "$DEST" ! -type f ! -type d)" ] || { echo "non-regular file appeared in $DEST" >&2; rm -rf "$DEST"; exit 1; }
echo "  $(basename "$SRC") -> $DEST  ($(find "$DEST" -type f | wc -l) files)"

step "3/4 check:strategy"
# The static check reads the strategy's source whichever language it is in; the glob has to follow
# the entry point, because "$DEST"/*.ts does not expand for a Python submission.
case "$ENTRY" in
  agent.ts)    STRATEGY_FILES=("$DEST"/*.ts) ;;
  strategy.py) STRATEGY_FILES=("$DEST"/*.py) ;;
esac
npx tsx scripts/checkStrategyCode.ts "${STRATEGY_FILES[@]}" 2>&1 | tail -3
[ "${PIPESTATUS[0]}" = 0 ] || { echo "check:strategy found issues — see above" >&2; rm -rf "$DEST"; exit 1; }

step "4/4 build eris-agent:$TEAM"
# A resubmission's tag may already exist from the last accepted one. The build's own exit code is
# what says this ZIP became an image; `docker image inspect` after a failed build would happily
# return the previous submission's id, and that id would be recorded as this one's (issue #261).
BEFORE=$(docker image inspect "eris-agent:$TEAM" --format '{{.Id}}' 2>/dev/null || true)
npm run agent:build -- team "$TEAM" 2>&1 | tail -2
[ "${PIPESTATUS[0]}" = 0 ] || { echo "build failed — not accepting (the previous image${BEFORE:+ $BEFORE} is untouched)" >&2; rm -rf "$DEST"; exit 1; }
DIGEST=$(docker image inspect "eris-agent:$TEAM" --format '{{.Id}}' 2>/dev/null)
[ -n "$DIGEST" ] || { echo "image not found after build" >&2; rm -rf "$DEST"; exit 1; }
# Same id as before is possible and fine (byte-identical submission, docker reused the layers);
# it is said so the operator does not take it for a stale one.
[ -n "$BEFORE" ] && [ "$BEFORE" = "$DIGEST" ] && echo "  (same image id as the previous submission: identical contents)"

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
