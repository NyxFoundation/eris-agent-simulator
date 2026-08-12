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

# --- Liquity V1 (issue #39) ---------------------------------------------------
# Source rather than prebuilt bytecode, unlike Curve: foundry compiles the whole system with
# solc 0.6.11 in a few seconds and Liquity has no external dependencies (its SafeMath/Ownable are
# vendored copies under Dependencies/), so there is nothing to gain by committing artifacts -- and
# not committing them keeps someone else's code out of this repository.
#
# The repository is GPL-3.0 but every contract source carries `SPDX-License-Identifier: MIT`,
# which is the file this build consumes.
LIQUITY_REPO="https://github.com/liquity/dev.git"
LIQUITY_SHA="3e64ee1b52c50d51587c64c1cf75e0ba82934979" # pinned so the ABI cannot shift under a redeploy
LIQUITY_DIR="vendor/liquity-src"

echo "==> Setting up Liquity V1"
if [ ! -d "$LIQUITY_DIR/.git" ]; then
  echo "  clone $LIQUITY_REPO (sparse: packages/contracts)"
  git clone --filter=blob:none --sparse "$LIQUITY_REPO" "$LIQUITY_DIR"
  git -C "$LIQUITY_DIR" sparse-checkout set packages/contracts
fi
if ! git -C "$LIQUITY_DIR" checkout -q "$LIQUITY_SHA" 2>/dev/null; then
  echo "  pinned commit not present, fetching"
  git -C "$LIQUITY_DIR" fetch origin
  git -C "$LIQUITY_DIR" checkout -q "$LIQUITY_SHA"
fi

# LUSD -> eUSD. The token's name and symbol are the only source-level change the simulation makes;
# everything the mechanism depends on (Recovery Mode, redistribution, the fee curves, the sorted
# list) is untouched. sed rather than a patch file so a re-clone cannot leave it half-applied.
LUSD_SRC="$LIQUITY_DIR/packages/contracts/contracts/LUSDToken.sol"
if grep -q '"LUSD Stablecoin"' "$LUSD_SRC"; then
  sed -i.bak 's/"LUSD Stablecoin"/"eUSD Stablecoin"/; s/_SYMBOL = "LUSD"/_SYMBOL = "eUSD"/' "$LUSD_SRC"
  rm -f "$LUSD_SRC.bak"
  echo "  renamed the stablecoin to eUSD"
fi

# Its own foundry project: solc 0.6.11 against the deployer's 0.8.20, and the test/proxy/LP trees
# pull in solc ^0.4.23 and @openzeppelin, neither of which this deployment needs.
cat > "$LIQUITY_DIR/packages/contracts/foundry.toml" <<'TOML'
[profile.default]
src = "contracts"
out = "out"
libs = []
solc = "0.6.11"
optimizer = true
optimizer_runs = 100
skip = [
  "contracts/TestContracts/**",
  "contracts/LPRewards/**",
  "contracts/Proxy/**",
  "contracts/Integrations/**",
]
TOML
echo "  forge build (solc 0.6.11)"
(cd "$LIQUITY_DIR/packages/contracts" && forge build)

echo "==> Done. Curve (stableswap-ng / twocrypto-ng) ships bytecode in vendor/curve, so no extra work is needed."
echo "    Rebuild steps (Docker vyper 0.3.10):"
echo "      stableswap-ng: curvefi/stableswap-ng -> vendor/curve/CurveStableSwapNG*.json"
echo "      twocrypto-ng : curvefi/twocrypto-ng tag lite-0.3.10 -> vendor/curve/CurveTwocrypto*.json"
echo "        docker run --rm -v \$PWD:/code -w /code vyperlang/vyper:0.3.10 -f bytecode <contract>.vy"
echo "        (AMM=CurveTwocryptoOptimized uses -f blueprint_bytecode)"
