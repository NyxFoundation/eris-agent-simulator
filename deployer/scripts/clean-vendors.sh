#!/usr/bin/env bash
# Reset vendor clones to their pristine upstream state (discard the applied patches).
# Use when vendor/gmx-localhost.patch or vendor/liquity-mcr.patch has been updated: clean, then
# re-run setup-vendors.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GMX_DIR="vendor/gmx-src"
LIQUITY_DIR="vendor/liquity-src"

if [ ! -d "$GMX_DIR/.git" ]; then
  echo "$GMX_DIR is not cloned yet — nothing to clean (./scripts/setup-vendors.sh clones it)"
else
  git -C "$GMX_DIR" checkout -q -- .
  # checkout only restores tracked files; the patch also CREATES files (e.g.
  # utils/setBalanceCompat.ts) which stay behind as untracked and make the next
  # `git apply --check` fail with "already exists". -fd respects .gitignore, so
  # node_modules/ and deployments/localhost/ survive.
  git -C "$GMX_DIR" clean -qfd
  echo "==> $GMX_DIR reset to pristine upstream (patch discarded)"
fi

# Liquity's patch only edits tracked files (the MCR constant), and so does the eUSD rename, so a
# checkout undoes both; setup-vendors.sh re-applies them and rebuilds out/. No clean: the untracked
# files there are the build (out/, cache/) and the foundry.toml setup-vendors.sh writes.
if [ ! -d "$LIQUITY_DIR/.git" ]; then
  echo "$LIQUITY_DIR is not cloned yet — nothing to clean (./scripts/setup-vendors.sh clones it)"
else
  git -C "$LIQUITY_DIR" checkout -q -- .
  echo "==> $LIQUITY_DIR reset to pristine upstream (MCR patch and eUSD rename discarded)"
fi
echo "    Re-apply with: ./scripts/setup-vendors.sh"
