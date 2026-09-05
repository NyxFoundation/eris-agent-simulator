[← Index](README.md) | [← 07 Configuration](07-configuration.md) | [09 Dashboard →](09-dashboard.md)

# 08. Artifacts (the data contract)

Sources: `core/src/logger.ts` (writing), `core/src/realtime/{reconstruct,marketSeries,liveScoring}.ts` (contents), `core/src/manifest.ts`, `core/src/segments.ts`, `core/src/backtest/standings.ts`.

## 8.1 Layout

```
runs/
  <runId>/                          one run (runId is an ISO timestamp)
    summary.json                    aggregates and scores
    events.jsonl                    every event, in order
    blocks.csv                      per-transaction records
    market.json                     venue-state series (reporting only)
    manifest.json                   the environment manifest
    epochs.jsonl                    epoch boundaries (live scoring; appended)
    market.jsonl                    venue state (live samples; appended)
    agents/<id>.jsonl               the agent's self-reported log
    agents/<id>.llm.jsonl           raw revision exchanges (opt-in)

  <competitionId>/                  a segmented run (run.segmentHours > 0)
    matrix.json                     the segment index
    <date>-s<NN>/                    each segment = an ordinary run directory

  matrix-<id>/                      a scenario matrix
    matrix.json                     raw scores, scenario × agent
    standings.json                  the ranking (a derivative)
    <one run directory per scenario>
```

**A segment and a scenario are both "an ordinary run directory"**, readable by every existing tool. The index file is called `matrix.json` in both cases too, so the dashboard reads them with the same code.

## 8.2 `summary.json`

| Field | Contents |
|---|---|
| `runId` | Run identifier |
| `mode` | `"realtime"` / `"backtest"` (which entry point produced it) |
| `resetUnit` | `"continuous"` / `"scenario"` ([02 §2.4](02-runtime.md)) |
| `blockTimeSec` / `blocksProcessed` / `elapsedMs` | Measured execution |
| `finalFairPriceUsdcPerWeth` | The final fair price |
| `valueSeries` | Value-series metadata (below) |
| `epochScores[<id>]` | Per-agent scoring results (below) |
| `violations` | Post-hoc rule violations |
| `agents[]` | Per-agent aggregates (below) |
| `segment` / `fromBlock` / `toBlock` | Segmented runs only |

### `agents[]`

