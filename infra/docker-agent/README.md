# infra/docker-agent — one image per team, on a shared base

Every agent runs in a memory/CPU-capped container, used the same way in three places: **live** (the
operator runs each submitted agent isolated), **local dev**, and **self-test** (a participant
confirms their agent fits the budget before submitting, under the exact image and caps production
uses). Memory limits are only trustworthy if you develop against the environment that enforces them.

## Two images

| image | contents | built by |
|---|---|---|
| **`eris-agent-base`** | TypeScript/Python SDKs + `example/agents/{runtime,lib}` + Node/Python toolchain and dependencies. **No team code.** | `npm run agent:build` |
| **`eris-agent:<id>`** | `FROM base` + only that one team's `example/agents/<id>/` (and its own deps) | `npm run agent:build -- team <id>` |

**Why per-team, not one shared image:** a single image with every agent baked in would put every
team's strategy source inside every container (extractable via `docker save`) — an IP/integrity leak
in a prize competition. Per-team images also let a team bring its own dependencies (installed at
build time), and give a pinned artifact (`eris-agent:<id>` digest) for the replay audit. The base
layer is shared on disk, so 100 team images cost ~one base plus small per-team deltas.

> **Build-time supply chain:** `build.sh team` runs the team's `npm install` and `pip install`
> (package build/install hooks execute). Build team images in a throwaway/sandboxed builder.

```bash
npm run agent:build              # base (once)
npm run agent:build -- team foo  # per team (refreshes base, reusing unchanged layers) -> eris-agent:foo
```

## Self-test the memory budget

The shared image includes Python 3.11.16 and the generated `eris` SDK. A Python team ships
`strategy.py`, `prompt.md` and optionally pinned `requirements.txt`; the team build installs
requirements before the root filesystem becomes read-only. Revisions are compiled into `/tmp`.
Node, Python, NumPy and every other team dependency share the same 4 GiB container cap.
`npm run agent:selftest -- my-arb-py` exercises this path. Set `ERIS_SELFTEST_CONFIG` to choose a
short local config; the default uses `config/local.yaml`, or `config/example.yaml` if absent.
The wrapper selects container `python3` independently of a host `ERIS_PYTHON` venv path;
`ERIS_DOCKER_PYTHON` overrides the executable inside the image. Python bind-mount mode defaults
to the shared Python base (build it first), or your `ERIS_AGENT_IMAGE` with team dependencies.

`self-test.sh` builds the team image, refreshing its runtime base from the current sources, then
runs the configured local environment with that agent and a noop baseline, both in Docker.
It reads the exact run's `summary.json` and prints `PASS` with included/reverted counts, or `FAIL`
with the early-exit reason and stderr. A failed run, absent/invalid summary or surviving container
also exits nonzero. Code 137 means SIGKILL (possibly OOM); it alone does not prove an OOM kill.
A pass proves completion at the stated cap for this run; it is not a peak-memory measurement.

Team images are immutable: after pulling runtime/SDK changes, rebuild **every** roster directory's
image. `agent:build -- team` refreshes the shared base first and prints its digest/build time;
Docker caches unchanged layers. Already-built teams and externally submitted bundles retain the
runtime they were built with until rebuilt. Updating the base tag alone cannot update them.

```bash
# Terminal 1 — local-deploy chain (anvil + all venues); leave it running:
cd deployer && npm run deploy -- --keep-fresh

# Terminal 2 — once Terminal 1 has printed the deployed addresses:
npm run gen:local-constants                        # import the deployed addresses
npm run agent:selftest -- my-agent                 # memory cap: ERIS_DOCKER_MEM (default 4g)
```
(`npm run anvil` is fork-mode only and refuses under `ERIS_LOCAL_DEPLOY=1`. Don't run
`gen:local-constants` until the deploy has finished — `--keep-fresh` resets `deployments.json` first.)

`--memory-swap` is pinned to `--memory`, so an over-budget agent OOM-kills rather than silently
swapping — that is the signal you want. Measured footprint of the reference agent is ~130–170 MiB
regardless of the LLM improve loop (inference runs off-container), so 1 GiB is comfortable; this
verifies *your* agent's compute. Watch it live with `docker stats eris-my-agent`.

## Wiring into a run (operator)

Point each agent's `command` at `run-agent.sh` and pass its directory via `env`:

```yaml
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true            # host-run yardstick; not containerised
  - id: team-alice
    dir: team-alice
    wallet: AUTO
    command: infra/docker-agent/run-agent.sh
    env: { ERIS_AGENT_DIR: "/abs/path/eris-agent-simulator/example/agents/team-alice" }
```

