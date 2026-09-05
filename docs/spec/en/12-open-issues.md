[← Index](README.md) | [← 11 Invariants](11-invariants.md)

# 12. Known limits and open questions

The chapter that exists so nothing undecided gets written as decided ([README](README.md), rule 2).

## 12.1 Open questions in scoring

### λ for `scenario` mode

| | |
|---|---|
| State | **Uncalibrated** |
| What | The known values (0.25 in ADR 0019, 0.15 recommended by [the measurements](../../scoring-metric-measurements.md)) were **both measured on a continuous economy with 12-block epochs** |
| Why it matters | λ's effective severity moves as `λ/√(epoch length)`. Epochs per scenario depend on the scenario count S, and **S is undecided** (waiting on issue #36) |
| Consequence | `npm run metrics` refuses a set of runs with mixed `resetUnit` ([02 §2.4](02-runtime.md)). Mixing them and taking a Borda averages two different competitions |

### The metric (M4 vs M9)

| | |
|---|---|
| State | **Open** (issue #56) |
| What | M4 (excess log growth) and M9 (`mean − λ·std`) disagree about whether a higher-earning, choppier agent should outrank a steadier one |
| Not settled by recomputation | They differ by exactly `λ·std`, and **a rank moves only when that agent's per-epoch Sharpe crosses λ**. Which is correct is a design judgement, not a calculation |
| Today | ADR 0019 chose the risk-adjusted metric (M9). `backtest` still defaults to `netPnlUsdc` because it is **the only metric comparable with older matrices** |

### The cross-scenario aggregator

| | |
|---|---|
| State | **No successor named** |
| What | ADR 0019 declared the incumbent z-score retired without naming a replacement. Issue #55 is the reason: one entry at −1,113 USDC took the field's sd from 20.9 to 181.5 and compressed everyone else by 8.7× |
| Candidates | `zscore` / `borda` / `mean` ([06 §6.6](06-scoring.md)); `npm run metrics -- --matrix` compares them exhaustively |
| Today | The dashboard displays `zscore` and nothing else; rescoring is a CLI job |

### What an LST is scored at (par or realizable)

| | |
|---|---|
| State | **Undecided** |
| What | **Settled 2026-09-05 (issue #40 / ADR 0022 Amendment 1): realizable.** Scoring sums `liquidatableValueUsdc` for every venue; the face mark is reported as `markedValueUsdc` where it differs |
| The tension | Issue #38's intent was realizable; the implementation uses par (partly a consequence of ADR 0019 §3 choosing the ordinary live mark as the basis) |
| Deadline | **Before `lst` enters the competition set** |

### ETH-denominated scoring

Under USDC denomination, an LST-holding strategy is structurally penalised by β (measured: noop 0 > lst-carry −203 > lst-carry-wide −233, while venue-arb, which holds no WETH, was +115). α removes β only from free inventory, and LST positions are live-marked. **ETH-denominated scoring is the follow-on issue #38 was motivated by.**

## 12.2 Open questions and structural limits in the environment

### The scenario count S

The value that sets epochs per scenario in `scenario` mode — **undecided, including whether scenarios run serially or in parallel** (issue #36). λ's calibration is waiting on it.

### Recovery Mode is unreachable at the current calibration

| | |
|---|---|
| Measured | A minimum TCR of 2.244 against a CCR of 1.5 (seed 501) |
| Cause | The genesis Trove (250 ETH / 250k eUSD, 300%) dominates the TCR |
| What reaching it would break | System debt has to roughly triple, which **necessarily** thins both the redemption fee curve (inversely proportional to supply: +100bps per 5k redeemed at 250k becomes +36bps at 700k) and the Stability Pool's relative depth (a Recovery Mode liquidation only proceeds when the SP can absorb the whole debt) |
| State | **Split out as issue #59** |

### Venues that cannot run on a fork

`lst` and `liquity` have no Arbitrum counterpart (the vault is ours, and Liquity is deployed by us), so enabling them on a fork **fails fast at startup**. There is no longer a reason to use fork mode — local deploy is faster and more stable — and it is the default.

### Cross-asset correlation is zero

Per-base Rngs are fully independent (`sdk/src/rng.ts:120-124`). Adding correlation means consolidating onto a shared Rng, which changes WETH's consumption sequence and breaks backward compatibility, so **it is not done by default**.

### `economicGas` cannot run on an external chain

It finalizes prices with a storage write (which is what removes the front-run target), and that is impossible on a real chain. **Waiting on the redesign in issue #33 (2)**; until then, use the transaction-based profile (ADR 0021, Negative).

### Aave propagation for market-priced stables is currently a no-op

`stableAaveAggregators` is implemented, but **no market-priced stable is an Aave reserve today** (`aaveReserveSymbols()` is the bases plus USDC plus the LST). It activates the day one is listed; today it costs one pool read.

### `run.readRpcUrl` is only plumbed

The path for splitting reads to a replica exists, but **whether to actually split is waiting on issue #36**.

## 12.3 Operational limits

| Limit | Contents |
|---|---|
| **anvil's history retention** | About 1,050 blocks. The post-run sweep caps at 1,000 and **skips explicitly** beyond it (losing the equity curve, α and `market.json`) |
| **Run non-determinism** | The same seed still gives different transaction timing and ordering. Single-run comparisons are meaningless; comparison needs samples |
| **The spot AMI needs a rebake** | ADR 0015's workspace split changed what `npm install` targets and the paths it assumes, so the next spot use needs `/spot-bake` |
| **One address overlay at a time** | Moving deployments means regenerating with `gen:local-constants` |
| **A crashed run's `blocks.csv`** | An ordinary run writes it at the end, so a crash leaves it empty |
| **`--only` partial redeploys** | Shared tokens are recreated, leaving venues on inconsistent addresses. Redeploy every venue together |

## 12.4 Things deliberately not done

These are not open questions. They are decisions.

| Item | Reason |
|---|---|
| **Automatic rollback of a revision** | No threshold is defensible. The previous implementation fired zero times in 18 runs, and the obvious opposite ("any loss at all") reverts every revision in a regime where everyone is losing. Reverting is the model's call ([05 §5.7](05-agent-contract.md)) |
| **Per-decision LLM calls (prompt mode)** | Measured at 8–28 blocks per decision and 1/64 the actions of the rule form. It could not compete (ADR 0018) |
| **Enforcing G2 on-chain** | The bankruptcy freeze is a scoring rule, not a chain rule: on a live chain a participant reaches the sequencer directly (ADR 0019 §5) |
| **Preventing self-stranding** | Liquity collateral is native ETH, the same balance that pays for gas. Sinking all of it and losing the ability to send is **a legitimate loss**. `suggestedGasReserveWei` is surfaced, not enforced |
| **Tracking submitted-but-not-included for external agents** | Unverifiable in principle when the operator runs no process |
| **Resets on the practice devnet** | On a practice ground that is the design (ADR 0021 §1) |
| **A `liquidityPull` magnitude of 1.0** | With no depth every swap reverts, which is an outage rather than a thin book |

## 12.5 Removed and not coming back

| Item | State |
|---|---|
| The old LLM self-improvement machinery (`src/llm`) and unreferenced strategies in `_archive/` | Deleted (recoverable with `git checkout 4a65a8f -- _archive`) |
| The 19 old-format `prompt.md` files (per-decision prompts) | Deleted in `f42fd2a`. **They survive in git history and in older bundles**, which is why the `kind: improve` marker exists |
| `directShim` / `relay` / the stdin-stdout protocols | Retired (along with `ERIS_AGENT_DIRECT_TX`) |
| The evaluation and visualization commands (`sim` / `evaluate` / `gate` / `discrimination` / `leaderboard` / `stress-report`) | Removed |
| The dashboard's `/standings`, `/leaderboard`, `/archive`, `/run` | Removed ([09 §9.1](09-dashboard.md)) |
| Reading configuration from env | Retired; a stale variable now warns |

## 12.6 References

- The primary measurement record: [`docs/scoring-metric-measurements.md`](../../scoring-metric-measurements.md)
- The decision history: [`docs/adr/`](../../adr/) (ADR 0001–0021)
- The participant-facing rules: [`docs/competition-rules.md`](../../competition-rules.md)