| Field | Contents |
|---|---|
| `id` / `address` | |
| `initialValueUsdc` / `finalValueUsdc` | Total value at start / end (including venue positions) |
| `netPnlUsdc` | `finalValueUsdc − initialValueUsdc` |
| `alphaUsdc` | PnL with β removed (**look here for skill**). Absent when no reconstruction ran |
| `markedValueUsdc` | The **face mark**, present only for agents whose mark sat above the scored value. Scoring is at recoverable value (issue #40 axiom 3), so this is the number that was not used |
| `processExitedEarly` | Why the process went away before the run ended. **The scenario matrix reads this to disqualify** |
| `includedTxCount` / `revertCount` | Transactions included / of those, reverted |
| `stderrTail` | Tail of the agent process's stderr (crash diagnosis) |

**Both ends are priced at the same marks** (the final block's fair prices and stable prices). `netPnlUsdc` is a difference, and pricing the two ends off different marks would book a peg's whole history as this agent's PnL.

### `valueSeries`

| Field | Contents |
|---|---|
| `source` | `"post-run-reconstruction"` / `"live-epoch-boundaries"` / `"live-observation"` |
| `granularityBlocks` / `fromBlock` / `toBlock` / `blocks` / `windowBlocks` | The read window |
| `failedReads` / `failedReadTargets` | How many cross-sections failed, and **which contract and function** |
| `alphaRefFairUsdcPerWeth` / `alphaByAgent` | The fixed α reference and the values |
| `markedValueByAgent` | The face mark, only for agents where it diverged from the scored value |
| `unpricedHoldings` | Holdings that could not be priced, could not be read, cannot be realized, or fell back to par ([06 §6.2](06-scoring.md)) |
| `epochSeries` | **The boundary values every score is computed from** (below) |
| `epochSeriesMeta` | Live scoring metadata (`boundaries` / `failedBoundaries` / `epochBlocks` / `markMedianBlocks`) |
| `markMedian` | G7 results (`windowBlocks` / `boundaries` / `surfaces` / `maxDeviationBps`) |
| `failed` / `error` | When reconstruction failed |

`epochSeries`:

```json
{ "epochBlocks": 12, "epochs": 29,
  "boundaryBlocks": [1001, 1013, ...],
  "valuesByAgent": { "venue-arb": [25000.0, 25003.4, null, ...] } }
```

**`null` means "this agent did not report at this boundary", not zero.**

**Where both series exist, the live one is authoritative**, so `summary.json`'s rounds and its scores are the same object. On a run that also swept, `valueSeries.source` stays the sweep's and the live metadata is **nested** under `epochSeriesMeta` — spreading it would rename the sweep's own artifact and make a run that did sweep claim it had not.

### `epochScores[<id>]`

| Field | Contents |
|---|---|
| `score` | `mean − λ·std` |
| `meanLogReturn` / `stdLogReturn` | The two terms |
| `logReturns` | The E returns actually scored (floored, frozen and carried) |
| `bankruptAtEpoch` | The 1-based epoch that first touched the floor, or `null` |
| `carriedForwardEpochs` | Epochs whose value was missing (**the environment's failure, not the agent's**, so it is stated) |
| `floorUsdc` / `lambda` | The parameters applied |
| `benchmarkApplied` | **False means raw returns.** They must not be read as excess |

## 8.3 `events.jsonl`

One event per line, each carrying an ISO `ts`. The catalogue below is what the coordinator emits (including from venue modules).

### Run lifecycle

| type | Contents |
|---|---|
| `run_started_realtime` | Start of the run. **Carries seed / flowSeed / epochBlocks / rpcUrl / chainId / chainMode.** Repeated at the head of each segment |
| `run_completed` | Completion |
| `deployment_check` | Measured deployment (chainId / checked / missing) |
| `agents_registered` | The whole roster (id / address / baseline / description / external) |
| `agent_external_registered` | An external registration the environment did not start |
| `agent_process_exited` | An agent process ending early |
| `initial_endowment` | Each agent's opening value and the max/min ratio |
| `price_feed_deployed` / `flash_arb_deployed` | |
| `interval_mining_started` / `fork_reset_skipped` / `prewarm_completed` | |
| `external_chain_block_time` / `external_chain_mint_guard` / `treasury_funded_roles` | External mode |
| `economic_gas_enabled` / `fee_cap_enforcement_disabled` | The economicGas profile |
| `realtime_block_error` | An exception during block processing (the loop continues) |
| `round_timing` | Milliseconds per stage (`keeperMs` / `oracleMs` / `stateFlowMs` / `epochMs` / `blocksMs` / `totalMs`, …) |

### Scoring

| type | Contents |
|---|---|
| `epoch_boundary` | A boundary's values (the same content as `epochs.jsonl`) |
| `epoch_boundary_failed` | A boundary that could not be read |
| `epoch_series_scored` | Scoring metadata |
| `epoch_series_agreement` | **The live/sweep agreement check** (`compared` / `maxAbsDiffUsdc` / `maxRelDiff` / `worst`) |
| `value_series_reconstructed` / `value_series_reconstruction_failed` | The post-run sweep |
| `post_run_sweep_skipped` | The window exceeded the node's retention, so the sweep was **explicitly skipped** |
| `market_series_reconstructed` / `market_series_reconstruction_failed` | market.json |
| `rule_violations_detected` | Post-hoc rule checks |

### Stress and venues

The list in [04 §4.10](04-stress-events.md), plus:

| type | Contents |
|---|---|
| `lst_block` | Per-block LST state (redemption rate / market price / discount / reward reserve) |
| `liquity_block` | Per-block Liquity state (peg / TCR / fees / lowest ICR) |
| `lst_setup` / `liquity_setup` | Startup validation results |
| `no_arb_startup` / `no_arb_persistent_warning` | The no-arbitrage checks |
| `keeper_failed` / `oracle_update_failed` / `lst_accrual_failed` / `liquity_watch_failed` / `vuln_watch_failed` / `vuln_fund_failed` | Per-task failures |
| `tx_submitted` / `tx_submit_failed` | Transactions the environment sent |

**Because `lst_block` and `liquity_block` are emitted every block, the dashboard reconstructs those venues' state from them** rather than a second time from market.json — which also means older runs still render.

## 8.4 `blocks.csv`

The columns are owned by `BLOCKS_CSV_COLUMNS` (`core/src/logger.ts:8`).

| Column | Contents |
|---|---|
| `round` | The block number (same as `blockNumber`) |
| `blockNumber` | |
| `txIndex` | Position in the block. **0 is first** |
| `hash` / `from` | |
| `priorityFeeWei` | **From the on-chain transaction field**, not self-reported — which is what makes the post-hoc check meaningful |
| `status` | `success` or otherwise (`mined` when the receipt could not be fetched) |
| `ownerId` / `role` | Attribution (`agent` / `uninformed-flow` / `informed-flow` / `system`) |
| `actionType` | **Exists only for transactions the environment sent** (the sender's intent). An agent's transactions read `direct` |
| `bundleId` / `bundleIndex` | Bundles |
| `method` | **The function name decoded from calldata** (`sdk/src/methodSelectors.ts`) |

**Why `method` exists beside `actionType`** (ADR 0021 §4): `actionType` only exists for environment transactions. Joining against agents' self-reported logs works only while the coordinator is the thing starting the agents, so every external participant's transaction reads `direct` — **the least information exactly where the traffic is heaviest**. Calldata decoding works for every transaction.

Attribution is primarily a lookup on the `from` address; `submittedByHash` only fills in `actionType` and fee for transactions the environment sent.

Write timing:

- Ordinary run: one bulk scan at the end. **If it crashes midway, blocks.csv is empty** (diagnose from events.jsonl)
- Segmented run: catches up to `bn−1` every block. A single pass at the end works only for a run that has an end, and on a period without one **every segment's blocks.csv ends up empty** (observed)

## 8.5 `market.json` (reporting only)

**Never an input to scoring.** Built from historical reads after the run, so it costs the live loop nothing.

| Field | Contents |
|---|---|
| `source` / `fromBlock` / `toBlock` / `granularityBlocks` / `rows` | Metadata |
| `failedReads` / `failedReadTargets` / `elapsedMs` | |
| `bases` / `venues` | |
| `series[]` | Below |
| `gmxPositionsAtEnd` / `aaveAccountsAtEnd` / `lstPositionsAtEnd` / `liquityPositionsAtEnd` | **Position cross-sections at the run's final block** |
| `notionals` | tx hash → decoded USD notional |
| `notionalsMeta` | `txsSeen` / `decoded` / `receiptFailures` / `unknownTokenTransfers` |

One row of `series[]`:

| Field | Contents |
|---|---|
| `block` | |
| `fair` | base → USD (the on-chain PriceFeed answer) |
| `venues` | venue → base → `{mid, buy, sell, depthUsd}` |
| `gmx` | base → `{longOiUsd, shortOiUsd, fundingPerHourBps?}`. **Omitted on a failed read** (a failure must not print as 0.00bps) |
| `aave` | asset → `{suppliedUsd, borrowedUsd, utilization}` |
| `stables` | symbol → `{priceUsdc, sellPriceUsdc, buyPriceUsdc, quoted}` |

**`stables[].quoted: false` means the pool refused to quote and the price is par by fallback** — the one number here that must never be read as "the peg held".

**Why every venue's positions are captured**: only GMX used to be, so an agent that spent the run staking or borrowing produced an empty table indistinguishable from a broken one.

## 8.6 `agents/<id>.jsonl`

Written by the agent itself. Two kinds of line share the file.

| Kind | Contents |
|---|---|
| Decision log (`ctx.log`) | `round` / `action` / `reason` / `signals` / `sizing` / `expectedPnlUsdc` / `state` |
| Mempool activity (`kind: "mempool"`, appended by send.ts) | `event: submitted` / `submit_failed` / `rejected` / `bad_action` / `approval_failed` / `approvals_granted` / `runtime_start` |

**Why the self-report**: with direct sending, the coordinator cannot count transactions submitted but never included (ADR 0006 §5).

A self-improving agent's revision outcomes land here as `reason: "revision <kind>"` plus `state`. The raw exchange goes to `agents/<id>.llm.jsonl` under `ERIS_IMPROVE_LOG_CALLS=1` (off by default — it holds every generated strategy in full).

**An external participant's decision log exists only on their machine.**

## 8.7 `epochs.jsonl` / `market.jsonl` (live append)

Kept out of `events.jsonl` deliberately. **Being tailable on their own is what makes live standings possible without reading a week of events** (ADR 0021 §3).

One line of `epochs.jsonl` is `{index, blockNumber, fairPriceUsdcPerWeth, values: {agentId: number|null}, elapsedMs}`.

`market.jsonl` holds the same row shape as `market.json`'s `series[]`, sampled at boundaries rather than every block — a week of per-block venue rows is a file nobody can open.

## 8.8 `manifest.json` (the environment manifest)

The only document handed to self-hosted participants (ADR 0021 §2). Built by `buildManifest` (`core/src/manifest.ts:109`).

| Section | Contents |
|---|---|
| `schema` / `generatedAt` | `eris-environment-manifest/1` |
| `status` | `{scored: false, label: "practice", note}` — **stated in the document so a ranking's provenance does not travel separately from the ranking** |
| `chain` | `rpcUrl` / `readRpcUrl` / `chainId` / `chainMode` / `blockTimeSec` |
| `round` | `epochBlocks` / `approxSeconds` / `markMedianBlocks` / `scoreEvery` (**both blocks and minutes**) |
| `protocols` / `actions` | The enabled venues and their action vocabulary |
| `contracts` | **Only the enabled venues' addresses**, plus `priceFeed` and `stableMarkets` |
| `tokens` | symbol → `{address, decimals, kind}` |
| `limits` / `funding` | Caps and endowments |
| `episodes` | **Kinds and counts only** (`{type, count}[]`) |
| `participants` | id / address / external / baseline / description |

**Two rules shape it** (`manifest.ts:9-19`):

1. **Nothing secret.** The coordinator writes it into the run directory and the dashboard serves that directory over HTTP; a key in here is a published key. Individual keys go to **stdout only**, via `npm run manifest -- --participant <id>`
2. **No stress timings.** Kinds and counts are published; when a window opens is not. It is **built from the config's event list rather than from the resolved schedule**, so a future field on the schedule cannot leak into it

## 8.9 `matrix.json` / `standings.json`

### A scenario matrix (`npm run backtest -- --scenarios`)

`matrix.json` holds the **raw scores under all four metrics** per scenario and agent, plus the two cross-sections they are differences of (`initialValueUsdc` / `finalValueUsdc`). The cross-sections are there because **run directories do not survive**: of the 30 runs in one sweep, 5 had already lost theirs, and with only differences stored there was no way to recompute under a changed rule.

`runDir` is **relative**, so a tarball collected from a remote box unpacks and reads as-is.

`standings.json` is **a derivative**: `computeStandings` recomputes it from `matrix.json`. The ranking rule is expected to change (ADR 0017 §4).

| `standings.json` | Contents |
|---|---|
| `metric` | Which metric ranked it |
| `agents[]` | `id` / `total` / `byRegime` / `scenariosScored` / `disqualifications` |
| `regimes` | Regime order (the order the matrix ran) |
| `scenarios[]` | Per scenario: `scores` / `z` / `disqualified` |
| `excludedScenarios[]` | **Scenarios with no summary** — an environment failure, not charged to participants |

### The segment index (`core/src/segments.ts`)

A segmented run writes the same `matrix.json`. Its entries are **standings-shaped**, so the dashboard reads them with the code it already has.

| Field | Contents |
|---|---|
| `schema` / `createdAt` / `scenarioSet` | |
| `resetUnit` | **Honestly `"continuous"`** — these are cuts of one world, not separate ones |
| `segmentHours` / `scenariosPlanned` | |
| `scenarios[]` | `{regime: "segment", seed: <number>, label: <date>, runDir, fromBlock, toBlock, startedAt, endedAt, agents[]}` |

A segment's `alphaUsdc` is reported **as 0** (α needs the fixed-reference sweep, which a segment of a continuous chain does not get). Zero rather than absent, because the standings read that field.

The index is **rewritten whole on every change** rather than appended: a half-written list of days is worse than a list that is one day behind.

## 8.10 Artifact size

Measured on a 400-block run with five venues and three agents:

| File | Per block |
|---|---|
| `events.jsonl` | ~1,437 B |
| `blocks.csv` | ~731 B |

A week unsegmented is a 435MB `events.jsonl`, a 221MB `blocks.csv`, and 336 rounds in a single bar. **An unsegmented run past 20,000 blocks (≈11 hours at a 2 s cadence) warns at startup** ([02 §2.1](02-runtime.md)).
