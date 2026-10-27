# shellcheck shell=bash
# shellcheck disable=SC2034 # the constants are read by the scripts that source this file
# Shared by run-week.sh and cutover.sh. Sourced, never run.
#
# Everything the week reads comes from ONE secrets directory ($ERIS_LIVE_SECRETS, default
# ~/live-secrets, mode 700, never in a repository). See README.md for its contents.

LW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The checkout the week runs from: the one these scripts live in, unless ERIS_REPO says otherwise.
REPO="${ERIS_REPO:-$(cd "$LW_DIR/../.." && pwd)}"
SECRETS="${ERIS_LIVE_SECRETS:-$HOME/live-secrets}"
STATE_DIR="$REPO/backtest/state"
DUMP="$STATE_DIR/venues-state.json"
MANIFEST="$STATE_DIR/manifest.json"
OVERLAY="$REPO/sdk/src/constants.local.ts"
# The production dump was made with anvil 1.7.1, and versions have behaved differently (issue #135).
# Set ERIS_LIVE_ANVIL_VERSION= (empty) to skip the check.
ANVIL_VERSION="${ERIS_LIVE_ANVIL_VERSION-1.7.1}"
# The week's coordinator and scorer run on the host's Node (npm run backtest), the agents, gateway and
# inference proxy on node:24.22.1-bookworm-slim, and CI tests 24.22.1. A host left on another major
# would run the scorer on a Node nothing tested (issue #330 was a 22 -> 24 difference), and nothing
# else here looks. Set ERIS_LIVE_NODE_VERSION= (empty) to skip the check.
NODE_VERSION="${ERIS_LIVE_NODE_VERSION-24.22.1}"

CHAIN_NET=ascon-chain
GATEWAY_CT=ascon-rpc-gateway-live
PROXY_CT=ascon-inference-proxy
# Host-side ports. The gateway is NOT published on 8546: the practice devnet's public tunnel forwards
# localhost:8546, so publishing the live gateway there would put the live chain on the internet if the
# tunnel were still up. The agents reach the gateway by container name; the host port is only for the
# operator's own curl.
GATEWAY_HOST_PORT="${ERIS_LIVE_GATEWAY_HOST_PORT:-18546}"
PROXY_PORT=8790
ANVIL_PORT=8547 # the backtest's own anvil (npm run backtest --port default)
TMUX_SESSION="${ERIS_LIVE_TMUX_SESSION:-live-week}"
IN_IMAGE_OVERLAY=/eris/sdk/src/constants.local.ts

export PATH="$HOME/.foundry/bin:$PATH"

LW_NAME="${LW_NAME:-live-week}"
say() { printf '[%s] %s\n' "$LW_NAME" "$*"; }
ok() { printf '[%s]   ok    %s\n' "$LW_NAME" "$*"; }
warn() { printf '[%s]   WARN  %s\n' "$LW_NAME" "$*" >&2; }
die() {
  printf '[%s]   FAIL  %s\n' "$LW_NAME" "$*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# The fingerprint stamped in a constants.local.ts read on stdin (core/src/backtest/shared.ts).
overlay_fp_stdin() { sed -n 's/^export const DEPLOYMENTS_FINGERPRINT = "\(.*\)";$/\1/p'; }
manifest_fp() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deploymentsFingerprint"])' "$MANIFEST"
}
# The overlay an image carries (issue #310): run-agent.sh images keep it at $IN_IMAGE_OVERLAY.
image_overlay_fp() {
  docker run --rm --network none --entrypoint cat "$1" "$IN_IMAGE_OVERLAY" 2>/dev/null | overlay_fp_stdin
}

# scripts/liveWeek.ts (the tested helpers).
lw() { (cd "$REPO" && node --import tsx scripts/liveWeek.ts "$@"); }

docker0_addr() { ip -4 addr show docker0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1; }

# The tracked tree is the frozen commit plus the overlay regenerated from the dump, nothing else.
check_frozen() {
  [ -s "$SECRETS/frozen-commit" ] || die "no $SECRETS/frozen-commit: run cutover.sh freeze first"
  local want head dirty
  want=$(cat "$SECRETS/frozen-commit")
  head=$(git -C "$REPO" rev-parse HEAD)
  [ "$want" = "$head" ] || die "HEAD is $head but the frozen commit is $want ($REPO)"
  dirty=$(git -C "$REPO" diff --name-only HEAD | grep -vx 'sdk/src/constants.local.ts' || true)
  [ -z "$dirty" ] || die "tracked files differ from the frozen commit: $(echo "$dirty" | tr '\n' ' ')"
  ok "checkout is the frozen commit ${want:0:12} (+ the regenerated overlay only)"
}

check_dump() {
  [ -s "$SECRETS/dump.sha256" ] || die "no $SECRETS/dump.sha256: run cutover.sh dump --dump-sha256 <hex> first"
  [ -s "$DUMP" ] && [ -s "$MANIFEST" ] || die "no state dump at $STATE_DIR (venues-state.json + manifest.json)"
  local want got
  want=$(tr -d ' \n' <"$SECRETS/dump.sha256")
  got=$(sha256_of "$DUMP")
  [ "$want" = "$got" ] || die "$DUMP sha256 is $got, expected $want"
  ok "state dump sha256 $got"
}

check_overlay() {
  [ -s "$MANIFEST" ] || die "no $MANIFEST"
  local m o
  m=$(manifest_fp)
  o=$(overlay_fp_stdin <"$OVERLAY")
  [ "$m" = "$o" ] || die "sdk/src/constants.local.ts is ${o:-unstamped}, the dump is $m: run cutover.sh overlay"
  ok "address overlay matches the dump (${m:0:20}...)"
}

check_anvil_version() {
  command -v anvil >/dev/null || die "anvil not on PATH (~/.foundry/bin)"
  [ -z "$ANVIL_VERSION" ] && { warn "anvil version not checked (ERIS_LIVE_ANVIL_VERSION is empty)"; return; }
  local v
  v=$(anvil --version 2>/dev/null | head -1)
  echo "$v" | grep -qF "$ANVIL_VERSION" || die "anvil is '$v', the dump was made with $ANVIL_VERSION (foundryup -i v$ANVIL_VERSION)"
  ok "anvil $ANVIL_VERSION"
}

# The major must match; a different patch only warns (apt can move the host's within 24.x).
check_node_version() {
  [ -z "$NODE_VERSION" ] && { warn "node version not checked (ERIS_LIVE_NODE_VERSION is empty)"; return; }
  local v
  v=$(node -p 'process.versions.node' 2>/dev/null) || die "node not on PATH"
  [ "${v%%.*}" = "${NODE_VERSION%%.*}" ] ||
    die "node is $v, the week runs on $NODE_VERSION (curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION%%.*}.x | sudo -E bash - && sudo apt-get install -y nodejs)"
  if [ "$v" = "$NODE_VERSION" ]; then ok "node $v"; else warn "node is $v, the images and CI are $NODE_VERSION"; fi
}