Run the environment as usual (`ERIS_LOCAL_DEPLOY=1 npm run sim:realtime -- --config <cfg>`). Afterwards
sweep any survivors: `npm run agent:reap`.

`run-agent.sh` picks the image `eris-agent:<basename of ERIS_AGENT_DIR>` by default (override with
`ERIS_AGENT_IMAGE`). **Invariant:** the agent directory basename, the `build.sh team <id>` id, and
`ERIS_AGENT_ID` must be the same `<id>`, or you get a confusing "image not found". It has two modes:

- **image (default)** — the per-team image; the coordinator's absolute host paths are remapped onto
  the image's `/eris`, and only the agent's view directory and its own log files are mounted in
  (below).
- **bind-mount** (`ERIS_AGENT_BINDMOUNT=1`) — stock `node:24` with the repo bind-mounted at its own
  host path; no build, for iterating on runtime code. The whole repository and run directory are
  visible from inside, so this mode is for the operator's own agents and is **not an isolation
  boundary**. Neither is `--agent-sandbox process`, which runs agents as host processes.

Caps: `ERIS_DOCKER_MEM` (default `4g`), `ERIS_DOCKER_CPUS` (default `2`) — the budget the
competition rules promise a participant. The headroom is nominal rather than reserved: the 100-
container run below measured ~190 MiB of host memory per agent.

## The coordinator's standard path

The official regimes set `run.agentSandbox: docker`, so `npm run backtest` launches every agent through
`run-agent.sh` (the coordinator records `agent_sandbox` in events.jsonl either way). Image mode expects
`eris-agent:<id>`; `ERIS_AGENT_BINDMOUNT=1` runs the stock node image over a bind mount instead. Without
docker at all, pass `--agent-sandbox process` — no caps, and the event says so. Every `ERIS_*` variable
the coordinator sets is forwarded into the container, except the host paths the wrapper maps itself;
the coordinator does not hand an agent its own config file or any env name carrying a seed
(`core/src/realtime/agentProcess.ts`). Inference API keys are forwarded only when no inference proxy
(`ERIS_INFERENCE_BASE_URL`) is named.

## What an agent container sees (image mode)

For every agent it launches, the coordinator prepares a view directory,
`runs/<id>/agent-view/<agentId>/` (`core/src/realtime/agentView.ts`):

| file | what it is |
|---|---|
| `config.yaml` | the agent's config: the fields the runtime reads (run length, block time, venues, fees, gas budget, …) as this run resolved them. No seed, no stress / flow / vuln / funding section, no roster |
| `run-start.json` | the run's first block and block budget (`sdk/src/runStart.ts`), written once counting starts |

`run-agent.sh` then mounts, and nothing else of the run:

| path in the container | from the host | mode |
|---|---|---|
| `/eris/run` (= `ERIS_RUN_DIR`) | `runs/<id>/agent-view/<agentId>/` | read-only |
| `/eris/run/agents/<agentId>.jsonl` | `runs/<id>/agents/<agentId>.jsonl` | read-write |
| `/eris/run/agents/<agentId>.llm.jsonl` | the same file under `runs/<id>/agents/`, only with `ERIS_IMPROVE_LOG_CALLS=1` | read-write |
| `/eris/run/disclosures` | `runs/<id>/disclosures/`, only when the run publishes any (ADR 0014) | read-only |
| `/eris/state` | the agent's persistent area, when the run provides one (below) | read-write |
| `/tmp` | tmpfs, 512 MiB, per container, gone at exit | read-write |

`ERIS_CONFIG` inside is `/eris/run/config.yaml`. The rootfs is read-only.

The log files are mounted file by file, so they are the host's own `runs/<id>/agents/<agentId>.jsonl`:
the dashboard (live tail included), the agents-ready wait and the post-run checks read them where
they always did. The wrapper creates the empty log and its mountpoint in the view directory before
the container starts, because a mountpoint inside a read-only mount has to exist beforehand.

