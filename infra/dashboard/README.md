# hosted dashboard — staying at the pinned commit

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

**The server's own code is the exception, and it is the half that withholds things.** The container
runs `node_modules/.bin/tsx dashboard/server/serve.ts` under `restart: unless-stopped`: the process
compiled that file when it started and keeps serving that version however many times `dist` is
rebuilt around it. So a change under `dashboard/server/` is not live until the container is
restarted:

```sh
cd infra/monitoring && docker compose restart ascon-dashboard
```

| what changed | live when |
|---|---|
| `dashboard/src/**` — the bundle | the next page load after the build |
| a run's files under `runs/` | the next index poll |
| `dashboard/server/**` — the runs API, the audience redaction, the competition allowlist, `/healthz` | only after `docker compose restart ascon-dashboard` |

Which way round this goes matters more than it looks, because the public/operator split lives in
`dashboard/server/runsApi.ts`: issues #198, #202, #203 and #204 were each a fix to what that file
withholds. Promote one of them, watch the tick log a successful build, and the server is still
answering with the old rules — something that was supposed to stop being public stays public, and
the page gives no sign of it. `/healthz` reports the commit the running process started with next to
the commit the bundle was built from ("Is the box serving what was promoted" below); when those two
differ, a build has landed since the restart.

That is also why the box drifts: merging to `main` changes nothing on its own, because nobody ran
the build. `sync-main.sh` is the thing that closes that gap — at the commit the operator chose,
not at whatever `main` is at the moment (issue #211, below).

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

# Pin the commit to serve. Until this is done the box is "held": it builds whatever HEAD is and
# fetches nothing. The ref must be a tag or a commit sha that is on origin/main.
~/workspace/eris-agent-simulator/infra/dashboard/sync-main.sh promote <tag|sha>
```

Check it: `systemctl --user list-timers eris-dashboard-sync.timer`, and
`journalctl --user -u eris-dashboard-sync -n 30` for what the last few runs did — the first line of
every tick says which mode it is in and which commit it is at.

## Which commit runs here (issue #211)

`vite build` evaluates `dashboard/vite.config.ts` and everything it imports, as the operator user,
on the host. This checkout sits next to `.env.local` (role keys), `.env.practice` (the period's
seed), `infra/monitoring/.env` (`ANVIL_MNEMONIC`) and the participant-key directory. A sync that
followed `main` therefore ran every commit that landed on `main` on this box, within five minutes,
with all of that in reach. Two defences, independent of each other:

1. **the pin** — which commit is checked out is a decision somebody makes, not a timer (this
   section)
2. **the container build** — the build sees nothing but the commit (next section)

`infra/dashboard/sync.env` (gitignored; [`sync.env.example`](sync.env.example) is the template)
holds the decision. Three modes, and every tick logs which one it is in:

| `sync.env` | mode | what a tick does |
|---|---|---|
| `ERIS_SYNC_REF=<tag or sha>` | **pinned** | fetches `main`, resolves the ref, **refuses** it unless it is an ancestor of `origin/main` (and unless it carries this script, see below), checks it out detached if HEAD differs, builds if `dist` is stale. The mode for a live week |
| neither | **held** | fetches nothing, checks out nothing, builds HEAD if `dist` is stale. Where a fresh install sits until something is promoted |
| `ERIS_SYNC_FOLLOW_BRANCH=main` | **following** | the pre-#211 behaviour: `--ff-only` to the branch tip every tick, then build. **Opt-in**, and the tick logs `FOLLOWING` in capitals: whatever lands on that branch is executed here within five minutes |

Promotion is the manual step:

```sh
infra/dashboard/sync-main.sh promote v2026.10.02     # a tag on origin/main
infra/dashboard/sync-main.sh promote 0545ae7           # or a sha
```

It runs the same checks as a tick, writes `ERIS_SYNC_REF` to `sync.env` (removing any
`ERIS_SYNC_FOLLOW_BRANCH`, with a dated comment line saying what was promoted and what it resolved
to), and runs one tick so the change is live now rather than at the next timer boundary. Editing
`sync.env` by hand is the same thing without the comment line; the next tick picks it up.
`ERIS_SYNC_REF=<ref> infra/dashboard/sync-main.sh` tries a ref for one tick without writing the
file (the environment wins over `sync.env`).

What a pin is and is not:

- a **tag** or a **commit sha** (7–40 hex). Not a branch name, not `origin/main`, not `FETCH_HEAD`
  — those would resolve, and silently turn "pinned" into "following" under the wrong log line. A
  tag that is not in the clone yet is fetched by name; a tag already in the clone is used as is, so
  a tag rewritten upstream is *not* followed (repin a sha to move)
- **on `origin/main`**. A commit that is not an ancestor of `origin/main` is refused and nothing is
  checked out — a pin names something that went through `main`, and that is the whole point
- **not older than #211**. The timer runs `sync-main.sh` *from the checkout*, so pinning a commit
  from before the pin existed would put the old following script back on the timer, and its next
  tick would fast-forward to `main` and build on the host: the pin undoing itself. Refused
- **detached**. Pinned mode checks out the sha with `--detach`; `git status` on the box says `HEAD
  detached at <sha>`, which is the honest description. Switching to following mode later
  fast-forwards the detached HEAD; `git checkout main` first if you want the branch to move

**Branch protection on `main` is assumed, not verified by this repo.** Checked on 2026-10-02
through the GitHub API: no rulesets apply to `main`, and the classic branch-protection endpoint
answers 404 to a non-admin — which is what both "none" and "not visible to you" look like. Until an
admin confirms that `main` requires review, assume it does not. Then the pin is the only line
between a push to `main` and this box, and `ERIS_SYNC_FOLLOW_BRANCH=main` is a decision to trust
every push, reviewed or not.

## Where the build runs

By default (`ERIS_SYNC_BUILD=container`) a tick builds in a `node:24-bookworm-slim` container
(`ERIS_SYNC_BUILD_IMAGE` to change it; the same image `ascon-dashboard` serves from) that sees:

- a clean `git archive` of the pinned commit — **tracked files only**, so no `.env.local`, no
  `.env.practice`, no `infra/monitoring/.env`, no `runs/`, no state dump, no keys directory
- this checkout's `node_modules` (and the workspaces' nested ones), **read-only**. A sync never
  runs `npm install`; the lockfile-resolved tree the box already has is what gets used
- `dashboard/.env.production.local` if it exists — the explorer URL the bundle compiles in
  ("Explorer links" below). The one untracked input the build has
- **no network** (`--network none`), the host user's uid (`--user`), a read-only root filesystem
  with a tmpfs `/tmp` for npm's cache, no privilege escalation, no capabilities, a pid cap — the
  hardening `infra/docker-agent/run-agent.sh` uses where it applies

The bundle is built in that export and **swapped** into `dashboard/dist` only once
`index.html` exists. The in-place `vite build` used to empty `dist` first, so a failed build left
nothing to serve; now the previous bundle keeps serving and the next tick retries (the stamp inside
`dist` still names the old commit).

`ERIS_SYNC_BUILD=host` is the old in-place `npm run dashboard:build`, as the operator user with
everything that user can read in reach. It exists for a box without docker, it is an opt-in, and
the tick logs it as `building on the HOST`. With docker missing and `host` not set, the tick fails
(exit 1) and says which of the two to do.

## Is the box serving what was promoted

Every build writes `dashboard/dist/.build-info.json` — the commit and the time — next to the
`.built-at` stamp the build-skip compares against. `dist/` is served as files and
`dashboard/server/serve.ts` reads that file per request, so the question is answerable from outside
the box, without an SSH session:

```sh
curl -s https://ascon-dash.nyx.foundation/healthz
curl -s https://ascon-dash.nyx.foundation/.build-info.json   # commit and builtAt, as a static file
```

| `/healthz` field | what it is |
|---|---|
| `ok` | node is up and `runs/` can be listed. Unchanged: `ascon_dashboard_down` alerts on this field, and a stale bundle is not an outage |
| `commit`, `builtAt` | the commit `dashboard/dist` was built from, and when it was built |
| `serverCommit`, `serverStartedAt` | what that file said when the serving process started, and when that was |
| `builtSinceStart` | the two commits differ — a build landed under this process |

Three states that `{"ok":true}` on its own did not distinguish:

- **a promotion that was never made.** `commit` is not the commit that was merged. Merging moves
  `main`, not this box; the sync is doing exactly what it was told, and the page is older than
  whoever merged believes. `infra/dashboard/sync-main.sh promote <tag|sha>`
- **a sync that quietly stopped.** `builtAt` stops moving while `main` does not. The likeliest cause
  is not a crash: `clean_tree` exits **0** with a single journal line when a tracked file is
  modified, so running `npm run gen:local-constants` on the box — it rewrites
  `sdk/src/constants.local.ts`, a tracked file — ends the updates with no failed unit and no alert.
  `git status` on the box, then `git checkout -- <file>`
- **server code that is not live yet.** `builtSinceStart: true` says the bundle moved and this
  process did not. If the build touched `dashboard/server/`, `docker compose restart
  ascon-dashboard` (the table at the top of this file)

A commit sha is public information — this repo is public — so reporting it discloses nothing a
reader could not get by cloning. The pin's *name* is deliberately not reported: a tag can say more
about what the operator is planning than a sha does.

## Explorer links

Transactions, blocks and addresses link into Blockscout (`ascon-explorer.nyx.foundation`) when the
dashboard can see it. Two settings, in two places:

| what | where | on the hosted box |
|---|---|---|
| where the **links** point (the browser opens it) | `VITE_BLOCKSCOUT_URL`, read by `vite build` | `dashboard/.env.production.local` (gitignored): `VITE_BLOCKSCOUT_URL=https://ascon-explorer.nyx.foundation` |
| where the **server** checks the explorer is up | `ERIS_BLOCKSCOUT_URL` | the compose default, `http://eris-explorer-backend:4000` |

The first is compiled into the bundle, so it has to be there before the build: without it the
bundle links to `http://localhost:3100`, the local-dev explorer, which on a participant's machine is
nothing. After adding it, rebuild once (the sync only builds when `dist` is stale):

```sh
rm -f dashboard/dist/.built-at && systemctl --user start eris-dashboard-sync.service
```

If the server cannot reach the explorer, the dashboard hides the links and says so ("Block-explorer
links are unavailable") — which is also what a missing explorer looks like.

## What it refuses to do

It checks out the configured commit and builds it, and stops short of anything that would decide
something on its own:

- **no merge** — `--ff-only` in following mode, `checkout --detach` in pinned mode. A checkout
  carrying local commits is somebody mid-experiment, and a competition is not the place to find out
  what a merge commit does to it
- **no build over a dirty tree** — modified *tracked* files would ship into the bundle. Untracked
  ones are fine: a scratch config and a run writing under `runs/` are the normal state of the box
- **no rebuild when `dist` already matches HEAD** — the bundle is content-hashed, so rebuilding at
  the same commit hands every open browser a new filename for the same page. The comparison is
  against `dashboard/dist/.built-at`, not against what this run checked out: a commit somebody had
  already checked out by hand would otherwise never get built
- **no pin that is not on `origin/main`, or that predates #211** — refused before anything is
  checked out (above)
- **no build with both `ERIS_SYNC_REF` and `ERIS_SYNC_FOLLOW_BRANCH` set** — pick one
- **no `dist` from a failed build** — the swap happens after `index.html` exists, or not at all

The first three exit 0 with a line saying which one happened: a sync that "did nothing" is a fact
worth reading in the journal, not a failure worth alerting on. The refusals exit 1 and show up as a
failed unit, because a pin that is not on `main` or a configuration that contradicts itself is
exactly what should be noticed.

One structural note: this file lives in the tree it syncs, so a checkout can rewrite it mid-run, and
bash reads a script as it executes. The pre-#211 script handled that by handing over to the freshly
pulled file with `exec`. It no longer does — handing over means running code the tick has not
looked at. Instead the whole script is one function, parsed before anything executes, called on a
line that ends in `exit`: a tick runs to the end on the version it started with, and the version at
the new commit governs from the next tick. (The old `ERIS_SYNC_PHASE=build` handover is still
honoured, once, for the tick that installs this version.)
