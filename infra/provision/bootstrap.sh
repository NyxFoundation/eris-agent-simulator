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

log "docker address pools"
# The default pools yield ~27 networks. ERIS_AGENT_ISOLATE=1 takes one per agent, so the 28th
# participant onward cannot start -- and run-agent.sh swallows the create error, so what surfaces is
# "network ag-<id> not found" from docker run. Measured on ascon-live 2026-09-17.
install -d /etc/docker
if ! grep -q default-address-pools /etc/docker/daemon.json 2>/dev/null; then
  python3 - <<'PY'
import json, os
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
d["default-address-pools"] = [{"base": "10.200.0.0/12", "size": 24}]   # 4096 networks
json.dump(d, open(p, "w"), indent=2)
PY
  DOCKER_DAEMON_CHANGED=1
fi
# The default for every container the compose files do not cap themselves -- the live week's agents
# (`docker run` in infra/docker-agent/run-agent.sh) above all. Docker keeps json-file logs forever by
# default; on 2026-10-08 one container's wrote 699 GB and filled the practice box. Applies to
# containers created after the daemon restarts below.
if ! grep -q '"log-opts"' /etc/docker/daemon.json 2>/dev/null; then
  python3 - <<'PY2'
import json, os
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
d["log-driver"] = "json-file"
d["log-opts"] = {"max-size": "100m", "max-file": "3"}
json.dump(d, open(p, "w"), indent=2)
PY2
  DOCKER_DAEMON_CHANGED=1
fi

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
# the pool change only takes effect on a daemon restart
[ "${DOCKER_DAEMON_CHANGED:-0}" = 1 ] && systemctl restart docker && sleep 5 || true

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
  mkdir -p '${HOME_DIR}/workspace'
  [ -d '${ERIS_ROOT}/.git' ] || git clone --depth 50 '${ERIS_REPO}' '${ERIS_ROOT}'
  cd '${ERIS_ROOT}' && git fetch --depth 50 origin '${ERIS_REF}' && git checkout '${ERIS_REF}' && git pull --ff-only
"

log "host paths the compose stack bind-mounts"
# Every directory infra/monitoring/docker-compose.yml bind-mounts from the host, created here as the
# service user. Docker creates a missing bind source itself, as root:root 755, and each of these is
# written by something that runs as ${ASCON_USER}:
#   runs/                     the coordinator (promtail and eris-exporter mount it read-only). Left
#                             to compose, the first start died with `EACCES: mkdir 'runs/<id>'` and
#                             the unit spent its three starts in 90 s (issue #158)
#   ascon-logs/rpc            the gateways' call logs
#   ascon-participant-tokens  infra/access/issue-key.sh's default output, which the live gateway
#                             mounts as ASCON_KEYS_DIR. 0700: the handout CSV lands beside the digests
# venues-state.json is the one bind source not created here, on purpose: compose refuses to invent
# it (create_host_path: false) and anvil-state-init says what to run instead.
ASCON_KEYS_DIR="${HOME_DIR}/ascon-participant-tokens"
sudo -u "$ASCON_USER" mkdir -p "${ERIS_ROOT}/runs" "${ASCON_LOGS}/rpc" "${ASCON_KEYS_DIR}"
chmod 700 "${ASCON_KEYS_DIR}"
# On a box where compose already ran, these exist as root. Hand them back rather than leave the trap.
chown "${ASCON_USER}:${ASCON_USER}" "${ERIS_ROOT}/runs" "${ASCON_LOGS}" "${ASCON_LOGS}/rpc" "${ASCON_KEYS_DIR}"

log "infra/monitoring/.env"
# These used to be hard-coded to /home/gohan in docker-compose.yml, which is what tied the stack to
# one box. Compose now fails loudly if they are unset. Only missing keys are added: the operator
# writes more into this file later (ERIS_DASHBOARD_COMPETITIONS, a different ASCON_KEYS_DIR), and a
# re-run of this script must not take those back.
MON_ENV="${ERIS_ROOT}/infra/monitoring/.env"
sudo -u "$ASCON_USER" touch "$MON_ENV"
for kv in "ERIS_ROOT=${ERIS_ROOT}" "ASCON_LOGS=${ASCON_LOGS}" "ASCON_KEYS_DIR=${ASCON_KEYS_DIR}"; do
  grep -q "^${kv%%=*}=" "$MON_ENV" || echo "$kv" | sudo -u "$ASCON_USER" tee -a "$MON_ENV" >/dev/null
