# infra/devnet — keeping the practice devnet up

The chain is a container and the tunnel publishes it, but neither of those makes a devnet. anvil
with nobody driving it answers `eth_blockNumber` forever and never produces a block: the fair price
does not move, no flow order is placed, the GMX keeper does not run, no episode opens and no round
is ever scored. From outside it looks alive. It is frozen.

The thing that makes it a market is the **coordinator** (`npm run sim:realtime`), and until now it
was a foreground command in a document. This directory is the unit that runs it.

```
docker compose up -d          the chain, the gateway, the monitoring  (infra/monitoring)
cloudflared                   publishes :8546 and :3000               (infra/cloudflared)
ascon-devnet.service          ← drives the chain                      (here)
eris-dashboard-sync.timer     rebuilds the hosted dashboard           (infra/dashboard)
```

## Install (once, on the box that hosts it)

```sh
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

## What it needs

| thing | where | note |
|---|---|---|
| a chain | `ANVIL_RPC_URL` in `.env.local` | the `ascon-anvil` container of `infra/monitoring` |
| `CHAIN_ID` | `.env.local` | must match the node |
| `TREASURY_PRIVATE_KEY` | `.env.local` | only on a real chain; on anvil the endowment is a cheatcode |
| the period | `config/practice.yaml` | the roster, the episodes, the round length |
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

## A restart is a new competition, on purpose

`competitionId` is the process start time (`core/src/realtime/coordinator.ts`), so **restarting the
coordinator does not resume the period.** It opens a new competition directory and the standings
start again from zero. There is no resume, and the unit does not pretend otherwise.

That shapes the restart policy:

- `Restart=on-failure`, so a transient fault (the chain blinked, a disk write failed) comes back
- `RestartSec=30`
- `StartLimitIntervalSec=1h` / `StartLimitBurst=3`, so a **persistent** fault stops the unit instead
  of shredding a week-long period into a directory per crash. After the third start in an hour the
  unit stays `failed` and waits for a person.
- a clean exit is **not** restarted. The period reaching its block count is the period ending, and
  starting the next one is an operator's decision, not systemd's.

So a crash costs the standings. That is a real limitation, not a rough edge to be papered over: if
the period matters, watch the alert rather than trusting the restart.

Adding a participant mid-period is the one thing that explicitly does **not** need a restart — that
is what `run.registrationsFile` is for ([practice devnet](../../docs/guide/practice-devnet.md)).

## Stopping

```sh
systemctl --user stop ascon-devnet     # ends the period
```

The coordinator installs no `SIGTERM` handler, so this is abrupt. The append-only artifacts
(`events.jsonl`, `blocks.csv`, `epochs.jsonl`, `agents/*.jsonl`) are all on disk and intact;
`summary.json` is written at the end of a run and will not exist. The segment is still readable —
the dashboard reads the jsonl — but do not expect a closed book.

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

## Overriding the period

Every `run.*` key in the config **wins over the environment** (`sdk/src/runConfig.ts`), which is not
the precedence most people assume. `ERIS_RUN_BLOCKS=60 npm run sim:realtime -- --config
config/practice.yaml` runs the full 302,400-block period and silently ignores you. To run a shorter
one, copy the config and point the unit at the copy:

```sh
cp config/practice.yaml config/practice-short.yaml   # edit run.blocks, run.segmentHours, …
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

So: **stop the coordinator before touching the chain volume, and restart it after.**

```sh
systemctl --user stop ascon-devnet
# ... reset the chain ...
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
timeout 3h npm run backtest -- --scenarios plan.yaml --port 8547
pkill -f 'core/src/flow/market-maker'      # the children that keep it open
```

The artifacts are trustworthy either way — they are written before the hang, and `matrix.json`
carries `scenariosPlanned` next to the actual count, so a truncated matrix is visible rather than
silent.


## Running the scenario matrix

The matrix is what ADR 0017 calls an epoch: for each `(regime, seed)` in the plan the coordinator
snapshots the chain, runs the scenario, reconstructs the agents' value at the epoch boundaries, and
reverts. `resetUnit: "scenario"` in `matrix.json` names the unit; the proof it actually happened is
that **block numbers go backwards between scenarios** — measured 2026-09-17, scenario 1 ended at
block 1222 and scenario 2 started at 1163. Nothing but a revert does that.

```sh
export PATH="$HOME/.foundry/bin:$PATH"     # anvil is not on a non-interactive PATH
export ERIS_AGENT_BINDMOUNT=1              # see below — without it most of the field cannot start
timeout 5h npm run backtest -- --scenarios <plan.yaml> --port 8547
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
**not** a progress indicator. What moves: `events.jsonl`, `epochs.jsonl`, and the chain's own block
number (`eth_blockNumber` against the backtest's port, read twice a few seconds apart).

A run proceeds at `blockTimeSec`, not as fast as the box can mine: 360 blocks took **718 s** twice,
which is 2.00 s/block, on a 16-core box at load 0.05. So the wall clock is
`blocks x blockTimeSec x scenarios` and adding CPU does not change it — a 12 x 360 matrix is ~2.4 h
whatever the hardware. It also means a second run alongside it is nearly free.
