[← Index](README.md) | [← 01 Architecture](01-architecture.md) | [03 The market →](03-market.md)

# 02. Execution model

Source: `core/src/realtime/coordinator.ts` (`runRealtimeSimulation`, L390–2761). Line numbers below refer to that file.

## 2.1 The run lifecycle

```
[A] Config and startup validation  ──► fails without ever touching the chain
[B] Chain preparation               resetFork / automine / funding / approvals
[C] Building the environment        PriceFeed / venue setup / event staging
[D] Last checks before agents start  no-arb / deployment / key collisions
[E] Agent launch
[F] The block loop                  ← the body of the run
[G] Stop and teardown
[H] Scoring and artifacts
```

### [A] Config and startup validation (L395–489)

1. `resolveRunInputs(process.argv, overrides)` resolves the config in the order **`--config` > `ERIS_CONFIG` > `config/local.yaml` > `config/example.yaml`** (→ [07](07-configuration.md)). If none exists, it throws.
2. **`resetUnit` check** (L405) — even if the config says `scenario`, it throws unless that value arrived as a programmatic override from the scenario-matrix runner.
3. **Install the chain mode** (L422) — `setChainMode` runs before anything touches the chain, so from here a cheatcode throws at the call rather than returning an RPC error something swallows.
4. In `external` mode, five conditions throw (L426–456).

   | Condition | Reason |
   |---|---|
   | No `TREASURY_PRIVATE_KEY` | Without cheatcodes, every balance has to be sent from a genesis-prefunded account |
   | `run.localDeploy: false` | An external chain runs *our* venue deployment, and localDeploy is what turns on the address overlay naming it |
   | `run.economicGas: true` | That profile finalizes prices with a storage write, which no real chain permits |
   | `stress.victimCount > 0` | Victims require fresh state per run |
   | `run.prewarmBlocks > 0` | The warmup mines its own blocks, and there is no cold fork state to warm |

5. **Segment advisory** (L457–473) — `segmentHours: 0` with `runBlocks > 20,000` (≈11 hours at a 2 s cadence) prints a warning. **Not fatal**: a deliberately long unsegmented run is legitimate, but it should not be a surprise.
6. **economicGas precondition** (L479) — `funding.ethWei < 0.5 ETH` throws (the agent would run out of gas on its first move).

### [B] Chain preparation (L491–871)

1. `runId` is an ISO timestamp. With `segmentHours > 0` a `SegmentedRun` writes the artifacts; otherwise a `RunLogger` does.
2. **`run_started_realtime`** is emitted (L506) with seed / flowSeed / epochBlocks / rpcUrl / chainId / chainMode. **This is the only place the seed is recorded** — a stored run without it cannot say which world it was.
3. Clients are created with `batch: true` (same-tick reads fold into JSON-RPC array batches / Multicall3).
4. **Reset**: `external` skips it and emits `fork_reset_skipped`; `run.skipReset` also skips; otherwise `resetFork` runs (a full re-fork, or the clean snapshot/revert cross-section locally).
5. On local deploy and not external, **automine is turned on for setup only** (L563), because the run inherits whatever mining state the deployer's anvil was left in. It goes off again when the competition starts (L1499) — with automine on, one tx is one block and the fee competition breaks.
6. **Wallet resolution**: an entry with `spec.address` has no key here (an external participant); otherwise the key comes from the `wallet` name.
7. **Flow wallets** are derived deterministically as `keccak256("flow:<seed>:<key>")` — protocol × {informed, uninformed}, N aave actors, and the whale.
8. **`EventSchedule` is built** (L629). It is a pure function of `(config, seed, runBlocks)` with no chain dependency, so it can exist before funding — which it must, because the whale's endowment size depends on it.
9. **Funding** (L797–871):

   | Target | ETH | base | stable |
   |---|---|---|---|
   | agent | `funding.ethWei` (**no gas buffer**) | `funding.wethWei` / `funding.base` | `funding.usdcUnits` |
   | flow wallet | `funding.flowEthWei` | `funding.flowWethWei` / `funding.flowBase` | same |
   | aave actor | same | `flow.aaveMaxWethWei × 6` | same |

   Agents get no gas buffer because the default buffer would ride the epoch series as **β nobody chose** (ADR 0019 §6). Flow wallets keep theirs — they are machinery, and a dry flow bot removes market activity from everyone.
   A registered address with no key is funded through `fundAddress` (it gets no approvals, since only the holder can grant them).
   Approvals are collected across venues and sent as one batch (fifteen wallets at eighteen transactions each is nine minutes of setup at a two-second block time).

