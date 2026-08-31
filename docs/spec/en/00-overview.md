[← Index](README.md)

# 00. Overview and scope

## 0.1 Definition

**Eris Agent Simulator** is a simulator in which several autonomous agents compete inside one shared mempool on a chain that has every DeFi protocol deployed on it, and are scored on a risk-adjusted measure of the result.

It has three parts.

| | Responsibility |
|---|---|
| **The environment** | Chain lifecycle, fair-price generation and distribution, orderflow, the keeper, stress events |
| **The agents** | Observe finalized state → decide → sign and send. Independent OS processes |
| **Scoring** | Read a value cross-section at each epoch boundary, and compute a score from it |

The environment and the scorer live in one process (the coordinator), but **the agents meet them nowhere except on the chain**.

## 0.2 Scope

### In

- Seven on-chain venues (Uniswap V3 / Balancer v2 / Curve / Aave v3 / GMX v2 / an LST vault / a Liquity V1 fork)
- Seed-deterministic fair-price generation, and its propagation to every venue
- Nine kinds of stress event (price gaps, whales, thinning books, depegs, slashes, drift and flow episodes)
- The agent runtime (three contracts: rule, self-driven, self-improving)
- Risk-adjusted scoring per epoch, and aggregation over a scenario matrix
- Run artifacts (`runs/<id>/`) and a web UI that renders them
- Practice-devnet operation (registering external participants, the environment manifest, daily segments)

### Out

- **Running the competition itself.** Submission, judging and prizes belong to the [competition rules](../../competition-rules.md); this system provides only the execution substrate
- **Any claim of correspondence to a real market.** The oracles are mocks and the fair price is a synthetic path ([README, Disclaimer](../../../README.md))
- **Agent strategy.** `example/agents/` is reference material, not specification
- **The chain client.** Either anvil or an external OP Stack devnet is assumed

## 0.3 Execution modes

One coordinator (`core/src/realtime/coordinator.ts:390`, `runRealtimeSimulation`) is reached from four entry points.

| Mode | Entry point | Worlds | `resetUnit` |
|---|---|---|---|
| Realtime run | `npm run sim:realtime` | 1 (start to finish) | `continuous` |
| One scenario replayed | `npm run backtest -- --regime <name> --seed <N>` | 1 | `continuous` |
| **Scenario matrix** | `npm run backtest -- --scenarios <path>` | one per (regime, seed) | **`scenario`** |
| Practice devnet | `npm run sim:realtime` with `chainMode: external` | 1 (a chain that never stops; only the output is cut into days) | `continuous` |

**Only the scenario-matrix runner may declare `resetUnit: scenario`.** Writing it in a config file and launching `sim:realtime` fails fast (`coordinator.ts:405`), because one world labelled as many is a stored run whose lie cannot be detected afterwards.

## 0.4 Core concepts and the flow of data

```
                 seed
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
   fair-price path    stress schedule
   (OU process)       (where the windows fall)
        │                    │
        └────────┬───────────┘
                 ▼
        effective price ──► PriceFeed / every venue's oracle
                 │                    │
                 │                    ▼ (one block late)
                 │            ┌──────────────┐
                 └──flow bot─►│    chain     │◄── agent txs (signed and sent directly)
                              │  one mempool │
                              │ --order fees │
                              └──────┬───────┘
                                     │ finalized blocks
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              observation      epoch-boundary     blocks.csv /
          (agents rebuild it)  cross-sections     events.jsonl
                                     │
                                     ▼
                            score = mean − λ·std
```

| Concept | Definition | Source |
|---|---|---|
| **run** | One execution. Produces one `runs/<runId>/` (several when segmenting) | `coordinator.ts:491` |
| **block** | The environment's smallest unit of time. 2 s by default (`run.blockTimeSec`) | `sdk/src/config.ts:351` |
| **epoch (round)** | The scoring unit. 12 blocks by default (`run.epochBlocks`), or stated in real time (`run.epochSeconds`) | `sdk/src/config.ts:590` |
| **scenario** | A (regime, seed) pair — one replay of a market | ADR 0017 §1 |
| **regime** | A kind of market condition. `config/regimes/<name>.yaml` holds the rules for price, flow and events | `config/regimes/` |
| **fair price** | The reference price the environment generates and publishes to everyone through the PriceFeed | `core/src/realtime/priceFeed.ts` |
| **observation** | The only input an agent gets, rebuilt from finalized state | `sdk/src/types.ts:634` |
| **action** | A trading intent an agent returns. 25 leaves plus 4 control forms | `sdk/src/types.ts:332` |
| **benchmark** | The roster's `baseline: true` entry. Every score is excess over it | `core/src/scoring/epochScore.ts:36` |
| **venue** | One protocol implementation, represented by the adapter at `sdk/src/protocols/<id>.ts` | `sdk/src/protocols/registry.ts` |

