#!/usr/bin/env bash
# Build, run and report the exact coordinator result under the competition's container caps.
# A local-deploy chain must be running; see README.md for setup and ERIS_SELFTEST_CONFIG.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
exec node --import tsx scripts/agentSelftest.ts "$@"
