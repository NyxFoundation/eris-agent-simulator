# infra/docker-agent — run every agent in a resource-capped container

One canonical image (`Dockerfile`) runs an eris agent, used the same way in three places:

- **live** — the operator runs each submitted agent isolated (autonomous-container form);
- **local dev** — a participant runs their agent against a local chain;
- **self-test** — a participant confirms their agent stays within the memory/CPU budget *before*
  submitting, under the exact same image and caps that production uses.

That last one is the reason the image exists: memory limits can only be trusted if the environment
that enforces them is the environment participants develop in.

## The image

`Dockerfile` bakes the runtime (sdk + core + example + the tsx/esbuild toolchain via `npm ci`) at
`/eris`. It is self-contained — no host bind-mount needed. A participant's agent lives under
`example/agents/<id>/` and is copied in at build time; select it with `ERIS_AGENT_DIR`.

```bash
docker build -f infra/docker-agent/Dockerfile -t eris-agent:local .
```

## Self-test the memory budget

Run your agent in the image with the real cap. `--memory-swap` equals `--memory`, so an over-budget
agent is OOM-killed rather than silently swapping — that is the signal you want.

```bash
docker run --rm --network host \
  --memory=1g --memory-swap=1g --cpus=0.5 \
  -e ERIS_LOCAL_DEPLOY=1 \
  -e ERIS_RPC_URL=http://127.0.0.1:8545 \
  -e ERIS_AGENT_ID=me -e ERIS_AGENT_DIR=/eris/example/agents/<your-agent> \
  -e ERIS_AGENT_PRIVATE_KEY=0x... -e ERIS_PRICE_FEED_ADDRESS=0x... \
  -v "$PWD/runs:/eris/runs" \
  eris-agent:local
```

Watch it with `docker stats`; if it exceeds the cap the container exits on OOM. Measured footprint
of the reference agent is ~130–170 MiB regardless of the LLM improve loop (inference runs
off-container via the provider), so 1 GiB is comfortable — but your own agent's compute is what this
verifies.

## Wiring it into a run (operator / full self-test)

Point each competing agent's `command` at `run-agent.sh` and pass its directory via `env`:

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

Run the environment as usual (`ERIS_LOCAL_DEPLOY=1 npm run sim:realtime -- --config <cfg>`); the
coordinator spawns one capped container per agent. Afterwards, sweep any survivors:

```bash
infra/docker-agent/reap.sh
```

`run-agent.sh` has two modes:

- **image (default)** — the baked `eris-agent:local` image. The coordinator's absolute host paths
  are remapped onto the image's `/eris`; the config file and `runs/` dir are mounted in.
- **bind-mount** (`ERIS_AGENT_BINDMOUNT=1`) — stock `node:24` with the repo bind-mounted at its own
  host path. No build; handy for iterating on runtime code on the same host.

Override `ERIS_AGENT_IMAGE`, `ERIS_DOCKER_MEM` (default `1g`), `ERIS_DOCKER_CPUS` (default `0.5`).

## Env contract (two silent traps)

`run-agent.sh` forwards the coordinator-injected env by name. Two are easy to lose:

- **`ERIS_AGENT_DIR`** — a `command` override skips the directory-convention path that would set it,
  so declare it in the agent's roster `env:`.
- **`ERIS_LOCAL_DEPLOY`** — comes from the operator's *process* env. Without it,
  `sdk/src/constants.ts` ignores `constants.local` and Multicall3 plus every venue/token address
  fall back to the fork chain, so every read and every tx build fails — while `docker stats` still
  looks healthy (the agent simply never trades).

## Scale

100 containers ran on a 16-core / 187 GB host at a 4 s block time **on budget** (150 blocks in
597 s ≈ 3.98 s/block, no lag; ~19 GB host memory, loadavg well under 16). Memory and CPU are not the
limit at 100; the scaling limit above that (or at a 2 s block) is single-endpoint RPC serialisation,
addressed by the parallel oracle writes in this PR and by a longer block time.

## Reaper

`run-agent.sh` removes its container on catchable signals, but the coordinator may SIGKILL the
wrapper at run end (uncatchable), leaving a detached `--rm` container. `reap.sh` sweeps survivors by
the `eris-` name prefix; run it after a sim.
