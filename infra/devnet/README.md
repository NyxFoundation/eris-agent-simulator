# infra/devnet — keeping the practice devnet up

The chain is a container and the tunnel publishes it, but neither of those makes a devnet. anvil
with nobody driving it answers `eth_blockNumber` forever and never produces a block: the fair price
does not move, no flow order is placed, the GMX keeper does not run, no episode opens and no interval
boundary is ever scored. From outside it looks alive. It is frozen.

The thing that makes it a market is the **coordinator** (`npm run sim:realtime`), and until now it
was a foreground command in a document. This directory is the unit that runs it.

```
docker compose up -d          the chain, the gateway, the monitoring  (infra/monitoring)
cloudflared                   publishes :8546 and :3000               (infra/cloudflared)
ascon-devnet.service          ← drives the chain                      (here)
eris-dashboard-sync.timer     rebuilds the hosted dashboard at its pin (infra/dashboard)
```

## Install (once, on the box that hosts it)

On a box provisioned with [infra/provision/bootstrap.sh](../provision/bootstrap.sh) the link and the
linger below are already in place, and so is `runs/` (owned by the service user — left to compose it
is created as root and the first start dies with `EACCES`); what is left is the seed and
`enable --now`. The unit is a **user** unit everywhere, which is what every `systemctl --user` below
and in [CHECKLIST.md](CHECKLIST.md) addresses.

```sh
# The period's seed. Not the one in config/practice.yaml: that file is public, and the price walk, the
# flow and every event window follow from the seed, so the committed one publishes all of them. Draw
# a new one per period and keep it off the repo (.env.practice is gitignored). The unit refuses to
# start without it.
echo "ERIS_PRACTICE_SEED=$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')" > ~/workspace/eris-agent-simulator/.env.practice
chmod 600 ~/workspace/eris-agent-simulator/.env.practice

# The period's scenario key (ADR 0027): the seed names the world, the key realizes it. Generate it
# on this box, keep it off the repo, back it up, and publish only the commitment keygen prints. The
# unit refuses to start without it.
mkdir -p ~/.eris-secrets && chmod 700 ~/.eris-secrets
(cd ~/workspace/eris-agent-simulator && npm run -s competition -- keygen ~/.eris-secrets/practice-scenario-key.yaml)
echo "ERIS_SCENARIO_KEY_FILE=$HOME/.eris-secrets/practice-scenario-key.yaml" >> ~/workspace/eris-agent-simulator/.env.practice

# The period's wallet secret (issue #189): every AUTO agent's, flow wallet's and handed-out key is
# derived from it, so a coordinator restart comes back to the same wallets. Back it up and NEVER
# publish it -- not even after the period (unlike the seed and the scenario key, nothing reproduces
# from it). The unit refuses to start without it.
(cd ~/workspace/eris-agent-simulator && npm run -s competition -- wallet-keygen ~/.eris-secrets/practice-wallet-secret.yaml)
echo "ERIS_WALLET_SECRET_FILE=$HOME/.eris-secrets/practice-wallet-secret.yaml" >> ~/workspace/eris-agent-simulator/.env.practice

mkdir -p ~/.config/systemd/user
ln -sf ~/workspace/eris-agent-simulator/infra/devnet/ascon-devnet.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ascon-devnet.service

# User units die with the last session. The devnet is public and the box is headless, so it has to
# outlive a logout. Same reason as infra/dashboard.
loginctl enable-linger "$USER"
```

Check it:

```sh
systemctl --user status ascon-devnet
journalctl --user -u ascon-devnet -f
```

and confirm the chain is actually moving, which is the only claim that matters:

```sh
cast block-number --rpc-url http://127.0.0.1:8545   # twice, a few seconds apart
```

