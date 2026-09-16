# infra/provision — bring up a replacement box

gohanserver was sold, so the practice (9/23–10/31) and live (11/1–11/7) environments have to be
rented. The selection and its reasoning are in ASCON `docs/27`; this directory is the mechanical part.

## What is portable, and what is not

**Portability lives in cloud-init and docker compose, not in Terraform.** Every bare-metal provider
exposes a different resource shape (`cherryservers_server` / `vultr_bare_metal_server` /
`hcloud_server` / the OVH order API), so changing vendor means rewriting `terraform/main.tf` — not
flipping a variable. `bootstrap.sh` and `cloud-init.yaml` assume only "Ubuntu 24.04 with outbound
network", so they move unchanged.

Terraform is here for one job: **bringing up the live-week standby with one command instead of
clicking through a portal during an incident.**

| file | role | vendor-specific? |
|---|---|---|
| `bootstrap.sh` | docker, foundry (stable), node 22, checkout, `.env`, systemd unit, cleanup cron | no |
| `cloud-init.yaml` | first boot: user, SSH hardening, then calls `bootstrap.sh` | no |
| `terraform/` | orders the machine and passes `cloud-init.yaml` as user-data | **yes** (Cherry Servers) |

## The API key

The provider reads `CHERRY_API_KEY` from the environment, which is the path to prefer: nothing
lands in the working directory. On the ASCON workstation the machine-local secret file is
`~/.hermes/.env` (mode 0600, outside every checkout), so append it there without putting it through
shell history:

```bash
(umask 077; printf 'Cherry API key: '; read -rs K; printf 'CHERRY_API_KEY=%s\n' "$K" >> ~/.hermes/.env; unset K; echo)
```

Then let direnv export just that one variable for this directory (`.envrc` holds no secret itself,
and is gitignored anyway):

```bash
cat > terraform/.envrc <<'ENVRC'
export CHERRY_API_KEY="$(sed -n 's/^CHERRY_API_KEY=//p' ~/.hermes/.env | head -1)"
ENVRC
direnv allow terraform
```

Do not put the key in `terraform.tfvars` (gitignored, but it puts a plaintext key in the working
tree for no gain) and do not `export` it from a shell rc file (it then reaches every process,
including anything that dumps its environment into a crash report).

**`terraform.tfstate` holds secrets** — `user_data` is sensitive and is stored in the state in the
clear. It is gitignored, but keep it out of Drive/Dropbox sync folders too. Sharing state across
people later means an encrypted backend, not a synced file.

## Order of operations

```bash
# 1. machine  (or order it in the portal and paste cloud-init.yaml as user-data)
cd terraform
cp terraform.tfvars.example terraform.tfvars   # project_id, ssh key
export CHERRY_API_KEY=...                      # portal.cherryservers.com/settings/api-keys
terraform init && terraform apply

# 2. the rest, on the box, as the `ascon` user
cd ~/workspace/eris-agent-simulator
npm ci && (cd deployer && npm ci)
deployer/scripts/setup-vendors.sh        # clones GMX (~1.1 GB) + Liquity, then yarn/npm install
(cd deployer && npm run deploy -- --keep-fresh) &   # leaves an anvil on :8545
npm run gen:state-dump                   # writes backtest/state/venues-state.json

# 3. secrets (both gitignored, neither can be baked into an image)
#    infra/monitoring/grafana/secret.env   Slack bot token, Grafana admin pw, renderer token
#    .env.local                            ANVIL_RPC_URL / CHAIN_ID / TREASURY_PRIVATE_KEY

# 4. the stack
cd infra/monitoring && docker compose up -d

# 5. cloudflared  (see "the tunnel" below)

# 6. prove it from outside: eth_ -> 200, cheatcode -> 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ascon-rpc.nyx.foundation \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'      # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://ascon-rpc.nyx.foundation \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"anvil_setBalance","params":[]}'     # 403
```

**`setup-vendors.sh` reports success badly — check artefacts, not `$?`.** It is known to exit
non-zero after a *successful* compile (docs/18: the dev solar parser rejects Liquity V1 at the lint
stage). It also exits 127 if `yarn` is missing, and by then it has already cloned 1.1 GB of GMX, so
every vendor directory exists and the tree looks finished; the failure only shows up much later as a
deploy that cannot compile. The four things that actually have to be there:

