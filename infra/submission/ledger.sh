#!/usr/bin/env bash
# The acceptance ledger (rules §2.2): one line per accept-submission.sh run, and the evaluated
# submission per unit. A wrapper for scripts/submissionLedger.ts, runnable from anywhere.
#
#   infra/submission/ledger.sh final --ledger ~/ascon/ledger.jsonl --deadline 2026-11-30T15:00:00Z
#   infra/submission/ledger.sh check --ledger ~/ascon/ledger.jsonl --unit team-kappa
#
# accept-submission.sh calls `record` itself when ERIS_SUBMISSION_LEDGER is set.
set -euo pipefail
# Paths in the arguments are the caller's, so this does not cd.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$REPO/node_modules/.bin/tsx" "$REPO/scripts/submissionLedger.ts" "$@"
