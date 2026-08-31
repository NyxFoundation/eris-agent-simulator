[← Index](README.md) | [← 10 Operations](10-operations.md) | [12 Known limits →](12-open-issues.md)

# 11. Invariants and quality gates

**"Nothing fails quietly" is the discipline** ([00 §0.5 P4](00-overview.md)). The checks fall into four layers.

```
[entry]    static inspection of submitted code
[startup]  measure calibration, config and deployment, and stop
[in-run]   watch for structural breakage and report it
[post-hoc] detect violations from what the chain recorded
```

## 11.1 Startup fail-fast

**These throw before touching the chain, or before any agent process starts.** Sources are given per row.

### Configuration consistency

| Condition | Source |
|---|---|
| No config file found at all | `core/src/runConfig.ts:180` |
| `run.resetUnit: scenario` declared by anything but the matrix runner | `coordinator.ts:405` |
| A misspelled `run.resetUnit` | `sdk/src/config.ts:42` |
| A misspelled `run.chainMode` | `sdk/src/config.ts:55` |
| Both `run.epochSeconds` and `run.epochBlocks` set | `sdk/src/config.ts:592` |
| `economicGas` with `funding.ethWei < 0.5 ETH` | `coordinator.ts:479` |
| Roster validation (duplicate ids, reused wallets, contradictory external entries, …) | `core/src/config.ts:99` |

### External chains (five conditions)

`coordinator.ts:426-456`: no `TREASURY_PRIVATE_KEY`, `localDeploy: false`, `economicGas: true`, `stressVictimCount > 0`, `prewarmBlocks > 0`.

Plus: **if any scored token can be minted by anyone, stop** (`assertTokensNotMintable`, `coordinator.ts:237`). "Cheatcode-free" is a statement about RPC, but the same hole existed in a *contract* — `MockERC20.mint` was permissionless. **On a chain participants can reach, a score computed against a mintable token means nothing.**

### The deployment exists

**`deployment_check`** (`core/src/realtime/deploymentCheck.ts`) measures the enabled venues' addresses and, if any are missing, **stops while naming what is absent and the command that regenerates it**.

It used to surface minutes into setup as `Cannot decode zero data ("0x")` and a bare address. The cause is the two axes of [07 §7.6](07-configuration.md): the chain and the address overlay are configured in different places, and moving only one leaves them inconsistent.

### Venue calibration

| Check | Contents |
|---|---|
| **`lst_setup`** | The pool's rate-oracle wiring. Stops above 200bps of divergence (unwired, a rising rate is **a risk-free arbitrage open to everyone**) |
| **`liquity_setup`** | Swapping the oracle adapter and verifying drift. Stops on an opening Recovery Mode or an already-depegged chain |
| **`no_arb_startup`** | Stops when an executable cross-venue round trip exceeds `STARTUP_FAIL_BPS = 300`; warns above `STARTUP_WARN_BPS = 10` |

**Where the no-arb thresholds come from** (`core/src/realtime/noArb.ts:27-31`): after setup the venues are calibrated to within ±20bps of fair and every venue charges at least 30bps per side. So **against a round-trip cost of 60bps or more, any positive executable profit is suspicious**, and 300bps is unambiguously broken (a split deploy that flipped token sort order measured a ~1000× price error).

### Stress events

The list in [04 §4.9](04-stress-events.md). The coordinator adds venue availability, fresh state and deployer-key collision checks.

## 11.2 In-run monitors

| Monitor | Contents |
|---|---|
| **`NoArbMonitor`** | Emits `no_arb_persistent_warning` when an executable arbitrage stays above `PERSIST_WARN_BPS = 50` for **`PERSIST_BLOCKS = 10` consecutive blocks**. **A transient arbitrage is the α agents are meant to take; a persistent one is structural breakage** |
| **`epoch_boundary_failed`** | Records that a boundary could not be read, and **does not record the boundary** (never fills it with `null`) |
| **`agent_process_exited`** | An agent process ending early. **An agent that dies silently stops trading**, which without this is indistinguishable from one that chose not to |
| **`initial_endowment`** | Warns above a 2× spread. **Two-to-one is already a different competition** (on external, the endowment is a floor rather than an assignment, so a prefunded address keeps what it had) |
| **`round_timing`** | Milliseconds per stage — the diagnosis for the environment loop's bottleneck |
| `stress_calibration_warning` | The crash magnitude may not breach a victim's health factor |
| Per-task `*_failed` | keeper / oracle / liquidity / depeg / vuln / liquity watch |

## 11.3 Post-hoc checks

