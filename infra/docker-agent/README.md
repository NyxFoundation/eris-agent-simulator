# infra/docker-agent — one image per team, on a shared base

Every agent runs in a memory/CPU-capped container, used the same way in three places: **live** (the
operator runs each submitted agent isolated), **local dev**, and **self-test** (a participant
confirms their agent fits the budget before submitting, under the exact image and caps production
uses). Memory limits are only trustworthy if you develop against the environment that enforces them.

## Two images

| image | contents | built by |
|---|---|---|
| **`eris-agent-base`** | the shared runtime — sdk + core + `example/agents/{runtime,lib}` + toolchain (`npm ci`). **No team code.** | `npm run agent:build` |
| **`eris-agent:<id>`** | `FROM base` + only that one team's `example/agents/<id>/` (and its own deps) | `npm run agent:build -- team <id>` |

**Why per-team, not one shared image:** a single image with every agent baked in would put every
team's strategy source inside every container (extractable via `docker save`) — an IP/integrity leak
in a prize competition. Per-team images also let a team bring its own dependencies (installed at
build time), and give a pinned artifact (`eris-agent:<id>` digest) for the replay audit. The base
layer is shared on disk, so 100 team images cost ~one base plus small per-team deltas.

> **Build-time supply chain:** `build.sh team` runs the team's `npm install` (postinstall scripts
> execute). Build team images in a throwaway/sandboxed builder.

```bash
npm run agent:build              # base (once)
npm run agent:build -- team foo  # per team (auto-builds base if missing) -> eris-agent:foo
```

## Self-test the memory budget

`self-test.sh` builds the team image and runs a short live environment (funds wallets + deploys
venues) with only that agent + a noop baseline, each capped. An agent that exceeds the cap is
OOM-killed and reported as an early exit (code 137).

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
  the image's `/eris`, and the config file + the agent's log directory are mounted in.
- **bind-mount** (`ERIS_AGENT_BINDMOUNT=1`) — stock `node:24` with the repo bind-mounted at its own
  host path; no build, for iterating on runtime code.

Caps: `ERIS_DOCKER_MEM` (default `4g`), `ERIS_DOCKER_CPUS` (default `2`) — the budget the
competition rules promise a participant. The headroom is nominal rather than reserved: the 100-
container run below measured ~190 MiB of host memory per agent.

## The coordinator's standard path

The official regimes set `run.agentSandbox: docker`, so `npm run backtest` launches every agent through
`run-agent.sh` (the coordinator records `agent_sandbox` in events.jsonl either way). Image mode expects
`eris-agent:<id>`; `ERIS_AGENT_BINDMOUNT=1` runs the stock node image over a bind mount instead. Without
docker at all, pass `--agent-sandbox process` — no caps, and the event says so. Every `ERIS_*` variable
the coordinator sets is forwarded into the container; inference API keys are forwarded only when no
inference proxy (`ERIS_INFERENCE_BASE_URL`) is named.

## What is writable inside the container (issue #77)

The rootfs is read-only. Three things are not:

| path | what it is |
|---|---|
| `/tmp` | tmpfs, 512 MiB, per container, gone at exit |
| the run's log directory | where `runs/<id>/agents/<agentId>.jsonl` is written |
| `/eris/state` | the agent's persistent area, when the run provides one |

The log mount used to be the whole of `runs/`, which is every run of every epoch. Two consequences
nobody had asked for: an agent could read another epoch's `events.jsonl`, and it could keep state
anywhere under it — cross-epoch carry-over through the one mount that was meant for logs. It is now
the run the agent is actually in (or, when the period is segmented and the current-segment pointer
lives one level up, the competition directory — the narrowest mount that still lets a segment roll
work).

`ERIS_AGENT_STATE_DIR` is the persistent area. The coordinator creates one per agent under
`ERIS_AGENT_STATE_ROOT` and passes the path; `run-agent.sh` mounts it at `/eris/state` in image mode
and at its own host path in bind-mount mode. `ERIS_AGENT_STATE_CAP_BYTES` (default 64 MiB) is the
cap the runtime enforces on itself. Absent means this run does not persist, which is every run that
does not ask for it.

## Isolation caveat (egress)

Containers join `ERIS_AGENT_NET` (default `host`, sharing the host network) — **with the default,
nothing is contained.** `ERIS_AGENT_ISOLATE=1` gives each agent its own network with the RPC gateway
as the hub ([ISOLATION.md](ISOLATION.md)); `ERIS_AGENT_INTERNAL=1` creates that network without a route
out and `ERIS_INFERENCE_HUB` attaches the inference proxy to it, which is how rules §2.3's "no direct
external connection" holds in the competition. Deps are resolved at build time precisely so run time
needs no outbound access.

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
