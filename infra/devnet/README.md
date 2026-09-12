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
