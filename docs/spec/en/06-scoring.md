[← Index](README.md) | [← 05 The agent contract](05-agent-contract.md) | [07 Configuration →](07-configuration.md)

# 06. Scoring

Sources: `core/src/scoring/{epochScore,metrics,aggregate}.ts`, `core/src/realtime/{liveScoring,reconstruct}.ts`, `core/src/backtest/standings.ts`, `sdk/src/{valuation,pnl,stables}.ts`.

## 6.1 Four layers

```
[1] holding → USDC        token kinds and venue adapters price it
[2] cross-section → series  every agent read at the same block, at each epoch boundary
[3] series → score          M9 = mean(x_e) − λ·std(x_e)
[4] scenarios → standings   z-score within a scenario, then equal weight per regime
```

**Layers 1–3 complete inside one run; layer 4 exists only for a scenario matrix.** Every layer's output is stored, so an upper layer can be swapped without re-running a lower one ([00 §0.5 P5](00-overview.md)).

## 6.2 Layer 1: valuing a holding

### Spot (`sdk/src/valuation.ts`)

`tokenAmountUsd(token, amount, fairByBase, stablePrices)` is the single entry point.

| Token | Price |
|---|---|
| `kind: "base"` | The run's fair price |
| `kind: "stable"` | What the market pays (`stablePriceUsdc`); USDC is fixed at $1 |
| USDC variants outside the registry (USDC.e / USD₮0) | The 6-decimal, $1 convention |
| Anything else | **`undefined` — unpriceable.** Not zero |

Returning `undefined` rather than zero is the point. The scorer used to enumerate a fixed set of position types and value everything else at exactly zero, so **moving real value into an unlisted venue read as a total loss**.

LP tokens are valued as **a proportional share of the pool's reserves** (`poolShareValueUsdc`). Both Balancer weighted pools and Curve crypto pools let a holder exit at the pool's own ratio without a swap fee, so the proportional share *is* the realizable exit value — and it avoids depending on a venue-specific pricing formula (virtual price, BPT rate).

### Venues (the adapter's `valueAtBlock`)

