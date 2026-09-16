#!/usr/bin/env bash
# Bring a bare Ubuntu 24.04 box to the point where `docker compose up -d` works.
#
# Idempotent: safe to re-run. Vendor-agnostic: it only assumes Ubuntu 24.04 + outbound network, so
# the same script serves Cherry Servers, OVH, Hetzner or a laptop. The vendor-specific part is the
# 20 lines of Terraform next to this file, not this script.
#
#   sudo ASCON_USER=ascon ./bootstrap.sh
#
# What it deliberately does NOT do: start the stack. Two things still need a human — the venues
# state dump (`npm run gen:state-dump`, see infra/monitoring/docker-compose.yml anvil-state-init)
# and the gitignored secrets (infra/monitoring/grafana/secret.env, .env.local). Starting without
# them fails loudly, which is the intent.
set -euo pipefail

ASCON_USER="${ASCON_USER:-ascon}"
ERIS_REPO="${ERIS_REPO:-https://github.com/NyxFoundation/eris-agent-simulator.git}"
ERIS_REF="${ERIS_REF:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"
HOME_DIR="/home/${ASCON_USER}"
ERIS_ROOT="${HOME_DIR}/workspace/eris-agent-simulator"
ASCON_LOGS="${HOME_DIR}/ascon-logs"

log() { printf '\n=== %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# sysstat: gohanserver was NixOS without iostat, so infra monitoring reads /proc/diskstats directly.
# On Ubuntu the standard tool is one apt away; keep both paths working.
apt-get install -y -qq ca-certificates curl git jq unzip sysstat ripgrep >/dev/null

log "user ${ASCON_USER}"
id -u "$ASCON_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$ASCON_USER"

log "docker engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
usermod -aG docker "$ASCON_USER"
systemctl enable --now docker

log "node ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

log "yarn (classic)"
# deployer/scripts/setup-vendors.sh runs `yarn install` for GMX and `npm install` for Aave. Without
# yarn it exits 127 having already cloned 1.1 GB of GMX, so the tree LOOKS set up -- the vendor
# directories all exist -- and the failure only surfaces later as a deploy that cannot compile.
command -v yarn >/dev/null 2>&1 || npm install -g yarn >/dev/null

log "foundry (stable, NOT nightly)"
# docs/18: on a dev build `setup-vendors.sh` exits 1 because the new solar parser rejects Liquity V1
# (compilation itself succeeds; it is the lint that fails). Pin stable and keep the escape hatch.
sudo -u "$ASCON_USER" -H bash -lc '
  set -e
  export PATH="$HOME/.foundry/bin:$PATH"
  command -v foundryup >/dev/null 2>&1 || curl -fsSL https://foundry.paradigm.xyz | bash
  "$HOME/.foundry/bin/foundryup" --install stable
'
grep -q 'foundry/bin' "${HOME_DIR}/.bashrc" 2>/dev/null || \
  echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> "${HOME_DIR}/.bashrc"
grep -q 'FOUNDRY_LINT_LINT_ON_BUILD' "${HOME_DIR}/.bashrc" 2>/dev/null || \
  echo 'export FOUNDRY_LINT_LINT_ON_BUILD=false' >> "${HOME_DIR}/.bashrc"

log "checkout"
sudo -u "$ASCON_USER" -H bash -lc "
  set -e
  mkdir -p '${HOME_DIR}/workspace' '${ASCON_LOGS}/rpc'
  [ -d '${ERIS_ROOT}/.git' ] || git clone --depth 50 '${ERIS_REPO}' '${ERIS_ROOT}'
  cd '${ERIS_ROOT}' && git fetch --depth 50 origin '${ERIS_REF}' && git checkout '${ERIS_REF}' && git pull --ff-only
"

log "infra/monitoring/.env"
# These used to be hard-coded to /home/gohan in docker-compose.yml, which is what tied the stack to
# one box. Compose now fails loudly if they are unset.
sudo -u "$ASCON_USER" tee "${ERIS_ROOT}/infra/monitoring/.env" >/dev/null <<ENVEOF
ERIS_ROOT=${ERIS_ROOT}
ASCON_LOGS=${ASCON_LOGS}
ENVEOF

log "systemd units"
sed -e "s#%h/workspace/eris-agent-simulator#${ERIS_ROOT}#g" \
    -e "s#^Environment=PATH=.*#Environment=PATH=${HOME_DIR}/.foundry/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin#" \
    "${ERIS_ROOT}/infra/devnet/ascon-devnet.service" > /etc/systemd/system/ascon-devnet.service
sed -i "s#^\(\[Service\]\)#\1\nUser=${ASCON_USER}#" /etc/systemd/system/ascon-devnet.service
sed -i "s#^WantedBy=default.target#WantedBy=multi-user.target#" /etc/systemd/system/ascon-devnet.service
systemctl daemon-reload
# not enabled here: the period starts when an operator starts it, not when the box boots.

log "cron: anvil tmp cleanup"
# docs/18 §6: ~/.foundry/anvil/tmp/anvil-state-* is ~21 GB per anvil start and is NOT removed when
# that anvil exits. Three runs filled 55 GB. This is the difference between a box that lasts the
# period and one that hits ENOSPC (which cost the dev side 7 scenarios on 2026-08-23).
cat > /etc/cron.d/ascon-anvil-tmp <<CRONEOF
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
17 * * * * ${ASCON_USER} find ${HOME_DIR}/.foundry/anvil/tmp -maxdepth 1 -name 'anvil-state-*' -mmin +120 -exec rm -rf {} + 2>/dev/null
CRONEOF
chmod 0644 /etc/cron.d/ascon-anvil-tmp

log "done"
cat <<DONEEOF

Still to do by hand on this box:
  1. cd ${ERIS_ROOT} && npm ci && (cd deployer && npm ci)
  2. deployer/scripts/setup-vendors.sh     # clones GMX (~1.1 GB) + Liquity, yarn/npm install
     #  It exits non-zero after a SUCCESSFUL compile (docs/18), so check artefacts, not \$?:
     #    deployer/vendor/gmx-src/node_modules, deployer/vendor/aave/node_modules,
     #    deployer/vendor/liquity-src, deployer/vendor/curve
  3. (cd deployer && npm run deploy -- --keep-fresh) &   # leaves an anvil on :8545
     npm run gen:state-dump                              # writes backtest/state/venues-state.json
     #  the monitoring stack REFUSES to start without it (anvil-state-init)
  4. infra/monitoring/grafana/secret.env   (Slack token, Grafana admin pw, renderer token)
  5. .env.local                            (ANVIL_RPC_URL / CHAIN_ID / TREASURY_PRIVATE_KEY)
  6. cloudflared: install, then put the tunnel credentials in place and copy
     infra/cloudflared/config.yml to /etc/cloudflared/config.yml  (see infra/provision/README.md)
  7. cd infra/monitoring && docker compose up -d
DONEEOF
