#!/usr/bin/env bash
# Reset vendor clones to their pristine upstream state (discard the applied localhost patch).
# Use when vendor/gmx-localhost.patch has been updated: clean, then re-run setup-vendors.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GMX_DIR="vendor/gmx-src"

if [ ! -d "$GMX_DIR/.git" ]; then
  echo "$GMX_DIR is not cloned yet — nothing to clean (./scripts/setup-vendors.sh clones it)"
  exit 0
fi

git -C "$GMX_DIR" checkout -q -- .
echo "==> $GMX_DIR reset to pristine upstream (patch discarded)"
echo "    Re-apply with: ./scripts/setup-vendors.sh"
