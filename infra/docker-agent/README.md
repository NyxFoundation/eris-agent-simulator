# infra/docker-agent — run each agent in a resource-capped container

Operator-hosted, isolated per-team execution (the autonomous-container form). The coordinator sets
up the chain, funds each wallet and drives the run unchanged; only the agent process is relocated
into a memory/CPU-capped Docker container. Per-container `docker stats` then gives a fair, isolated
resource reading per team.

## How it plugs in

Point each competing agent's `command` at `run-agent.sh` and pass its directory via `env`:

```yaml
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true            # a host-run yardstick; not containerised
  - id: team-alice
    dir: team-alice
    wallet: AUTO
    command: infra/docker-agent/run-agent.sh
    env: { ERIS_AGENT_DIR: "/abs/path/eris-agent-simulator/example/agents/team-alice" }
```

Run the environment as usual (`ERIS_LOCAL_DEPLOY=1 npm run sim:realtime -- --config <cfg>`); the
coordinator spawns one capped container per agent. After the run, sweep any survivors:

```bash
infra/docker-agent/reap.sh
```

## Resource caps

`--memory` / `--memory-swap` (equal, so swap is disabled and the limit is a hard ceiling) and
`--cpus`, overridable via `ERIS_DOCKER_MEM` (default `1g`) and `ERIS_DOCKER_CPUS` (default `0.5`).

Measured footprint of a reference agent (`venue-arb`):

| | mem peak / container | notes |
|---|---|---|
| coded strategy (frozen) | ~168 MiB | — |
| + LLM improve loop (Ollama) | ~168 MiB | **same** — inference runs off-container via the provider |
| 99 containers, 4 s block, 1 GiB cap | ~136 MiB | V8 sizes its heap to the cgroup, so RSS drops |

100 containers ran on a 16-core / 187 GB host at a 4 s block time **on budget** (150 blocks in
597 s ≈ 3.98 s/block, no lag; ~19 GB host memory, loadavg well under 16). Memory and CPU are not
the limit at 100; the scaling limit above that (or at a 2 s block) is single-endpoint RPC
serialisation, addressed by the parallel oracle writes in this PR and by a longer block time.

## Env contract (two silent traps)

`run-agent.sh` forwards the coordinator-injected env by name. Two are easy to lose:

- **`ERIS_AGENT_DIR`** — a `command` override skips the directory-convention path that would set it,
  so declare it in the agent's roster `env:`.
- **`ERIS_LOCAL_DEPLOY`** — comes from the operator's *process* env. Without it,
  `sdk/src/constants.ts` ignores `constants.local` and Multicall3 plus every venue/token address
  fall back to the fork chain, so every read and every tx build fails — while `docker stats` still
  looks healthy (the agent simply never trades).

## Image

Defaults to stock `node:24-bookworm-slim` with the repo bind-mounted; the repo's `tsx`/`esbuild` is
statically linked, so no build is needed and all agents share one eris checkout (each team's code is
a subdirectory under `example/agents/`). For fully isolated per-team code, bake a per-team image and
set `ERIS_AGENT_IMAGE`; the env contract is unchanged.