```
deployer/vendor/gmx-src/node_modules
deployer/vendor/aave/node_modules
deployer/vendor/liquity-src
deployer/vendor/curve
```

**Step 2 is not optional and the stack will not paper over it.** `anvil-state-init` refuses to start
when `backtest/state/venues-state.json` is missing or is a directory. That guard exists because
compose's `create_host_path` silently creates an empty *directory* at a missing bind source, and
anvil then comes up with no venues at all and no error anywhere — which is exactly what happens the
first time you `docker compose up` on a fresh box.

## The chain survives restarts now

The live chain is the named volume `ascon-chain-state`, not the venues snapshot. The snapshot is only
a seed, used once. This matters because the practice period runs 39 days without resetting
(`resetUnit: continuous`, ASCON docs/20 §1) while anvil's memory grows 0.37 GB/h with no pruning, so
the period needs planned restarts — and before this change every restart rewound it to day one.

Verified on 2026-09-15 (block number before → after):

| | result |
|---|---|
| `docker compose restart` | 8 → 8, chain kept |
| `docker compose down` + `up` | 12 → 12, chain kept |
| SIGKILL inside the container | 15 → 12, `RestartCount` 1, lost only the blocks since the last flush |
| block gas limit | 320,000,000 (was 30,000,000 — see below) |

Two mechanisms: `--state` (load **and** dump the same file) plus `--state-interval 300` for the
crash case, and a `trap` in the entrypoint so that SIGTERM reaches anvil. The trap is not
decoration — measured A/B, the previous `sh -c '... & wait'` shape let the shell die, **orphaned
anvil, and wrote a 0-byte dump**; with the trap the dump is written and anvil exits cleanly.

**To start the period over on purpose:**

```bash
cd infra/monitoring && docker compose down && docker volume rm ascon-monitoring_ascon-chain-state
```

### The gas limit was wrong

`infra/monitoring/docker-compose.yml` set `anvil_setBlockGasLimit 0x1c9c380` = **30,000,000**, while
the decided competition limit is **320,000,000** (`0x1312D000`, ASCON docs/18 §12, and what
`bench/lib/reset-chain.sh` has always used). ASCON docs/22 §7 describes this service as "venues-state
ロード＋320M 設定", so the compose file disagreed with its own documentation. Fixed to 320M.

100 agents × 3 tx of heavy DeFi calls is ~264M gas (docs/18 §12); at 30M that overflows.

> `infra/rpc-gateway/writeload.mjs:63` still carries the same 30M value with the comment "match the
> competition (rules §2.6)". It is a load-generator, not production, so it is left alone here — but
> the comment is wrong and the number should be revisited with the measurement it feeds.

Note that `--load-state` restores the block environment including the gas limit, so `--gas-limit`
on the command line does not stick and the RPC call is required (docs/18 §1). It takes effect **from
the next mined block**, so a freshly booted idle chain still reports the old limit until something
mines.

## The tunnel

No inbound port is opened for the stack; Cloudflare Tunnel reaches services by hostname
(`ascon-rpc` → `:8546` gateway, dashboard → `:5174`, Blockscout → `:4000`, Grafana). Two things bit
us on gohanserver and will bite again:

- **`cloudflared` runs as root**, so the effective config is `/root/.cloudflared/config.yml` (on
  Ubuntu: `/etc/cloudflared/config.yml` with the packaged unit). Writing `~/.cloudflared/config.yml`
  as the normal user changes nothing.
- **A local `config.yml` overrides the dashboard-managed (remote) configuration.** Pick local *or*
  remote and do not mix them. `infra/cloudflared/config.yml` in this repo is the source of truth for
  the local form.
- `service:` must be `http://127.0.0.1:8546` (the gateway). Pointing it at `:8545` lets cheatcodes
  through, which ends the competition.

## Not handled here

- **The devnet coordinator does not resume.** `infra/devnet/ascon-devnet.service` caps itself at 3
  starts/hour on purpose: `competitionId` is the process start time, so every start opens a new
  competition directory and the standings begin again. Auto-restart is therefore deliberately
  limited, and making the practice period genuinely restart-safe needs a change in
  `core/src/realtime/coordinator.ts`, not in systemd.
- Secrets. By design.