### [C] Building the environment (L873–1290)

| # | Step | Note |
|---|---|---|
| 1 | Settle `initialFairPrice` | Everything below refers to it |
| 2 | Calibrate the Aave oracle (local deploy) | A storage write on anvil, a mined admin tx on external. Both land before any agent starts, so neither is front-runnable |
| 3 | Endow the whale | Size is denominated against the fair price. **Throws if the venue is not enabled** (L904) |
| 4 | Stage stress victims | Requires `aave` and fresh state (below) |
| 5 | Read each agent's opening balance, emit `initial_endowment` | Warns when max/min exceeds 2× |
| 6 | Deploy the PriceFeed → `price_feed_deployed` | The one address a participant cannot look up elsewhere |
| 7 | Deploy FlashArb (`run.flashArb` with aave+uniswap+balancer) | |
| 8 | Deploy vuln pools (ADR 0014) | Funding happens when each window opens |
| 9 | Emit `agents_registered` | id / address / baseline / external |
| 10 | **Write the environment manifest** | Holds no keys → [10](10-operations.md) |
| 11 | Prewarm (`run.prewarmBlocks > 0`) | A short flow-bot-only loop that warms anvil's working set. It does not consume the price series (separate Rng) |
| 12 | LST setup | Aligns the economic clock and verifies the rate-oracle wiring (>200bps divergence fails fast) |
| 13 | Liquity setup | Points the permanent oracle adapter at this run's PriceFeed. Opening in Recovery Mode or on a depegged pool fails fast |
| 14 | Check for deployer-key collisions | liquidityPull and depeg trade as the deployer account (below) |
| 15 | Stage depeg runtimes | |
| 16 | Stage liquidityPull | |

**Victims require fresh state** (L955): unless `!skipReset && (localDeploy || forkUrl)`, it throws. A soft reset leaves the previous run's victim positions standing and the health-factor computation breaks.

**Deployer-key collision** (L1155): `liquidityPull`, `eusdDepeg` and `depeg` all trade as the deployer account (anvil account 0). An agent bound to the same address would race it on the nonce, so the check is **by address** — comparing keys would miss a registered participant whose key the environment never sees.

### [D] Last checks (L1293–1320)

**The startup no-arbitrage check** — calibrated pools must not offer a profitable *executable* cross-venue round trip. Above `STARTUP_FAIL_BPS` it throws; above `STARTUP_WARN_BPS` it warns and hands over to the per-block monitor (→ [11](11-invariants.md)).

### [E] Agent launch (L1322–1365)

- An entry that is `external: true`, or has no key, **is not started**. `agent_external_registered` is emitted instead. Without it, "the participants never connected" and "the coordinator failed to launch them" look identical — both are an agent that made no trades.
- Launched processes get an `onExit` handler. **An agent that dies mid-run silently stops trading**, which in `summary.json` reads exactly like an agent that chose not to. It is recorded as `agent_process_exited` and `processExitedEarly`.

### [F] The block loop

→ §2.2.

### [G] Stop and teardown (L2372–2419)

The order matters.

1. **Stop the agents** (before scoring — a direct agent keeps placing orders until it is stopped)
2. Stop the flow process
3. Stop interval mining (not on external)
4. **Capture `finalBlock`** — before the teardown. Everything after it is the environment putting the world back, and scoring across it would **score the teardown**: a depeg restore buys the stable back to par, so an agent that never unwound would be marked at par
5. Restore the liquidity pull and the depegs
6. `flushBlocks(finalBlock)` — finish blocks.csv before `resetFork` erases the history

