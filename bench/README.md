# bench — ASCON load-test suite

Runs the realtime sim with N agents each in a memory/CPU-capped Docker container (reusing
`infra/docker-agent`), samples host + per-container resources, and summarises them. This used to live
outside the repo (`~/ascon-bench` on the box); it now lives here so it is versioned and CI-runnable.

## Run locally

```bash
bench/run.sh --agents 12 --blocks 200 --block-time 2 --mode frozen
# -> bench/results/<ts>/{stats.csv, run.log, summary.txt, summary.md}
```

Options: `--agents N`, `--blocks B`, `--block-time S`, `--mode frozen|llm` (llm drives the improve
loop against Ollama Cloud — needs `OLLAMA_API_KEY`), `--mem 1g`, `--out DIR`. `ANVIL_PORT` (default
8545) isolates the chain — set a dedicated port when a monitoring/production anvil is already running.

`--markets N` (issue #40) puts N agent-created-market participants in the field instead of N
venue-arb clones, cycling through the four reference roles, with the registry and the permissionless
lending singleton on. It is a different load: the AMM roster never touches the per-block discovery
sweep, the registry write, or the registry read every agent does every block, and those are what
this capability added to the loop.

```bash
ANVIL_PORT=8555 bench/run.sh --markets 32 --blocks 200 --block-time 2
```

Container cleanup matches `--label eris.role=agent`, not the `eris-` name prefix — that prefix also
matches `eris-explorer-*`, so a bench reset used to take the local Blockscout stack down with it.

## Layout

| path | role |
|---|---|
| `run.sh` | orchestrator + CI entrypoint (reset → config → sim → sample → aggregate → summary.md) |
| `lib/reset-chain.sh` | fresh anvil with all venues (`backtest/state/venues-state.json`), isolated by port |
| `lib/mkconfig.py` | roster generator: N agents via `infra/docker-agent/run-agent.sh`, official protocols |
| `lib/sampler.py` | `docker stats` sampler → CSV |
| `lib/agg.py` | per-container + fleet peak/mean mem/cpu; `--md` for a PR comment |
| `results/` | run outputs (gitignored) |

The container execution itself is `infra/docker-agent/run-agent.sh` (bind-mount mode by default here,
so no per-team image build is needed for a bench).

## CI

`.github/workflows/bench.yml` runs this on a **self-hosted runner** (needs Docker + real cores, which
GitHub-hosted runners don't have) and comments `summary.md` on the PR. See that file for the runner
label + secrets it expects.

## Measured baseline (see `docs/22` in the ASCON docs)

frozen and Ollama-improve both ~168 MiB/agent (inference is off-container); 100 agents ran on a
16-core/187 GB host on-budget at a 4 s block. The bench is how those numbers are reproduced.
