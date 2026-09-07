# hosted dashboard — staying on main

`ascon-dash.nyx.foundation` is this repo's dashboard, served by the `ascon-dashboard` container in
[`infra/monitoring/docker-compose.yml`](../monitoring/docker-compose.yml). The container mounts the
checkout **read-only** and serves two directories out of it:

| what it serves | from |
|---|---|
| the bundle | `dashboard/dist` (`ERIS_DASHBOARD_DIST=/eris/dashboard/dist`) |
| the run artifacts | `runs/` (`ERIS_RUNS_DIR=/eris/runs`) |

So a deploy is a **build**, not a release. `dashboard/server/serve.ts` opens both directories per
request and holds no state, which means a rebuilt `dist` is live on the next page load and a run
that finishes appears in the index within one poll — neither needs the container touched.

That is also why the box drifts: pushing to `main` changes nothing on its own, because nobody ran
the build. `sync-main.sh` is the thing that closes that gap.

## Install (once, on the box that hosts it)

```sh
mkdir -p ~/.config/systemd/user
ln -sf ~/workspace/eris-agent-simulator/infra/dashboard/eris-dashboard-sync.service ~/.config/systemd/user/
ln -sf ~/workspace/eris-agent-simulator/infra/dashboard/eris-dashboard-sync.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now eris-dashboard-sync.timer

# User units stop when the last session ends. The dashboard is public and the box is headless most
# of the time, so the timer has to outlive a logout.
loginctl enable-linger "$USER"
```

Check it: `systemctl --user list-timers eris-dashboard-sync.timer`, and
`journalctl --user -u eris-dashboard-sync -n 30` for what the last few runs did.

## What it refuses to do

It fast-forwards and builds, and stops short of anything that would decide something on its own:

- **no merge** — `--ff-only`. A checkout carrying local commits is somebody mid-experiment, and a
  competition is not the place to find out what a merge commit does to it
- **no build over a dirty tree** — modified *tracked* files would ship into the bundle. Untracked
  ones are fine: a scratch config and a run writing under `runs/` are the normal state of the box
- **no rebuild when `dist` already matches HEAD** — the bundle is content-hashed, so rebuilding at
  the same commit hands every open browser a new filename for the same page. The comparison is
  against `dashboard/dist/.built-at`, not against what this run pulled: a commit somebody had
  already pulled by hand would otherwise never get built

Each of those exits 0 with a line saying which one happened. A sync that "did nothing" is a fact
worth reading in the journal, not a failure worth alerting on.

One structural note, because it looks like an accident: the pull and the build run as two processes,
the first handing over to the second with `exec`. A pull can rewrite `sync-main.sh` itself, and bash
reads a script as it executes — carrying on in the same process would run the tail of the new file
from the old byte offset. The handover means the build always comes from the version that was just
pulled.