### [H] Scoring and artifacts (L2421–2746)

1. Take the **live epoch series** (`LiveScorer.series()`). When segmenting, **cut it to the current segment** — otherwise the last segment inherits the whole period's epochs and everything is counted twice
2. Score it with `scoreEpochSeriesByAgent` → `epoch_series_scored`
3. **Post-run sweep**: only when `finalBlock - runStartBlock <= 1000`. Otherwise emit `post_run_sweep_skipped` and **skip explicitly** (reading past the node's retention returns zeros, i.e. a complete-looking series with a cliff in it)
4. If the sweep ran, rebuild `market.json` too (reporting only; its failure never degrades the run)
5. **`epoch_series_agreement`** — on a run that has both, check that live and swept agree. Same reader, same blocks, same median window, so they should; a divergence means one of them is reading a different world
6. `postRunCheck` inspects fee-cap violations (empty under `economicGas`)
7. Compute final PnL → `summary.json` → `run_completed`

## 2.2 The per-block order of work

`watchBlockNumber` calls `onBlock(bn)` on every new block (L1771). The polling interval is `max(100ms, blockTimeSec × 1000 / 4)`.

**It does not re-enter** (a `processing` flag). Notifications that arrive while it is busy are dropped, so each stage works over a **range** — "from the block after the last one processed, through this one" (`fromBlock..bn`). An implementation that looks at one block swallows whole events on a dropped notification.

| # | Stage | What happens |
|---|---|---|
| 1 | Advance the price | The OU steps `baseFair`. A `cexDrift` episode changes **the walk itself** (added drift, weakened kappa, moved anchor) |
| 2 | Apply the overlay | `latestFairPrice = baseFair × overlay.wethMult`; extra bases the same way with their own Rngs |
| 3 | Fund vuln pools | Pools whose window has opened receive their reserve (cheatcode) |
| 4 | Point events | `lstSlash` / `whale`, picked up **by range**. Placed before the block's other work, so what an agent observes this block already reflects them |
| 5 | **Parallel tasks** | Table below |
| 6 | `liveScorer.onBlock(bn)` | **After** the parallel group, sequentially. It reads the block that just settled, so it cannot race anything, and it reads a cross-section only at epoch boundaries |
| 7 | `flushBlocks(bn-1)` | Segmenting only. The current block's environment txs are still in flight, hence `bn-1` |
| 8 | Segment roll check | **After the boundary read**, so a segment ending on a boundary keeps it and the next one carries it as its own boundary 0 |
| 9 | Emit `round_timing` | Milliseconds per stage |
| 10 | Termination | `runBlocks > 0 && processedBlocks >= runBlocks` ends the run |

### The parallel tasks (L2271–2290)

| Task | Sending key | When |
|---|---|---|
| `keeperTask` | keeper | Always (`adapter.afterMine`) |
| `oracleTask` (+ `accrueLstTask`) | admin | Always. The LST accrual is **sequential inside it** because it uses the same admin key — running them in parallel collides on the nonce and freezes the redemption rate |
| `stateAndFlowTask` | — | Always. `readState` for every venue → no-arb monitor → LST/Liquity block telemetry → push context to the flow bot |
| `victimTask` | — | Only with victims, and only inside a price-event window |
| `vulnTask` | — | Vuln runs only |
| `deployerKeyTask` | deployer | liquidityPull and depeg **serialized into one task**. Two of them in one `Promise.all` resolve the same pending nonce and one silently replaces the other |
| `liquityWatchTask` | — | With liquity enabled |

### Fee profiles

| Profile | oracle / PriceFeed | keeper | Cap enforced? |
|---|---|---|---|
| Default (ADR 0010) | `maxPriorityFee + 1 gwei` → txIndex 0 under `--order fees` | `maxPriorityFee + 0.5 gwei` | Yes (post-hoc) |
| `economicGas: true` (ADR 0011) | `defaultPriorityFee` (price finalization is a storage write, so the front-run target is gone) | same | **No** (free bidding) |

## 2.3 Time

| Knob | Meaning | Default |
|---|---|---|
| `run.blockTimeSec` | Block interval (seconds) | 2 |
| `run.blocks` | End after N blocks | 0 (unbounded) |
| `run.seconds` | End after N seconds | 20 |
| `run.epochBlocks` | Blocks per epoch | 12 |
| `run.epochSeconds` | Seconds per epoch, converted at `blockTimeSec` | 0 (unused) |

- **Setting both `epochSeconds` and `epochBlocks` throws** (`sdk/src/config.ts:576`). "How long is a round" gets one answer.
- **A stress run disables the time limit automatically** (L1737). With `stress.events` and `run.blocks > 0`, `run.seconds` becomes 0 so a time limit cannot expire before the crash window opens. The override is recorded as `stress_run_time_limit_disabled`.
- On external, the **real cadence is measured** and recorded as `external_chain_block_time`. A mismatch with the configured value mis-sizes every epoch.

## 2.4 The world reset unit (`run.resetUnit`)

**A label saying whether this run is one world or one of many built per (regime, seed).** It resets nothing itself — the resetting is done by `backtest --scenarios`'s snapshot/revert.

| Value | Meaning | Who may declare it |
|---|---|---|
| `continuous` (default) | One world from start to finish | Anyone |
| `scenario` | One world out of a set rebuilt per (regime, seed) | **The scenario-matrix runner only** |

- It always appears in `summary.json` and in `matrix.json`.
- `npm run metrics` **refuses a mixed set of runs**. Epochs per world differ, and λ's effective severity moves as `λ/√(epoch length)`, so a Borda over both averages two different competitions.
- Older runs without the field are read as `continuous`.
- A misspelling fails fast (`sdk/src/config.ts:42`) — falling silently back to `continuous` would make a whole matrix claim to be continuous.

## 2.5 Segments (cutting the output of a chain that never stops)

Enabled by `run.segmentHours > 0` (`core/src/segments.ts`). **The chain stays continuous; only the run directory is cut.**

- One segment is an ordinary run directory (same files, same shape), sitting under a competition directory as `<date>-s<NN>/`, indexed by `matrix.json`.
- The index's `resetUnit` is honestly `continuous`.
- **Epochs are split exactly** (`segments.ts:228`, `sliceEpochSeries`):
  - The boundary immediately *before* a segment starts is carried in as its boundary 0 (without it, every segment loses its first epoch)
  - **A segment that starts on a boundary carries nothing** (carrying would score the same epoch in two segments)
- A segment's clock starts **when the first block arrives** (`noteFirstBlock`). Setup takes minutes on a real chain, and counting it against the first segment makes day one short.
- A segment's PnL is taken **from the segment's own endpoints**, not the run's opening balances: in a continuous economy, Tuesday's PnL is what changed on Tuesday.
- Round count plateaus per segment: 30-minute rounds on 24 h segments settle at **48 rounds per segment**.

## 2.6 How failures are handled

| Failure | Handling |
|---|---|
| Calibration / config / deployment mismatch at startup | **Throws before touching the chain** (catalogued in [11](11-invariants.md)) |
| An exception during block processing | Emits `realtime_block_error`; the loop continues |
| A single task failing (keeper / oracle / liquidity / depeg / vuln / liquity watch) | Its own `*_failed` event; the run continues |
| An epoch boundary that cannot be read | **The boundary is not recorded** (never filled with `null`). Emits `epoch_boundary_failed` |
| Value-series reconstruction failing | `valueSeries.failed: true`, stated explicitly. Other artifacts survive |
| market.json reconstruction failing | Logged and swallowed (reporting only) |
| An agent process exiting early | `agent_process_exited` + `summary.agents[].processExitedEarly` |
