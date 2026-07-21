#!/usr/bin/env bash
# Bootstrap that clones the external vendor repo (GMX) and applies the localhost patch.
# Curve ships prebuilt bytecode in vendor/curve, so no rebuild is needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GMX_REPO="https://github.com/gmx-io/gmx-synthetics.git"
GMX_SHA="028c79a7264fd458e2fc27c809750d919831c74b" # upstream commit the patch was made against
GMX_DIR="vendor/gmx-src"
PATCH="vendor/gmx-localhost.patch"

echo "==> Setting up GMX (gmx-synthetics)"
if [ ! -d "$GMX_DIR/.git" ]; then
  echo "  clone $GMX_REPO"
  if [ -d "$GMX_DIR" ] && [ -n "$(ls -A "$GMX_DIR" 2>/dev/null)" ]; then
    # dir exists without .git (leftover deployments/ etc.) — `git clone` refuses
    # non-empty targets, so clone in place via init + fetch instead
    git -C "$GMX_DIR" init -q
    git -C "$GMX_DIR" remote add origin "$GMX_REPO"
  else
    git clone "$GMX_REPO" "$GMX_DIR"
  fi
fi
git -C "$GMX_DIR" fetch --depth 1 origin "$GMX_SHA" 2>/dev/null || git -C "$GMX_DIR" fetch origin
git -C "$GMX_DIR" checkout -q "$GMX_SHA"
echo "  apply $PATCH"
# Do nothing if already applied
if git -C "$GMX_DIR" apply --reverse --check "../../$PATCH" 2>/dev/null; then
  echo "  (patch already applied)"
elif git -C "$GMX_DIR" apply --check "../../$PATCH" 2>/dev/null; then
  git -C "$GMX_DIR" apply "../../$PATCH"
  echo "  patch applied"
else
  echo "  ERROR: $PATCH does not apply cleanly — the vendor tree likely has an older version of the patch applied." >&2
  echo "  Reset it with: npm run clean:vendors   (then re-run this script)" >&2
  exit 1
fi
echo "  yarn install (this takes a while)"
(cd "$GMX_DIR" && yarn install)

echo "==> Setting up Aave (hardhat subproject)"
(cd vendor/aave && npm install)

echo "==> Done. Curve (stableswap-ng / twocrypto-ng) ships bytecode in vendor/curve, so no extra work is needed."
echo "    Rebuild steps (Docker vyper 0.3.10):"
echo "      stableswap-ng: curvefi/stableswap-ng -> vendor/curve/CurveStableSwapNG*.json"
echo "      twocrypto-ng : curvefi/twocrypto-ng tag lite-0.3.10 -> vendor/curve/CurveTwocrypto*.json"
echo "        docker run --rm -v \$PWD:/code -w /code vyperlang/vyper:0.3.10 -f bytecode <contract>.vy"
echo "        (AMM=CurveTwocryptoOptimized uses -f blueprint_bytecode)"