### The fee cap (`core/src/postRunCheck.ts`)

**With direct sending an agent can bypass the pre-flight check**, so rule enforcement moves to a mechanical inspection of what the chain recorded.

- Rows of `blocks.csv` with `role === "agent"` are scanned for `priorityFeeWei > maxPriorityFeeWei`
- **The fee comes from the on-chain transaction field**, so it cannot be tampered with
- Exceeding the cap distorts `--order fees` ordering, so the offending agent is flagged **and the run is invalidated**
- Under `economicGas` the cap is retired entirely: `violations` is empty and `fee_cap_enforcement_disabled` is emitted

### The environment's own reverts (`countRunRevertedTxs`)

**The environment's shocks must not fail quietly.** A whale goes through the ordinary relay, so a **submission** error is caught — but **an on-chain revert is not a submission error**. The transaction lands, the event log says the whale fired, and only blocks.csv shows it did nothing. A missing approval once turned this regime into calm with every log looking healthy.

### Live scoring against the sweep (`compareEpochSeries`)

Checked on every run that has both, and emitted as `epoch_series_agreement` (`boundaries` / `compared` / `maxAbsDiffUsdc` / `maxRelDiff` / `worst`).

**It is a per-run measurement rather than a test** (`coordinator.ts:176-178`) because the thing that could pull them apart — a venue whose state depends on *when* it is read rather than on which block — would only show up on a chain.

## 11.4 Entry gates

`npm run check:strategy` (the cheatcode static check, [05 §5.8](05-agent-contract.md)) and `npm run check:boundaries` (the workspace dependency direction).

LLM-generated code passes **the same static check plus a vm compile plus a 2-second wall-clock bound** before installation ([05 §5.7](05-agent-contract.md)).

## 11.5 Unit tests

57 files under `test/` (`node --test`). Grouped by what they hold:

| Area | Tests |
|---|---|
| **Freezing the contract** | `actionVocabulary` (catches renamed/removed actions) / `actionSchema` / `action` / `methodNames` (the selector table against the ABIs) |
| **Scoring correctness** | `epochScore` / `epochBoundaries` / `scoringBlocks` / `metrics` / `aggregate` / `standings` / `markMedian` / `liveScoring` / `scoringExclusions` / `summaryMultiBaseValuation` / `lpValuation` / `poolShareValuation` / `unaccountedTokens` |
| **Determinism** | `rng` / `events` / `flow` / `flowTrendCorrelation` / `whale` |
| **Mode consistency** | `resetUnit` / `chainMode` / `segments` / `externalAgents` / `config` / `run-config` |
| **Venue behaviour** | `liquity*` / `lst*` / `uniswap` / `balancerSeed` / `gmxMarketToken` / `stables` / `two-sided-quote` / `no-arb` / `tickMath` |
| **Stress** | `liquidityPull` / `liquidityPullDepth` / `vulnEvents` / `fundingGasBuffer` |
| **Rule enforcement** | `postRunCheck` / `strategyStaticCheck` / `verifyContract` / `economicGas` |
| **Agent runtime** | `improve` / `runtimeLlmCli` / `agentLogAppender` / `agent-markets` |

A few require a real locally deployed chain (`lstVault.integration`, `lstLeverage`, `vulnPools.integration`). Without `ERIS_LOCAL_DEPLOY=1` and a deployed anvil they skip (as they do in CI).

### Why there is no golden-run regression

**A run is non-deterministic** ([00 §0.5 P3](00-overview.md)), so its output cannot be frozen. Touching scoring code therefore follows a fixed order:

```
1. Pin the current behaviour with unit tests
2. Land behavioural fixes, split apart
3. Refactor last
```

## 11.6 What the checks do not catch

**Stating this is part of the specification.** The following are explicitly undetectable.

| Limit | Contents |
|---|---|
| The cheatcode static check | A regex scan over source. Obfuscation and dynamic construction get through; it is paired with post-hoc auditing |
| The vm sandbox | **Not a containment boundary.** Because `ctx` is passed in, generated code trades as freely as a hand-written strategy |
| submitted-but-not-included | **Unverifiable in principle** for an external participant (the operator holds no process) |
| Whether `crash` / `spike` / `cexDrift` / `flowTrend` fired | They change the price walk itself and leave no per-block record, so "it did not fire" cannot be said |
| A crashed run's `blocks.csv` | An ordinary run writes it in one pass at the end, so a crash leaves it empty (diagnose from `events.jsonl`) |
| The post-run sweep | **It does not run** when the window exceeds the node's retention (~1,000 blocks). That run has no equity curve, no α and no `market.json` |