That is the minimum. Before a period is handed to participants -- and every day it runs -- go through
[CHECKLIST.md](CHECKLIST.md): a 26-hour rehearsal on a private copy, a one-hour check after the
production start, and the daily and weekly routine. `block-gaps.mjs` (cadence and dump stalls) and
`revision-health.mjs` (self-improving agents' revision loops) are its measuring tools.

## What it needs

| thing | where | note |
|---|---|---|
| a chain | `ANVIL_RPC_URL` in `.env.local` | the `ascon-anvil` container of `infra/monitoring` |
| `CHAIN_ID` | `.env.local` | must match the node |
| `TREASURY_PRIVATE_KEY` | `.env.local` | only on a real chain; on anvil the endowment is a cheatcode |
| `ERIS_PUBLIC_RPC_URL` | `.env.local` | the gateway participants dial (`https://ascon-rpc.nyx.foundation/`). The `manifest.json` the dashboard serves at `/runs/manifest.json` names it; unset, it names `ANVIL_RPC_URL` — this box's loopback — and every self-hosted agent dials its own machine (issue #156) |
| the period | `config/practice.yaml` | the roster, the episodes, the evaluation-interval length (`intervalSeconds`) |
| the seed | `.env.practice` (`ERIS_PRACTICE_SEED=`) | **gitignored; the unit will not start without it.** Publish it after the period (rules §7.2) |
| the scenario key | `.env.practice` (`ERIS_SCENARIO_KEY_FILE=`, a file from `competition -- keygen`) | **outside the repo; the unit will not start without it.** The run records only its commitment (ADR 0027) |
| the wallet secret | `.env.practice` (`ERIS_WALLET_SECRET_FILE=`, a file from `competition -- wallet-keygen`) | **outside the repo; the unit will not start without it. Never published**, not even after the period. Changing it moves every AUTO agent and flow wallet to a new address (issue #189) |
| venue state | `backtest/state/venues-state.json` | **gitignored, and the chain container mounts it** |

`.env.local` is read in-process (`core/src/cli/bootstrapEnv.ts`) relative to the working directory,
so the unit carries no secrets and no endpoint. It states `PATH` and nothing else, because systemd
gives no login shell.

**The venue state is the prerequisite nothing else names.** `venues-state.json` is a 33MB generated
file under a gitignored directory, and `ascon-anvil` bind-mounts it. A fresh clone does not have it,
and a chain started without it is an empty chain with no venues on it — the coordinator will come up
and drive a world where nothing can be traded. Produce it first, from a deployer anvil
([local deploy](../../docs/guide/local-deploy.md)):

```sh
npm run gen:state-dump
```

## A restart resumes the period

The coordinator writes the period's state down at the end of every pass —
`<competition>/resume/state.json`, and a copy every 30 blocks in `resume/history/` (the last 40) —
and a start that finds an open period **continues it**: the same chain (nothing is reverted), the
same competition directory, the same PriceFeed, the same balances and the same standings. Nothing a
participant holds changes: their manifest, nonces and approvals are all still good
(`core/src/realtime/periodResume.ts`).

| At the start | The coordinator |
|---|---|
| the period's last checkpoint is on the chain (it crashed, or was stopped) | resumes after it; the blocks mined while it was down are the first pass's catch-up |
| the chain went back (anvil restarted from its periodic dump) | resumes from the newest checkpoint the chain still holds, and cuts the artifacts back to it — what it cuts is kept under `resume/cut-<time>/` |
| no checkpoint is on the chain (it was reset or redeployed) | refuses, naming the blocks it looked for |
| no open period, and no new one asked for | refuses |
| `runs/NEW_PERIOD` exists, or `--new-period` was passed | marks every open period superseded, reverts the chain to the setup snapshot and starts a new period; the file is removed once that period has written its first checkpoint |
| the config describes a different world | refuses, listing what differs. Across a restart only the fee rule (`fees.*`, `run.economicGas`), `flow.topUpEveryBlocks`, `run.registrationsFile` and the agents' readiness wait, disk quotas and sandbox may change |

So the restart policy is what it was — `Restart=on-failure`, `RestartSec=30`,
`StartLimitIntervalSec=1h` / `StartLimitBurst=3` (a persistent fault stops the unit and waits for a
person), a clean exit is not restarted — but a crash no longer costs the standings.

**Starting a new period** is the only thing that reverts the chain, so it has to be asked for:

```sh
touch runs/NEW_PERIOD                  # in the coordinator's checkout (run.reportDir)
systemctl --user restart ascon-devnet
```

or `npm run sim:realtime -- --config config/practice.yaml --seed <seed> --new-period` by hand. A new
period is still announced on Discord: the chain resets, so participants restart their agents and
fetch the manifest again.

Before this, *every* start reverted the chain. On 2026-10-08 a Blockscout retry loop filled the disk
with container log, the coordinator died on `ENOSPC`, the unit restarted it 30 s later, and that start
reverted 2.5 days of chain and died again — after which the 5-minute state dump saved the reverted
chain over the real one. The unit still refuses to start with less than 5% of the disk free (the first
`ExecStartPre`), every container's log is capped, and "Host disk low" fires below 15%.

What a resume does **not** carry:

- **The node's state history across an anvil restart.** anvil's dump holds the current state; the
  300 blocks of history `--prune-history` keeps are in memory only. An interval boundary that came due
  between the checkpoint and the reloaded head cannot be read, and is recorded as
  `interval_boundary_failed` — never filled in. A coordinator crash does not lose it (anvil is still
  up). Measured: transactions in those blocks do survive the dump, so `blocks.csv` loses nothing.
- **Transactions older than `--transaction-block-keeper`** (300 blocks, 10 minutes) when the
  coordinator was down longer than that: their blocks are reported as `blocks_csv_unrecoverable`
  rather than written as empty.
- **Features whose state is not checkpointed** — `agentMarkets`, `tokenLaunch`, vuln events, stress
  victims, prewarm. None is in `config/practice.yaml`; a period that has one says so when it starts
  (`period_not_resumable`) and is refused at a restart.
- **The flow bot's position in its stream.** A resumed bot draws a continuation (`flow:resume-<n>`), not
  the period's first day again.
- **An agent process that had already exited on its own** is not started again (rules §2.3); one the
  coordinator's own death took down is.

### When a period cannot be resumed

The next start then has to be a new period: the period predates checkpoints (one started before
this code was deployed), the chain it ran on was lost or reset, or the period was not resumable.
The days already closed keep their results, and two steps keep the standings whole across the
new period:

1. **Close the day it died in.** A day gets its `summary.json` when it rolls, so the day the
   coordinator died in has none, and the standings drop it. `npm run close:crashed-segment --
   runs/<period> <day-dir>` builds the one the roll would have written from the day's own
   `intervals.jsonl`, ending at the last boundary it read, and prints every agent's P; add `--write`
   to write it and close the day's entry in `matrix.json`.
2. **Continue the standings.** After the new period has started, write
   `runs/<new period>/continues.json` as `{"from": "<old period>", "note": "<why>"}`. The dashboard
   then serves the new period's `matrix.json` with the old period's days first, and admits them even
   when only the new period is in `ERIS_DASHBOARD_COMPETITIONS`. The coordinator never touches this
   file (it rewrites `matrix.json` from memory at every roll). The practice period ranks every day on
   its own return from its own opening value, so days from two chains stand side by side.

Adding a participant mid-period still does not need a restart — that is what
`run.registrationsFile` is for ([practice devnet](../../docs/guide/practice-devnet.md)), and entries
added while the coordinator was down are picked up by its first poll after the resume.

## Stopping

```sh
systemctl --user stop ascon-devnet     # pauses the period
```

On `SIGTERM` the coordinator stops the chain's interval mining and exits, so participants'
transactions wait in the mempool instead of being mined against a price nobody is updating; the next
start resumes. `summary.json` is written when a period reaches its end (the period is then closed, and
a start after it needs `NEW_PERIOD`). A segment that is open is readable as it is — the dashboard reads
the jsonl.

## When it dies, Slack says so

`ascon_chain_down` does not catch this. anvil is still answering, so that rule stays green while the
devnet is frozen. The rule that catches it is **`ascon_devnet_stalled`**
(`infra/monitoring/grafana/provisioning/alerting/rules.yml`):

```promql
(delta(ascon_chain_block_number[10m]) < bool 1) and (ascon_chain_up == 1)
```

The chain is reachable and has not produced a block in ten minutes. It fires after 5m into
`#notif-ascon-infra` with the panel image, and the summary names the unit to look at. The
`ascon_chain_up == 1` guard keeps it quiet when the node itself is gone, because that is the other
rule's alert and two pages for one fault is how a channel gets muted.

The rest of what the daily check used to read by hand is also an alert now (issue #159): an
environment failure in `events.jsonl`, the flow bot stopping (its process exit is now an event,
`flow_process_exited`), the canary going quiet for an hour, dump stalls growing, the gateway losing the
chain or refusing keys, and the dashboard not answering. The table at the end of
[CHECKLIST.md](CHECKLIST.md) §3 lists them against the manual lines they replaced.

## A month on one anvil (issue #135)

Measured on a 16-vCPU box (anvil 1.8.1) with `config/practice.yaml`'s load — nine resident agents,
the official flow, every venue — for four hours, beside synthetic runs of up to 20,000 blocks. The
numbers are in the issue #135 PR; what they decided is in the compose file:

- **Unbounded, anvil keeps every transaction.** Receipt, logs and call trace, ~37 KB each, in memory
  and in every dump. The practice load grew the dump ~0.9 MB and anvil's memory ~1.7 MB a block.
- **Mining stops while the dump is written.** `--state-interval 300` dumps every five minutes, and the
  block interval showed a gap each time: 9 s an hour in, 18 s two hours in, growing with the dump. A
  month (~1.5M blocks) is a dump of a terabyte, written back to back — a chain that is frozen, not one
  that is slow.
- **`--transaction-block-keeper 300 --prune-history 300`** keeps the last ten minutes of transactions
  and of states. The dump levels off (it did at 1,800 blocks too — at 1.7 GB with a 13 s stall, which
  is why the window is 300). Every reader is inside ten minutes; an explorer indexer that falls further
  behind loses what it had not read, and a participant's `eth_call` / `eth_getLogs` / receipt older
  than ten minutes returns nothing (docs/guide/practice-devnet.md says so).
- **Not bounded by any flag: block headers.** anvil keeps one for every block, so memory still grows
  after the plateau. `ascon_anvil_mem_growth` fires when the chain container's six-hour slope reaches
  80 % of the host within a week — enough warning to schedule a new period on a fresh chain (a
  coordinator restart resumes the period and sheds nothing) or a bigger box. It reads eris-exporter's `ascon_container_memory_working_set_bytes`: the practice box runs
  Docker's containerd image store, under which cAdvisor exports no per-container series, so until
  issue #157 this rule was evaluating no data — green — while the rehearsal's anvil grew 0.11 GiB/h.
- **No per-block state files on this version.** `~/.foundry/anvil/tmp/anvil-state-*` (6 MB a block on
  macOS anvil 1.7.1, and the ENOSPC incidents in CLAUDE.md) stayed empty on 1.8.1 under the same load,
  and `--prune-history` persists no state to disk at all whichever version runs.

## Overriding the period

Every `run.*` key in the config **wins over the environment** (`sdk/src/runConfig.ts`), which is not
the precedence most people assume. `ERIS_RUN_BLOCKS=60 npm run sim:realtime -- --config
config/practice.yaml` runs the full period and silently ignores you. The command line does win: the
period ends on `run.endsAt` (a date, issue #136), and a one-off `--blocks N` or `--ends-at <date>`
replaces it for a smoke run. To change the hosted period itself, copy the config and point the unit
at the copy:

```sh
cp config/practice.yaml config/practice-short.yaml   # edit run.endsAt, run.segmentHours, …
```

Env still works for the keys the config deliberately leaves out — the chain endpoint and the keys,
which belong to a deployment rather than to a period.


## The live topology — a containerised coordinator

The practice period runs the coordinator as a host process (the user unit above): participants
self-host, so nothing the coordinator spawns needs containing. **The live period is different.**
Participant code runs here, under `ERIS_AGENT_ISOLATE=1`, and may reach nothing but the rpc-gateway
(ASCON docs/24 §4, `infra/docker-agent/ISOLATION.md`). That cannot be done from a host process:

| | needs |
|---|---|
| the coordinator | anvil **directly** — funding and the block gas limit are cheatcodes, and the gateway 403s those |
| each agent | the gateway **only**, by container name, from inside its own `ag-<id>` network |

One process on the host cannot hand out a URL that satisfies both. `docker-compose.sim.yml` puts the
coordinator on `ascon-chain` so it can use `ascon-anvil:8545` itself and give agents
`ascon-rpc-gateway-live:8546` via `ERIS_AGENT_RPC_URL`.

```sh
cd infra/devnet
ERIS_ROOT=$HOME/workspace/eris-agent-simulator \
ASCON_LOGS=$HOME/ascon-logs \
SIM_CONFIG=config/competition.yaml \
  docker compose -f docker-compose.sim.yml --profile live up -d --build
```

### Things that are load-bearing and look like details

- **The checkout is mounted at its host path, not `/app`.** `run-agent.sh` passes paths straight to
  `docker run -v`, and the daemon resolves them on the host. Mount it anywhere else and every agent
  gets mounts that silently point at nothing.
- **The chain must be at the venues snapshot.** `flashArb: true` deploys at a deterministic address,
  so a chain that has been running fails setup with `FlashArb address mismatch`. Restore first:
  `cd ../monitoring && docker compose down && docker volume rm ascon-monitoring_ascon-chain-state && docker compose up -d`
- **`run.agentSandbox: docker` must be in the config.** It defaults to `process`, `config/example.yaml`
  does not set it, and `ERIS_AGENT_SANDBOX` is a retired env knob the loader ignores. Without it the
  agents are plain host processes: no caps, no egress control, rules §2.3 unenforced.
- **Docker's address pools must be widened.** Default pools give ~27 networks; isolation takes one per
  agent. `/etc/docker/daemon.json`: `{"default-address-pools":[{"base":"10.200.0.0/12","size":24}]}`
- **Production builds per-team images** (`npm run agent:build -- team <id>`), which is what pins the
  artefact for the replay audit. `ERIS_AGENT_BINDMOUNT=1` is for rehearsing the topology only.

`restart: "no"` is deliberate: a competition run ending is an event someone should see, not
something to paper over.


## Resetting the chain under a running coordinator wedges it, silently

The README opens by saying an undriven anvil "looks alive from outside; it is frozen". There is a
second way to reach exactly that state, and it is easier to hit: **drop the chain volume while the
coordinator is running.**

```sh
# with ascon-devnet active:
cd ../monitoring && docker compose down && docker volume rm ascon-monitoring_ascon-chain-state && docker compose up -d
```

The chain comes back at the venues snapshot. The coordinator does not notice: the unit stays
`active`, the process tree is intact and burning ~1% CPU, a run directory and `matrix.json` exist —
and **no block is ever produced again**. Measured 2026-09-17: three hours of `active` with the chain
pinned at the snapshot block.

`systemctl --user start ascon-devnet` does **not** fix it. Start on an already-active unit is a
no-op, so the obvious reflex looks like it worked and changes nothing. It has to be `stop` then
`start` (or `restart`).

So: **stop the coordinator before touching the chain volume, and restart it after.** A reset chain no
longer holds the period, so the start refuses until a new period is asked for:

```sh
systemctl --user stop ascon-devnet
# ... reset the chain ...
touch runs/NEW_PERIOD
systemctl --user start ascon-devnet
```

The only check that means anything is the one this README already gives — read the block number
twice, a few seconds apart. `is-active` will lie to you.


## `backtest --scenarios` finishes without exiting

Measured 2026-09-17 on a 12-epoch matrix: `matrix.json` and `standings.json` were complete, the
backtest's own anvil on :8547 was already down — and the process tree was still alive 32 minutes
later at 0% CPU, with two orphaned `core/src/flow/market-maker.ts` children (one of them 2h24m old).

This is the behaviour `bench/run.sh` already documents and works around:

> the coordinator does not always exit after it finishes … the summary is written, and the process
> then sits at 0% CPU holding something open

`bench/run.sh` wraps the sim in `timeout` for exactly this reason. **`backtest --scenarios` has no
such bound**, and `docs/05` puts 105 scenarios through it for the post-competition verification. One
hung process and a stray flow bot per scenario is a hundred of each by the end.

Until the root cause is fixed, bound it and sweep afterwards:

```sh
timeout 3h npm run backtest -- --scenarios plan.yaml --scenario-key <key.yaml|public> --port 8547
pkill -f 'core/src/flow/market-maker'      # the children that keep it open
```

The artifacts are trustworthy either way — they are written before the hang, and `matrix.json`
carries `scenariosPlanned` next to the actual count, so a truncated matrix is visible rather than
silent.


## Running the scenario matrix

The matrix is what ADR 0017 calls an epoch: for each `(regime, seed)` in the plan the coordinator
snapshots the chain, runs the scenario, reconstructs the agents' value at the interval boundaries, and
reverts. `resetUnit: "scenario"` in `matrix.json` names the unit; the proof it actually happened is
that **block numbers go backwards between scenarios** — measured 2026-09-17, scenario 1 ended at
block 1222 and scenario 2 started at 1163. Nothing but a revert does that.

```sh
export PATH="$HOME/.foundry/bin:$PATH"     # anvil is not on a non-interactive PATH
export ERIS_AGENT_BINDMOUNT=1              # see below — without it most of the field cannot start
# A plan (epochs:) refuses to start without its scenario key (ADR 0027): the operator's key file for
# the live week, `public` for a rehearsal on the public key.
timeout 5h npm run backtest -- --scenarios <plan.yaml> --scenario-key <key.yaml|public> --port 8547
```

### Four ways this run produces a green result that means nothing

**Do not shorten `--blocks`.** The regimes are 360 blocks because their stress events are windowed:
`cdp-incident`'s eUSD depeg alone is ramp 4 + hold 20 + decay 12 = 36 blocks inside a window at
`windowFrac [0.3, 0.7]`. At `--blocks 40` that window cannot exist, and the 2026-09-17 matrix
recorded `cdp-incident#101` with **`agents: []`** — a scenario that ran, reported nothing, and left
`scenariosPlanned: 12` next to 11 usable entries. At the regime's own 360 the same scenario scores
all five agents (`sp-underwriter` 1383.95, `redemption-arb` 581.54), which is the behaviour the
regime exists to exercise and which had never fired before. The config says this already: shortening
is "for behavior checks and smoke tests only" (ADR 0016 §3).

**Set `ERIS_AGENT_BINDMOUNT=1` for the operator's own field.** Image mode is the default and it
expects `eris-agent:<id>` for *every* roster entry. The twelve official regimes name thirteen
distinct agents; a box provisioned for the competition has the two or three that were built on it.
The rest exit `125` before `runtime_start` — docker's "could not start the container at all", with
no line saying which image was missing. `runs/<id>/images.jsonl` is where to look: a missing image
is logged as `"digest": "unresolved"`. Image mode is the *submission* path (see
`infra/submission/README.md`), not the path for agents that are this repository's own code.

**Sweep leftover containers first.** `run-agent.sh` removes its container from a signal handler, so
a coordinator killed with SIGKILL — or a `timeout` that fires — leaves `eris-<id>` running. The next
run's `docker run --name eris-<id>` then fails with a bare `125` that looks identical to the missing
image above. Measured twice on 2026-09-17.

```sh
docker ps -aq --filter 'name=^eris-' | xargs -r docker rm -f
```

**Two matrices at once collide on agent ids, not on ports.** The container name is the roster `id`
(`eris-<id>`); the image comes from `dir`. Separate `--port` values are not enough — a second run
whose roster also contains `noop` kills the first one's `noop` or fails to start its own. Alias the
ids when you need a concurrent run, which costs nothing because `dir` still points at the shared
image:

```yaml
- { id: kappa-noop, dir: noop,      wallet: AUTO, baseline: true }
- { id: kappa-ref,  dir: venue-arb, wallet: AUTO }
```

### Reading progress

`blocks.csv` is written when the run ends, so it sits at one header line for the whole run and is
**not** a progress indicator. What moves: `events.jsonl`, `intervals.jsonl`, and the chain's own block
number (`eth_blockNumber` against the backtest's port, read twice a few seconds apart).

A run proceeds at `blockTimeSec`, not as fast as the box can mine: 360 blocks took **718 s** twice,
which is 2.00 s/block, on a 16-core box at load 0.05. So the wall clock is
`blocks x blockTimeSec x scenarios` and adding CPU does not change it — a 12 x 360 matrix is ~2.4 h
whatever the hardware. It also means a second run alongside it is nearly free.
