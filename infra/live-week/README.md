# infra/live-week — the 11/30-night cutover and the live week

The live week (12/1 00:00 – 12/8 00:00 JST, k = 60 epochs, one every 168 minutes; the dates the
rules took on 2026-10-26, §1) runs on the same box as the practice devnet. The practice period ends
11/30 24:00 JST, and the switch has to be done in a few hours by one person. This directory turns
the operator runbook (ascon-ops#49) into two commands:

| file | what |
|---|---|
| `cutover.sh` | the night's sequence as nine steps, one at a time or `all`; each prints what it did, stops at the first failure, and is safe to run again |
| `run-week.sh` | the one command that **starts and restarts** the week (`live`, or `rehearsal`); also `void` for rules §4.4.2 |
| `common.sh` | shared checks (frozen commit, dump hash, overlay, anvil version) |
| `scripts/liveWeek.ts` | the tested helpers behind them: the field and its fingerprint, image tags, docker pool capacity, voiding an epoch (`test/liveWeekCutover.test.ts`) |

Both scripts are the 2026-10-20 rehearsal's `run-week.sh` (ascon-ops#7: 12/12 epochs, restart and
resume verified) plus what that rehearsal found: images built only after the address overlay matches
the dump (issue #310, enforced by `agent:build` since #313), anvil on docker0 via `--anvil-host`
(#305), `zip` + `docker-buildx` on the host, agents-ready 180 s (#311/#314, the default now).

## The secrets directory

Everything the week reads comes from **one** directory, `~/live-secrets` (`ERIS_LIVE_SECRETS`),
mode 700, never in a repository. A restart therefore cannot pick up a different key by accident, and
the runner refuses a `--resume` whose plan, field, scenario key or state root differ anyway.

| file | made by | when |
|---|---|---|
| `live-week.env` | operator (the four role keys the production dump was deployed with + `ADMIN_ADDRESS`) | before the night |
| `wallet-secret.yaml` | `npm run competition -- wallet-keygen` (issue #249; never published) | before the night |
| `scenario-key.yaml` | `npm run competition -- keygen` (ADR 0027, the generation key K) | before the night |
| `hidden-set.yaml`, `lottery-seed.yaml` | operator (the committed files) | before the night |
| `models.yaml`, `inference-keys.yaml` (mode 600), `inference-secret` | operator (the published model list; the participants' credentials, issue #260; `openssl rand -hex 32`) | before the night |
| `inference-stats-token` | optional, `openssl rand -hex 32`: opens the proxy's `GET /admin/recording` | optional |
| `frozen-commit` | `cutover.sh freeze` | the night |
| `dump.sha256` | `cutover.sh dump --dump-sha256 <hex>` | the night |
| `accepted.tsv`, `rejected.tsv`, `accept-logs/` | `cutover.sh submissions` | the night |
| `field.yaml`, `roster-fingerprint` | `cutover.sh field` | the night |
| `images.tsv`, `build-logs/` | `cutover.sh images` | the night |
| `plan.yaml`, `commitments.txt` | `cutover.sh plan` | the night |
| `state-root`, `matrix-dir` | `run-week.sh` on its first start | 12/1 |

Back the directory up (password manager + one place off the box) as soon as the night is done: the
plan, keys and the matrix pointer are what a restart on another machine would need.

## Before the night (T−7 onward)

- **Use a checkout that is not the practice devnet's**, e.g. `~/workspace/eris-live` at the commit you
  intend to freeze, with the production dump in its `backtest/state/` (ascon-ops#49, 10/18 note). The
  overlay step regenerates `sdk/src/constants.local.ts`, and the practice coordinator would read that
  file on its next restart. All paths below are relative to that checkout; `ERIS_REPO` overrides it.
- anvil **1.7.1** (the dump's version; `foundryup -i v1.7.1`), node 24, docker + `docker-buildx`,
  `zip`/`unzip`, `tmux`.
- `/etc/docker/daemon.json` with wide `default-address-pools` (`{ "base": "10.64.0.0/10", "size": 24 }`;
  docker's built-in pools stop at the 28th agent network). Restart docker.
- A state root on its own filesystem with a host quota if you can (CHECKLIST §5); point
  `ERIS_LIVE_STATE_ROOT` at it (default `~/state-root-live`), and keep it the same for the whole week.
- `bash infra/live-week/cutover.sh preflight` any time: it checks everything else first and fails at
  the end while the practice period is still running, which is expected before 11/30 24:00.

The compose-level isolation cutover in `infra/docker-agent/ISOLATION.md` ("anvil as a bridge
container") is **not needed** for the live week: the backtest starts its own anvil on docker0's address
and `run-week.sh` starts its own gateway and proxy on the `ascon-chain` network.

## The night

All steps are run by the operator on the box, from the live checkout, inside `tmux` or `screen` (an
SSH drop must not kill a build). Times are the plan; the only measurement so far is the rehearsal's
host setup (toolchain + 3 submissions + 8 reference images on 8 vCPU: 30–40 min), so time steps 5 and
7 on the night and note them in ascon-ops#49.

| when (JST) | step | command | expect |
|---|---|---|---|
| 11/30 evening | 1 preflight (all but the practice checks) | `cutover.sh preflight` | fails only at "practice coordinator is running" |
| 11/30 evening | 2 freeze | `cutover.sh freeze` | prints the commit hash — publish it **with Appendix A** at the start of the live period (rules §4.4.3, §7.1) |
| 11/30 evening | 3 dump | `cutover.sh dump --dump-sha256 <hex from the runbook>` | seconds |
| 11/30 evening | 4 overlay | `cutover.sh overlay` | seconds; the only tracked file allowed to differ from the frozen commit |
| 11/30 evening | 5 submissions (what has arrived so far) | `cutover.sh submissions --zips <dir>` | per ZIP: scan → extract → check:strategy → image. Re-running skips what was already accepted |
| 11/30 24:00 | submission deadline; stop the practice period (its own end steps: last segment's summary, standings, `.env.practice`) | `systemctl --user stop ascon-devnet.service && systemctl --user disable ascon-devnet.service`; `(cd infra/monitoring && docker compose stop anvil rpc-gateway-live rpc-gateway-test)` in the practice checkout | |
| 24:00 + | 1 preflight (complete) | `cutover.sh preflight` | all ok |
| | 5 submissions (the final ZIPs) | `cutover.sh submissions --zips <dir>` | a rejected ZIP stops the step: decide, then fix and re-run, or `--allow-rejected` |
| | 6 field | `cutover.sh field` | prints the rosterFingerprint (matrix.json will carry it) |
| | 7 images | `cutover.sh images` | rebuilds base + every image at the frozen commit, reads each image's baked overlay and checks it against the dump; `images.tsv` has the digests for the submission ledger |
| | 8 plan | `cutover.sh plan` | prints the hidden-set, lottery-seed and generation-key commitments. **Publish the lottery-seed commitment now** (§7.1, end of the submission period); check the hidden-set and generation-key commitments equal the ones already published |
| | 9 start | `cutover.sh start` | tmux session `live-week`; within a minute `[live-week] posture checked` and `s=1 …: waiting …` or, after 00:00, s=1 starting at once |

`cutover.sh all --zips <dir> --dump-sha256 <hex>` runs steps 1–9 in order, and `--from <step>`
continues after a stop. Every step is idempotent: a recorded value that disagrees with what is on
disk is a stop, never an overwrite (`frozen-commit`, `dump.sha256`, `plan.yaml`; `field.yaml` can be
regenerated only until the week has opened its matrix).

**Epoch 1 is planned for 00:00 and the cutover ends after it.** That is fine: with
`--follow-schedule` an epoch whose start has passed starts at once and says how late; the later epochs
keep their own times. A slot is 168 min and an epoch takes ~12 min plus setup and the agents-ready
wait, so s=1 can start up to ~2.5 h late and still end before s=2's slot.

After the start: add the matrix id (`cat ~/live-secrets/matrix-dir`) to the dashboard's
`ERIS_DASHBOARD_COMPETITIONS`, check it shows standings in audience mode, and go through the live-week
checks in [../devnet/CHECKLIST.md](../devnet/CHECKLIST.md#6-ライブ週).

## Restart

```sh
bash infra/live-week/run-week.sh live      # in tmux; or: tmux kill-session -t live-week && cutover.sh start
```

The same command, whatever stopped it (Ctrl-C, a crash, a reboot). It re-checks every input and
recorded value, recreates the gateway and proxy containers (the gateway with every environment signer's
pending nonce sealed: `scripts/liveWeek.ts sealed-senders` over the official regimes and the plan,
from `live-week.env`'s role keys and `wallet-secret.yaml`; `[run-week]   ok    gateway seals the
pending nonce of 34 environment addresses`; the coordinator gets the same value as
`ERIS_GATEWAY_SEALED_SENDERS` and refuses the week before the first epoch if one of a regime's
signers is not on it), and resumes the matrix recorded in
`matrix-dir`: complete epochs are skipped, an epoch that was running starts again from its beginning
with the same seed, and the agents' state is restored from the checkpoint the epoch before it ended
with (`<state root>/.snapshots/end-s<N>`). If the first start stopped before epoch 1 finished there is
no `matrix.json` to resume; the next start opens a new matrix and moves the half-used state root aside
(`<root>.abandoned-<time>`).

## Voiding and re-running an epoch (rules §4.4.2)

- **The epoch is still running** (a fault seen during it): stop the runner (`tmux attach -t live-week`,
  Ctrl-C) and start it again. It has no result yet, so the resume runs it again from its start with
  the same seed.
- **The epoch already completed** (a fault found afterwards): stop the runner, then
  ```sh
  bash infra/live-week/run-week.sh void <s> <reason>
  bash infra/live-week/run-week.sh live
  ```
  `void` keeps a copy of `matrix.json` (`matrix.json.before-void-s<N>-<time>`), removes s's result,
  records the reason and time in its place, and leaves the voided attempt's run directory on disk. The
  resume runs s again at once with the same seed from the state the epoch before it ended with. The
  epochs after s are **not** re-run (whether they stand is the organizer's call); a re-run inside the
  idle part of a slot does not move the later epochs' times.
- Announce both on Discord, and record the reason in ascon-ops#49.

## During the week

The daily and per-epoch checks are in [CHECKLIST.md §6](../devnet/CHECKLIST.md#6-ライブ週). Back up
after every epoch (or hourly): the matrix directory, `<state root>/.snapshots/`, `runs/inference-live/`
and `runs/rpc-gateway-live/` (rsync with a date; `matrix.json` is written atomically, #262).
