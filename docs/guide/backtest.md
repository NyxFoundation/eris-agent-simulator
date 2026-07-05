[← README](../../README.md)

# Backtest (regime replay, ADR 0016)

A mode for participants to validate their own strategy "cheaply and repeatedly, under conditions equivalent to historical market data." On top of a **dedicated local anvil** loaded with the distributed venue state dump, the existing coordinator replays an official regime (`config/regimes/*.yaml` + seed) as-is. Fills are computed by the real contracts (no fill model), and scoring is fully identical to realtime (the `summary.json` format is the same except for `mode: "backtest"`). No fork and no external RPC required.

```bash
npm run backtest -- --regime calm-01                       # normal market
npm run backtest -- --regime crash-01                      # crash + victim + Aave liquidation
npm run backtest -- --regime calm-01 --repeat 5            # 5× the same regime (see the distribution)
npm run backtest -- --regime calm-01 --agents my-roster.yaml   # swap the roster
```

## Prerequisites

| thing | how to get it |
|---|---|
| anvil binary | one-shot `foundryup` |
| state dump (`backtest/state/`) | drop in the operators' distribution. To build your own, run `npm run gen:state-dump` against an anvil already deployed by the deployer (see below) |

`gen:state-dump` reverts a running deployer anvil ([local deploy](local-deploy.md)) to the clean cross-section at `.local-snapshot`, dumps state, and writes out a `venues-state.json` that can be passed straight to `--load-state` plus a manifest (source commit, anvil version, genesis hash, the entire deployments.json bundled + a fingerprint). `sdk/src/constants.local.ts` is also regenerated from the same deployments.

## Regime = a label for market conditions

A regime is **a YAML in the existing config schema + a seed** (same format as [Configuration](configuration.md)). The fair-price OU path, flow orders, and stress event schedule are all deterministically replayed from the seed.

- `config/regimes/calm-01.yaml` — normal market (no stress)
- `config/regimes/crash-01.yaml` — trapezoidal crash (range-specified) + 2 liquidation-target victims + a liquidator roster slot

`blockTimeSec` is part of the regime (fixed to the same value as production). Short-circuit overrides like `--blocks` / `--seconds` are for behavior checks and smoke tests only; **runs whose scores you read should use the regime defaults** (ADR 0016 §3). The seed of a public regime is just one sample from the range, and a production run's seed is a different sample (anti-overfitting).

## Repetition and reproducibility

- **The environment (initial state + market conditions) is perfectly identical every time**: each launch builds a fresh anvil from the same state dump, and between the runs of `--repeat N` it returns to the clean cross-section via `evm_snapshot`/`evm_revert` (no victim leftovers).
- **The only thing that varies is tx ordering** (same property as production realtime, ADR 0005). Results converge into a narrow band but are not bit-identical. Read the ranking from the mean alphaUsdc over `--repeat N`.
- Bit-identical regression comparison (diff-checking a single line of code) is planned but unimplemented as B2 synchronous-step replay (ADR 0016 §3).

## Sparring (compete against other agents)

Line up multiple agents in the roster and they compete in the same run, on the same mempool. `--agents` swaps the regime's default roster (YAML/JSON; the content is baked into the effective regime):

```yaml
# my-roster.yaml
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true
  - id: my-strategy          # your strategy (example/agents/my-strategy/)
    wallet: AGENT2_PRIVATE_KEY
  - id: multi-arb            # rival: bundled strategy
    wallet: AGENT3_PRIVATE_KEY
  - id: multi-arb-2          # multiple instances of the same strategy (see them eat each other's opportunities)
    dir: multi-arb
    wallet: AUTO
```

## What you can / cannot measure (ADR 0016 §8)

| measurable | not measurable (realtime / production only) |
|---|---|
| Correctness and regression of strategy logic (crashes / validate violations / repeated noop) | Competition against real production participants (roster only goes as far as sparring against known strategies) |
| Per-regime α tendency including your own fills' market impact | Behavior at production roster density |
| Prompt behavior, self-revision tendency, and the full tx path (signing, revert) | Score at the production seed (same regime, but a different seed sample) |

## CLI reference

| flag | description |
|---|---|
| `--regime <name\|path>` | `config/regimes/<name>.yaml` (or a YAML path). Required |
| `--agents <roster>` | Swap the regime's default agents with a roster file (YAML/JSON) |
| `--repeat <N>` | Repeat the same regime N times (default 1). Prints the mean alphaUsdc when done |
| `--port <N>` | Port for the backtest-dedicated anvil (default 8547; use a different port for parallel runs) |
| `--state <dir>` | State dump directory (default `backtest/state`) |
| `--keep-anvil` | Keep anvil alive after exit (for reading receipts in post-hoc analysis / debugging) |
| `--seed` / `--blocks` / `--seconds` / `--protocols` / `--economic-gas` | One-shot override of regime values (for smoke tests) |

> Run overrides are written out as an "effective regime YAML" that both the coordinator and the agent processes read, so they read the same settings (applying it only to the coordinator would kill the agents on observation).

## Troubleshooting

- **`state manifest not found`** — Drop the distribution into `backtest/state/`, or generate it with `npm run gen:state-dump`.
- **`state dump is missing a venue: gmx`** — The deployment used to generate the dump had no GMX. Re-bake from a full deploy (`cd deployer && npm run deploy -- --keep-fresh`), or narrow it down with `--protocols uniswap,balancer,curve,aave`.
- **`port 8547 is in use`** — Another backtest / anvil is present. Change it with `--port` (do not use the deployer anvil's 8545).
- **Fingerprint mismatch log** — It auto-regenerates `constants.local.ts` from the deployments bundled in the manifest and continues (normal behavior). It fails fast only if regeneration still does not match (a wrong combination of state dump and repo version).
- **Warning that the source commit differs from HEAD** — Harmless if you have not changed the deployer / constants. If you have, re-bake with `npm run gen:state-dump`.
