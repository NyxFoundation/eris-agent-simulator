#!/usr/bin/env bash
# Local Blockscout explorer for the sim anvil (issue #31). Thin driver around docker
# compose; all configuration lives in explorer.env next to this script.
#
#   explorer.sh up            start (or restart) the stack against the anvil in explorer.env;
#                             always restarts the proxy so an edited proxy/ template takes effect,
#                             then fails unless the JSON-RPC relay answers 403
#   explorer.sh down          stop the stack (indexer DB survives)
#   explorer.sh reset         wipe the indexer DB and restart — run this after every chain
#                             reset (resetFork / snapshot-revert rewinds the chain, which
#                             the indexer cannot follow)
#   explorer.sh tag [runDir]  name the agent wallets as address tags, from the run's last
#                             agents_registered event (so a running period and agents
#                             registered mid-period are covered), else its summary.json.
#                             Default: the newest run directory under runs/ that has either
#   explorer.sh status        compose ps + recent backend log lines
#   explorer.sh check         only the 403 check (e.g. on the live box after a deploy)
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
COMPOSE=(docker compose --env-file explorer.env -f docker-compose.yml)

# explorer.env is trusted repo config; read the knobs the script itself needs.
knob() { sed -n "s/^$1=//p" explorer.env | tail -1; }
RPC_PORT="$(knob RPC_PORT)"
CHAIN_ID="$(knob CHAIN_ID)"
EXPLORER_PORT="$(knob EXPLORER_PORT)"

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "docker daemon is not running (start Docker Desktop first)" >&2
    exit 1
  fi
}

check_rpc() {
  command -v cast >/dev/null 2>&1 || return 0
  local chain_dec
  chain_dec=$(cast chain-id --rpc-url "http://127.0.0.1:${RPC_PORT}" 2>/dev/null) || true
  if [ -z "${chain_dec:-}" ]; then
    echo "warning: no anvil answering on 127.0.0.1:${RPC_PORT} — the indexer will retry until one appears" >&2
    return 0
  fi
  if [ "$chain_dec" != "$CHAIN_ID" ]; then
    echo "error: anvil on port ${RPC_PORT} reports chain id ${chain_dec}, but explorer.env says CHAIN_ID=${CHAIN_ID}" >&2
    echo "       (fork anvil = 42161, local-deploy/backtest anvil = 31337 — fix explorer.env, then 'reset')" >&2
    exit 1
  fi
}

# The proxy's config is a bind-mounted template (proxy/), and compose does not look inside a mount:
# after editing it, `up -d` reports the proxy "Running" and leaves it serving the old config (measured).
# nginx renders the template only at container start, so restart it on every `up`. This is the step that
# was missing when the eth-rpc refusal sat in the repo while the published explorer still relayed it.
reload_proxy() {
  "${COMPOSE[@]}" restart proxy >/dev/null
}

# The proxy is the only thing between the public tunnel and Blockscout's JSON-RPC relay (README,
# "not a second RPC entrance"). Check the refusal is live instead of trusting the file on disk.
# eth_chainId changes nothing; Blockscout answers it from its own config, so a 200 means the relay
# endpoint is reachable, not that the node was touched.
check_boundary() {
  local path code i
  for path in /api/eth-rpc /api/v1/eth-rpc /node-api/proxy/api/v1/eth-rpc; do
    code=000
    for i in $(seq 1 20); do
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST \
        -H 'content-type: application/json' -H 'x-endpoint: http://backend:4000' \
        --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
        "http://127.0.0.1:${EXPLORER_PORT}${path}" || true)
      [ "$code" != 000 ] && [ "$code" != 502 ] && break
      sleep 1
    done
    if [ "$code" != 403 ]; then
      echo "error: ${path} answered ${code}, expected 403 — the proxy is not refusing the JSON-RPC relay." >&2
      echo "       Do not publish this explorer. Check proxy/default.conf.template and 'docker logs eris-explorer-proxy'." >&2
      exit 1
    fi
  done
  echo "proxy: JSON-RPC relay refused (403 on /api/eth-rpc, /api/v1/eth-rpc, /node-api/proxy)"
}

cmd_up() {
  require_docker
  check_rpc
  "${COMPOSE[@]}" up -d
  reload_proxy
  check_boundary
  echo
  echo "explorer: http://localhost:${EXPLORER_PORT}  (indexing 127.0.0.1:${RPC_PORT}, chain ${CHAIN_ID})"
  echo "first start pulls images and boots the backend; give it ~1 minute"
}