History: the log mount used to be the whole of `runs/` (every run of every epoch), then the run the
agent was in (issue #77). Both held more than an agent needs — the coordinator's `events.jsonl`,
`summary.json` and `market.json`, and every other agent's decision log and transcript.

Two cases still mount a directory:

- **a segmented period** (ADR 0021 §6): the run directory rolls underneath a running agent, so the
  competition directory is mounted, which shows the period's earlier segments. Only the practice
  devnet runs segmented and its participants self-host; the coordinator records
  `agent_sandbox_warning` when it launches docker agents into one.
- **no `ERIS_AGENT_VIEW_DIR`**: `run-agent.sh` started by something other than this repo's
  coordinator gets the run directory, as before.

`ERIS_AGENT_STATE_DIR` is the persistent area. The coordinator creates one per agent under
`ERIS_AGENT_STATE_ROOT` and passes the path; `run-agent.sh` mounts it at `/eris/state` in image mode
and at its own host path in bind-mount mode. `ERIS_AGENT_STATE_CAP_BYTES` (default 64 MiB) is the
cap the runtime enforces on itself. Absent means this run does not persist, which is every run that
does not ask for it.

## Isolation caveat (egress)

Containers join `ERIS_AGENT_NET` (default `host`, sharing the host network; the default bridge on
macOS) — **with the default, nothing is contained**: an agent can reach services on the host directly,
not only the RPC endpoint it was given. `ERIS_AGENT_ISOLATE=1` gives each agent its own network with
the RPC gateway as the hub ([ISOLATION.md](ISOLATION.md)); `ERIS_AGENT_INTERNAL=1` creates that
network without a route out and `ERIS_INFERENCE_HUB` attaches the inference proxy to it, which is how
rules §2.3's "no direct external connection" holds in the competition. Deps are resolved at build time
precisely so run time needs no outbound access.

The coordinator does not refuse to start without isolation (local checks and the operator's own
reference field run on host networking), but it says so: an `agent_sandbox_warning` event in
`events.jsonl` naming the agents and what they lack (shared network / open egress / bind-mount /
segmented period), and a banner on stderr at startup and again when the run completes. The live week
runs with `ERIS_AGENT_ISOLATE=1`, `ERIS_AGENT_INTERNAL=1`, `ERIS_AGENT_RPC_URL` pointing at the RPC
gateway, and `ERIS_INFERENCE_HUB` + `ERIS_INFERENCE_BASE_URL` for the inference proxy
([ISOLATION.md](ISOLATION.md)). No banner means every docker agent the coordinator launched ran in
image mode on a per-agent network without a route out; where each one points its RPC and inference
traffic is still the operator's to set.

## Env contract (two silent traps)

- **`ERIS_AGENT_DIR`** — a `command` override skips the directory convention, so declare it in the
  agent's roster `env:`.
- **`ERIS_LOCAL_DEPLOY`** — comes from the operator's *process* env. Without it,
  `sdk/src/constants.ts` ignores `constants.local` and Multicall3 plus every venue/token address
  fall back to the fork chain, so every read and tx build fails while `docker stats` looks healthy.

## Scale

100 containers ran on a 16-core / 187 GB host at a 4 s block time **on budget** (150 blocks in
597 s ≈ 3.98 s/block, no lag; ~19 GB host memory, loadavg well under 16). Memory and CPU are not the
limit at 100; above that (or at a 2 s block) the limit is single-endpoint RPC serialisation,
addressed by the parallel oracle writes in this PR and by a longer block time.

## Files

`Dockerfile.base` (+ `Dockerfile.base.dockerignore`), `Dockerfile.team`, `build.sh`, `run-agent.sh`,
`self-test.sh`, `reap.sh`. Exposed as `npm run agent:build` / `agent:selftest` / `agent:reap`.


## The replay audit's "pinned artifact" is not actually pinned yet (measured 2026-09-17)

The rationale above says per-team images "give a pinned artifact (`eris-agent:<id>` digest) for the
replay audit". Verified against a real live-topology run on ascon-live: **the digest is not recorded
anywhere the audit could read it.**

| where you would look | what is there |
|---|---|
| `runs/<id>/events.jsonl` | `"sandbox":"docker"` and nothing else — no image, no digest |
| `runs/<id>/manifest.json` | `participants`, `contracts`, `limits` … no image field |
| the image itself | `eris-agent:bench-max` → `sha256:9e674344e9eb…` |

`eris-agent:<id>` is a **local tag**, so rebuilding it after the run produces a different image under
the same name and nothing in the run says which one actually executed. For an audit that has to
answer "was this the code they submitted", the tag is not evidence; the digest is.

**Fixed 2026-09-17.** `run-agent.sh` resolves the digest at spawn and appends one line per agent to
`runs/<id>/images.jsonl`:

```json
{"ts":"…","agentId":"bench-max-002","image":"eris-agent:bench-max","digest":"sha256:9e674344e9eb…","mode":"image"}
```

`mode` distinguishes `image` (the competition path) from `bindmount` (rehearsal), so a run cannot
later be mistaken for the other. Writing is best-effort — a failed `docker image inspect` records
`"digest":"unresolved"` rather than failing the spawn, because losing an agent to a provenance
problem would be the worse trade. Verified on ascon-live: four roster entries, four lines, digests
matching `docker image inspect`.