The staged generator from [01 §1.4](01-architecture.md). An adapter returns `valueUsdc` (the face mark) and `liquidatableValueUsdc` (what an exit would realize). **Scoring sums the second** (issue #40 axiom 3 / ADR 0022 Amendment 1); the face mark is reported as `markedValueUsdc` only where the two differ.

### Reporting what fell out of the value

`ScoringExclusionReason` has four values (`valuation.ts:42`).

| Reason | Meaning | Counted in the value? |
|---|---|---|
| `unpriced` | The amount is known but has no USD price | No |
| `read-failed` | The read failed, so the holding is **unknown** (not zero) | No |
| `unrealizable` | Priceable, but cannot be turned into anything before the run ends (the LST queue) | No |
| `par-fallback` | No market quoted, so **it was counted at $1** | **Yes** |

All four are reported in `summary.json`'s `valueSeries.unpricedHoldings`. **A zero in summary.json must never be mistaken for a trading loss — and neither must a dollar.**

### Finding unaccounted tokens

`findUnaccountedTokens` scans Transfer logs for ERC-20 holdings nothing sums. Adapters declare what they already cover through `accountedTokens()`. **A token a venue issues but does not value is deliberately left out of that declaration**, so it stays visible. Real example: LQTY gains from a Stability Pool deposit were reported as `erc20-unaccounted`, 61.3 LQTY.

## 6.3 Layer 2: cross-sections and the series

### Two paths

| Path | When | Produces |
|---|---|---|
| **live** (`LiveScorer`) | As each epoch boundary goes past | The epoch series used for scoring; `epochs.jsonl` and `epoch_boundary` events |
| **sweep** (`reconstructValueSeries`) | After the run, if the window is ≤1000 blocks | The equity curve, α, `unpricedHoldings`, `market.json` |

**They use the same reader (`readValueSnapshotAtBlock`), the same blocks and the same G7 median window**, so they agree. That is what makes live a replacement rather than a second scoring path — and it is checked on every run that has both, through `epoch_series_agreement` ([11](11-invariants.md)).

**Why live is needed** (`liveScoring.ts:1-18`):

1. On a chain that never stops, there is no "afterwards"
2. A node's history is finite (anvil holds roughly 1,050 blocks), and "make the run shorter" is no answer for a week-long chain

### Epoch boundaries

`epochBoundaryBlocks(fromBlock, toBlock, epochBlocks)`. E epochs need E+1 boundaries, and the run's start is boundary 0.

**A trailing partial epoch is dropped rather than scored short.** A shorter window produces a smaller log return by construction, which the metric would read as the agent slowing down.

`--score-every N` thins the equity curve but always includes `fromBlock` and `toBlock`. **The score is unchanged** (α uses only the first and last cross-section).

### A boundary that could not be read

**The boundary is not recorded** (never filled with `null`). The series distinguishes "no value here" from zero, and not pushing the boundary block keeps the series aligned with the boundaries that were actually read.

### G7: median marks (`MarkMedian`)

Each epoch boundary is valued at **the median over the preceding `markMedianBlocks` blocks** (5 by default). Pushing a pool for one block therefore does not become the score: it has to hold for most of the window to count, which turns a spread-cost round trip into a position.

**The scope is market-priced stables, and that covers the whole surface.**

| Surface | Medianed? | Why |
|---|---|---|
| Market-priced stables (spot, Trove debt, SP deposits) | **Yes** | The pool quote **is** the mark of a holding whose cost basis sits elsewhere, so moving the pool moves the score |
| LP shares | No | Valued by composition (reserves × the environment's fair price). Pushing the pool moves value between the agent's own two buckets |
| LST | No | Since issue #40 axiom 3 the scored mark is the realizable one, so the pool quote is in it — but pushing that pool moves value between the agent's own two buckets, exactly as with LP shares. What it can move is the discount, and the median window covers that |

Live and sweep use the same window. How much the rule actually moved is reported in `valueSeries.markMedian.maxDeviationBps`.

### α (PnL with β removed)

Only the sweep produces it. Free inventory is valued at **a reference fair price fixed within the run** (`alphaRefFairUsdcPerWeth`), and `alphaByAgent = alphaLast − alphaFirst`. Only the first and last cross-sections are used, so thinning does not affect it.

**α removes β only from free inventory.** Venue positions (an LST holding, say) are live-marked, so under USDC-denominated scoring an LST-holding strategy is structurally penalised by β (measured: noop 0 > lst-carry −203 > lst-carry-wide −233, while venue-arb, which holds no WETH, was +115).

## 6.4 Layer 3: the score (M9)

Source: `core/src/scoring/epochScore.ts:71`.

```
x_e   = ln(W_e / W_{e−1}) − ln(B_e / B_{e−1})      e = 1..E
W     = max(V, 0.01 × W_init)                      G1, the bankruptcy floor
score = mean_e(x_e) − λ · std_e(x_e)               λ = 0.25 by default
```

- `std` is the **population** standard deviation (denominator E, not E−1). The series is the whole week, not a sample drawn from it
- **`E` is fixed across the field.** Dividing by "however many epochs this agent survived" shrinks std for short series and **makes failing early pay** (ADR 0019 §8)
- An agent with no positive opening value gets no score (`null`). Inventing one — par, or the first value that did report — would put a number on an agent nobody measured

### The benchmark (excess returns)

`B` is the series of the roster's `baseline: true` entry. **This is not cosmetic.**

Holding cash has to score exactly 0 in both mean and std, or λ is not a hurdle over doing nothing. Measured across five B-harness seeds: scoring raw returns gave the noop agent −5.07e-5 with a std of 2.22e-4, **93% of an active agent's total dispersion** — everyone's gas reserve moving with ETH. Every agent carries the same reserve, so it cancels epoch by epoch; subtracting it took peg-arb's Sharpe from 0.111 to 0.241 and noop to exactly zero.

The mean term is unaffected by the choice (log returns telescope, so the benchmark is a constant there). **Only the std term changes** — which is the whole reason the benchmark had to be cash rather than HODL (ADR 0019 §2).

The benchmark is scored against itself, so its row is present and reads 0 rather than going missing. With no baseline in the roster, a warning is printed and the returns stay raw.

### G1 / G2: bankruptcy

| Guard | Contents |
|---|---|
| **G1** | Floor the value at 1% of initial capital (`floorFraction`) |
| **G2** | From the epoch that touches the floor onward, **freeze the series at 0 (zero excess)** |

G1 is not just `ln(0)` avoidance. **Aave's `valueUsdc` is collateral minus debt and is not clamped**, so a liquidated agent's total value can be negative, where `ln` is NaN rather than −∞. Flooring makes bankruptcy a defined event that G2 can hang off, and it bounds the worst single-epoch return so one blowup cannot dominate every std in the field.

**G2 is a scoring rule, not a chain rule.** An agent's transactions are never blocked: on a live chain a participant reaches the sequencer directly, and only a sequencer-level power could stop them (ADR 0019 §5).

### Gaps

A boundary that could not be read **carries the previous value forward at a return of 0** and is recorded in `carriedForwardEpochs`. Dropping the epoch instead would shorten the series **for exactly the agents the environment failed to read**, and a shorter series is a smaller std. A gap is the environment's failure, not the agent's.

## 6.5 Candidate metrics (`npm run metrics`)

`core/src/scoring/metrics.ts` computes every candidate from **the same epoch series**. It is the module that exercises the promise ADR 0017 §4 and ADR 0019 both make: that the rule can be swapped and stored runs rescored.

| No. | Field | Definition |
|---|---|---|
| M1 | `totalPnlUsdc` | The endpoint difference in USDC. Risk-neutral |
| M4 | `excessLogGrowth` | Excess log growth over the benchmark. **Both legs are normalised by their own starting value**, so a differently funded benchmark does not shift the comparison |
| M7 | `mppm` | MPPM (Goetzmann et al. 2007). ρ=1 is excluded by the formula, and returns the mean log return instead |
| M9 | `score` | `mean − λ·std` (the current rule) |
| M13 | `sharpePerEpoch` / `sharpeOverRun` | Per-epoch Sharpe and the same figure × √E. **Not a headline candidate** (a ratio is scale-invariant, so "stay small and safe" optimises it), but λ is a threshold on it, so it belongs in the table |
| M27 | `bordaTotals` | Borda over a set of runs. Ordinal by construction, so a regime whose spread is ten times another's cannot dominate |

**How M4 and M9 relate**: log returns telescope, so `sum(x_e) = E·mean(x_e)`. They therefore differ by **exactly `λ·std`**, and **a rank moves between them if and only if that agent's per-epoch Sharpe crosses λ**.

`npm run metrics` takes `--lambda` / `--rho` / `--out`, and **refuses a set of runs with mixed `resetUnit`** ([02 §2.4](02-runtime.md)).

## 6.6 Layer 4: scenario-matrix standings

### The current rule (`core/src/backtest/standings.ts`)

```
1. scenario score   the raw metric from that scenario's run
2. scenario z       normalized across the agents *within the scenario*
3. total            mean over scenarios in a regime, then mean over regimes (equal weight)
```

**Why normalize per scenario rather than per regime**: every agent in a scenario ran in the same world (ADR 0017 §1's co-location), so comparing them to each other is the one comparison the design guarantees is fair. It also flattens the seed-to-seed scale spread inside a regime, not only the regime-to-regime spread.

**Regimes carry equal weight**, so a regime with more seeds does not carry more of the total (ADR 0017 §3).

### Disqualification

| Event | Handling |
|---|---|
| The process died / a rule was broken / it never reported | Disqualified, placed **one standard deviation below the worst finisher** (`DISQUALIFIED_Z_PENALTY = 1`) |
| The summary is readable but the metric is missing | Also disqualified (a reporting failure must not be credited with an average result) |
| No summary.json at all | **The whole scenario is excluded** and reported separately — an environment failure is not charged to participants |

Disqualification has to be **worse than finishing last**, or crashing becomes a strategy; and it has to be **bounded rather than −∞**, or one bad scenario decides the competition.

### Selectable metrics (`ScoringMetric`)

`netPnlUsdc` (default) / `alphaUsdc` / `excessLogGrowth` / `score`. The default is `netPnlUsdc` because it is **the only metric comparable with older matrices**.

**M4 and M9 are taken from the epoch series** (`summary.json`'s `epochScores`). Taking M4 from the same series M9 scored — rather than from the endpoints — means a bankrupt agent's M4 reflects the series after G1/G2 froze it.

### Aggregators (`core/src/scoring/aggregate.ts`)

In `scenario` mode there is **a second choice beyond the metric: how to aggregate across scenarios**.

| Aggregator | What it does | Weakness |
|---|---|---|
| `zscore` | The incumbent. Scale-free within a scenario | **Issue #55**: one extreme entry inflates the field's sd and compresses everyone else |
| `borda` | Rank within the scenario, then average. One extreme result costs one place | Throws away *how much* better the winner was (1 USDC and a blowout count the same) |
| `mean` | Average the metric itself; keeps absolute scale | Lets one high-variance regime dominate |

All three share the outer weighting (mean within a regime, then mean over regimes) and are oriented "higher is better".

**`sdInflationFromExtreme`** turns issue #55 into a number: the field's sd with its most extreme agent, over the sd without it. **1.0 means no single agent is setting the scale.** Measured, one entry at −1,113 USDC took the sd from 20.9 to 181.5 (a ratio of 8.7), and since a z-score divides by that sd, everyone else was compressed by the same factor.

`npm run metrics -- --matrix runs/matrix-<id>` rescores every metric × aggregator combination and reports each ordering, its agreement with M9×zscore, and the #55 exposure.

## 6.7 Standings display rules (dashboard)

Fixed for participants (2026-08-31).

- Ranking is per scenario **M9 (λ=0.25) → z-score within the scenario → equal weight per regime**
- **The score column shows the equal-weight regime mean of M9 itself** (×10⁴, no unit label). The aggregated z is demoted to a tooltip, because a unitless z cannot answer "by how much"
- One reference column carries the sum of net PnL at final marks (the quantity where β cancels and `noop` is exactly 0)
- **The displayed value and the rank can occasionally disagree.** That is the difference between the aggregators, and the caption says so
- The aggregation is **imported by the dashboard from `core/src/scoring/aggregate.ts`** — two implementations of one ranking leave no way to tell which is real

Details in [09](09-dashboard.md).

## 6.8 Open questions in scoring

| Question | State |
|---|---|
| **λ for `scenario` mode** | The known values (0.25 in ADR 0019, 0.15 recommended by the measurements) were both measured on **a continuous economy with 12-block epochs**. Epochs per scenario depend on the scenario count S, and S is undecided |
| **The metric (M4 vs M9)** | Whether a higher-earning, choppier agent should outrank a steadier one is not settled by recomputation. ADR 0019 chose a risk-adjusted metric; issue #56 is open |
| **The aggregator** | ADR 0019 declared the incumbent z-score retired without naming a replacement |

→ [12 Known limits and open questions](12-open-issues.md)
