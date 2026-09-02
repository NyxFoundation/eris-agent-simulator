# infra/docker-agent — one image per team, on a shared base

Every agent runs in a memory/CPU-capped container, used the same way in three places: **live** (the
operator runs each submitted agent isolated), **local dev**, and **self-test** (a participant
confirms their agent fits the budget before submitting, under the exact image and caps production
uses). Memory limits are only trustworthy if you develop against the environment that enforces them.

## Two images

| image | contents | built by |
|---|---|---|
| **`eris-agent-base`** | the shared runtime — sdk + core + `example/agents/runtime` + toolchain (`npm ci`). **No team code.** | `build.sh base` |
| **`eris-agent:<id>`** | `FROM base` + only that one team's `example/agents/<id>/` (and its own deps) | `build.sh team <id>` |

**Why per-team, not one shared image:** a single image with every agent baked in would put every
team's strategy source inside every container — an IP/integrity leak in a prize competition. Per-team
images also let a team bring its own dependencies (installed at build time; run-time egress stays
blocked), and give a pinned artifact (`eris-agent:<id>` digest) for the replay audit. The base layer
is shared on disk, so 100 team images cost ~one base plus small per-team deltas.

> **Build-time supply chain:** `build.sh team` runs the team's `npm install` (postinstall scripts
> execute). Build team images in a throwaway/sandboxed builder.

```bash
infra/docker-agent/build.sh base            # once
infra/docker-agent/build.sh team my-agent   # per team (auto-builds base if missing)
```

## Self-test the memory budget

Run your team image with the real cap. `--memory-swap` equals `--memory`, so an over-budget agent is
OOM-killed rather than silently swapping — that is the signal you want.

```bash
infra/docker-agent/build.sh team my-agent
docker run --rm --network host --memory=1g --memory-swap=1g --cpus=0.5 \
  -e ERIS_LOCAL_DEPLOY=1 -e ERIS_RPC_URL=http://127.0.0.1:8545 \
  -e ERIS_AGENT_ID=me -e ERIS_AGENT_DIR=/eris/example/agents/my-agent \
  -e ERIS_AGENT_PRIVATE_KEY=0x... -e ERIS_PRICE_FEED_ADDRESS=0x... \
  -v "$PWD/runs:/eris/runs" \
  eris-agent:my-agent
```

Measured footprint of the reference agent is ~130–170 MiB regardless of the LLM improve loop
(inference runs off-container), so 1 GiB is comfortable — this verifies *your* agent's compute.

## Wiring into a run

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
sweep any survivors: `infra/docker-agent/reap.sh`.

`run-agent.sh` picks the image `eris-agent:<basename of ERIS_AGENT_DIR>` by default (override with
`ERIS_AGENT_IMAGE`). It has two modes:

- **image (default)** — the per-team image; the coordinator's absolute host paths are remapped onto
  the image's `/eris`, and the config file + `runs/` dir are mounted in.
- **bind-mount** (`ERIS_AGENT_BINDMOUNT=1`) — stock `node:24` with the repo bind-mounted at its own
  host path; no build, for iterating on runtime code.

Caps: `ERIS_DOCKER_MEM` (default `1g`), `ERIS_DOCKER_CPUS` (default `0.5`).

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

`Dockerfile.base`, `Dockerfile.team`, `build.sh`, `run-agent.sh`, `reap.sh`.