## 0.5 Design principles

Six of them run through the whole implementation. Every later chapter is one of these made concrete.

### P1. The environment and the agents meet nowhere but the chain

An agent is handed an RPC URL, its own private key, the PriceFeed address and a run directory — and **never another participant's key, pending transactions, or the txpool** (`core/src/realtime/agentProcess.ts:40-63`). Front-running by watching the mempool is structurally impossible, and everyone competes on the same information in the same mempool. → [01](01-architecture.md)

### P2. Observations are of finalized state, and information is one block late

The fair price is written on-chain, and that write lands in the next block. **Everyone is therefore delayed by exactly one block** (`docs/guide/architecture.md:49`). This is the design rather than a limitation, and it is where the two-block liquidation lag comes from (one block of observation delay plus one of mempool).

### P3. A seed labels the market conditions; it does not reproduce the result

The price path and the event windows are pure functions of the seed. **Transaction timing and in-block order are not**, so the same seed produces different results (ADR 0005). Comparing single runs is meaningless; comparison needs samples.

### P4. Nothing fails quietly

A broken calibration, an event pointing at a venue that is not enabled, a key collision, a missing deployment: all fail at startup. A cross-section that could not be read is left `null` rather than filled with zero, and a holding that could not be priced is reported in `unpricedHoldings`. → [11](11-invariants.md)

### P5. Store everything a score is derived from; the score is a derivative

`summary.json` holds not only the score but the epoch series it was computed from. `npm run metrics` rescores a finished run under another metric without re-running it. Standings are likewise derived from `matrix.json`, and the scoring rule is expected to change (ADR 0017 §4). → [06](06-scoring.md)

### P6. One YAML for configuration; env holds only secrets

Run knobs and the roster live in `config/local.yaml`. What remains in env is **secrets (keys, RPC, API keys), agent IPC, and which config file to read** — three categories, nothing else (`sdk/src/runConfig.ts:21`). A retired config env variable that is still set produces a warning (`core/src/runConfig.ts:110`). → [07](07-configuration.md)

## 0.6 Glossary

| Term | Meaning |
|---|---|
| coordinator | The environment daemon and scorer. `core/src/realtime/coordinator.ts` |
| adapter | A protocol adapter; one per venue. `sdk/src/protocols/*.ts` |
| roster | The list of agents entered in this run (`agents:` in the config) |
| flow bot | The environment's market mechanism: an independent process that generates orders and moves the market |
| keeper | The GMX order executor, driven by the coordinator every block |
| victim | A position the environment opens so liquidations can happen. Not scored |
| overlay | A multiplicative distortion of the fair price from a stress event. It never touches the base path |
| base / stable / lst | Token kinds. Valuation takes three different routes (`sdk/src/types.ts:13`) |
| α (alphaUsdc) | PnL with β removed, measured against the fair price at fill time |
| β | The part of PnL that comes from price drift — what moves whether or not you trade |
| M9 | The current competition score, `mean − λ·std` (ADR 0019) |
| G1 / G2 | The bankruptcy floor (1% of initial capital) and the freezing of the series after it |
| segment | A time-sliced unit of output on a chain that never stops. The chain stays continuous |
| external agent | A registered agent the participant runs on their own machine; the environment never starts it |

## 0.7 What this specification leaves to the code

The following are not covered here; the code and its immediate neighbours are the source.

- Venue internals (the Liquity V1 core is an **unmodified fork**, and its specification is upstream's)
- `deployer/` procedure detail → `deployer/README.md`, referenced from [10 Operations](10-operations.md)
- The logic of each reference agent (`example/agents/<id>/agent.ts`)
- Calibration measurements → [`docs/scoring-metric-measurements.md`](../../scoring-metric-measurements.md)