cmd_down() {
  require_docker
  "${COMPOSE[@]}" down
}

cmd_reset() {
  require_docker
  check_rpc
  "${COMPOSE[@]}" down -v
  "${COMPOSE[@]}" up -d
  check_boundary
  echo
  echo "indexer DB wiped; reindexing 127.0.0.1:${RPC_PORT} from scratch"
  echo "address tags were wiped with it — re-run 'explorer.sh tag' after the next run"
}

cmd_status() {
  require_docker
  "${COMPOSE[@]}" ps
  echo
  "${COMPOSE[@]}" logs --tail 15 backend
}

cmd_tag() {
  require_docker
  local run_dir="${1:-}"
  if [ -z "$run_dir" ]; then
    # A practice period writes events.jsonl from its first block but summary.json only when a
    # segment (a day) closes, so the newest of either is the run to tag (issue #182). Segments
    # sit below the period directory, hence the depth.
    local newest
    newest="$(find "${REPO_ROOT}/runs" -maxdepth 4 \( -name events.jsonl -o -name summary.json \) \
      -exec ls -t {} + 2>/dev/null | head -1)"
    if [ -z "$newest" ]; then
      echo "no runs/**/events.jsonl or summary.json found — pass a run directory explicitly" >&2
      exit 1
    fi
    run_dir="$(dirname "$newest")"
  fi
  if [ ! -f "${run_dir}/events.jsonl" ] && [ ! -f "${run_dir}/summary.json" ]; then
    echo "no events.jsonl or summary.json in ${run_dir}" >&2
    exit 1
  fi
  echo "tagging agent wallets from ${run_dir}"
  python3 - "$run_dir" "${REPO_ROOT}/sdk/src/constants.local.ts" <<'PY' | "${COMPOSE[@]}" exec -T db psql -q -U blockscout -d blockscout -v ON_ERROR_STOP=1 -f -
import json, re, sys, pathlib

run_dir, constants = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

# The coordinator re-emits agents_registered with the whole roster whenever a registration is
# added mid-period, so the last one is the current roster; summary.json is only there once a
# segment has closed.
agents = None
events = run_dir / "events.jsonl"
if events.is_file():
    with events.open() as f:
        for line in f:
            if '"agents_registered"' not in line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue  # the line being written right now
            if event.get("type") == "agents_registered":
                agents = event.get("agents", [])
if agents is None:
    agents = json.loads((run_dir / "summary.json").read_text()).get("agents", [])
rows = [(a["id"], a["address"]) for a in agents if a.get("address")]
print(f"-- {len(rows)} agents", file=sys.stderr)

# The deployer seeds every venue and moves LP in liquidityPull windows — worth naming so its txs
# don't read as a participant's. It is not anvil account 0 on a chain deployed from a secret
# mnemonic (issue #74), so read it where the deploy wrote it: Aave's ACL admin is the deployer.
m = constants.is_file() and re.search(r'AclAdmin:\s*"(0x[0-9a-fA-F]{40})"', constants.read_text())
if m:
    rows.append(("env:deployer", m.group(1)))
else:
    print(f"-- no AclAdmin in {constants}: env:deployer not tagged", file=sys.stderr)

def q(s: str) -> str:
    return s.replace("'", "''")

for label, address in rows:
    addr_hex = address.lower().removeprefix("0x")
    if len(addr_hex) != 40 or any(c not in "0123456789abcdef" for c in addr_hex):
        print(f"-- skipped {label}: bad address {address!r}", file=sys.stderr)
        continue
    print(f"""\
INSERT INTO address_tags (label, display_name, inserted_at, updated_at)
VALUES ('{q(label)}', '{q(label)}', now(), now())
ON CONFLICT (label) DO NOTHING;
INSERT INTO address_to_tags (address_hash, tag_id, inserted_at, updated_at)
SELECT decode('{addr_hex}', 'hex'), id, now(), now()
FROM address_tags WHERE label = '{q(label)}'
ON CONFLICT DO NOTHING;""")
PY
  echo "done — tags show on the address pages (wiped again by 'reset')"
}

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  status) cmd_status ;;
  check)  check_boundary ;;
  tag)    shift; cmd_tag "${1:-}" ;;
  *)
    sed -n '2,17p' "$(basename "$0")" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