done

log "systemd user unit"
# A user unit, as infra/devnet/README.md installs it and as every `systemctl --user` command in the
# docs, the checklist and the stall alert addresses. This used to install a *system* unit instead,
# so on a bootstrapped box each of those commands talked to a unit that did not exist, and a drop-in
# under ~/.config/systemd/user/ascon-devnet.service.d/ was never read (issue #158).
#
# Linked unchanged: WorkingDirectory, PATH and ExecStartPre are all under %h, which is ${HOME_DIR}.
if [ -f /etc/systemd/system/ascon-devnet.service ]; then
  if systemctl is-active --quiet ascon-devnet.service; then
    # Stopping it ends the period (infra/devnet/README.md). That is an operator's call, not a script's.
    echo "WARNING: the system unit an earlier bootstrap installed is running the period; left as it is." >&2
    echo "         Move to the user unit at the next planned restart: stop it, then re-run this script." >&2
  else
    systemctl disable ascon-devnet.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/ascon-devnet.service
    systemctl daemon-reload
  fi
fi
sudo -u "$ASCON_USER" mkdir -p "${HOME_DIR}/.config/systemd/user"
sudo -u "$ASCON_USER" ln -sf "${ERIS_ROOT}/infra/devnet/ascon-devnet.service" \
  "${HOME_DIR}/.config/systemd/user/ascon-devnet.service"
# User units die with the last session unless the user lingers, and the box is headless.
loginctl enable-linger "$ASCON_USER"
# Picks the link up now if the user manager is already running; otherwise it reads it when it starts.
systemctl --user -M "${ASCON_USER}@" daemon-reload 2>/dev/null || true
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

Still to do by hand on this box. This order is the one that works on a machine with nothing
cached -- every step below was a separate failure the first time, because gohanserver had all of
it left over from earlier runs and none of it was written down:

  1. cd ${ERIS_ROOT} && npm ci && (cd deployer && npm ci)
  2. deployer/scripts/setup-vendors.sh     # clones GMX (~1.1 GB) + Liquity, yarn/npm install
     #  Exits non-zero in BOTH directions -- 127 on a missing tool (having already cloned GMX, so
     #  the tree looks complete) and non-zero after a SUCCESSFUL compile (docs/18). Check artefacts:
     #    deployer/vendor/gmx-src/node_modules, deployer/vendor/aave/node_modules,
     #    deployer/vendor/liquity-src, deployer/vendor/curve
  3. (cd deployer && npm run build:contracts)   # the deployer's own contracts
     npm run build:contracts                    # AND the root's -- gmx.ts setupGlobal reads
     #  out/MockOracleProvider.sol/... even when gmx is not in run.protocols
  4. cp config/example.yaml config/local.yaml
     #  bench/lib/mkconfig.py opens config/local.yaml directly; unlike the rest of the codebase it
     #  does not fall back to example.yaml
  5. (cd deployer && npm run deploy -- --keep-fresh) &   # leaves an anvil on :8545; ~25 min, GMX is most of it
     #  WAIT for it: gmxV2 must appear in deployer/deployments/deployments.json AND deploy.log must
     #  stop growing for 90s. Block-number-stops-moving is NOT a completion signal.
     rm -f .local-snapshot                                # gen:state-dump reverts to it -- see README
     npm run gen:state-dump                               # writes backtest/state/venues-state.json
     #  ~32 MB with all eight protocols. The monitoring stack REFUSES to start without it.
  6. sanity-check the box before trusting any measurement:
     bench/run.sh --clones bench-max --agents 100 --blocks 200 --block-time 2
     #  round_timing.totalMs max must stay under 2000 ms, and blocks.csv should show ~190 tx/round.
     #  Plain `--agents 100` is venue-arb clones: 21 tx/round, passes trivially, measures nothing.
  4. infra/monitoring/grafana/secret.env   (Slack token, Grafana admin pw, renderer token)
  5. .env.local                            (ANVIL_RPC_URL / CHAIN_ID / TREASURY_PRIVATE_KEY)
  6. cloudflared: install, then put the tunnel credentials in place and copy
     infra/cloudflared/config.yml to /etc/cloudflared/config.yml  (see infra/provision/README.md)
  7. cd infra/monitoring && docker compose up -d
DONEEOF
