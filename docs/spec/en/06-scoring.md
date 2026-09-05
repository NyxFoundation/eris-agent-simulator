[← Index](README.md) | [← 05 The agent contract](05-agent-contract.md) | [07 Configuration →](07-configuration.md)

# 06. Scoring

Sources: `core/src/scoring/{epochScore,metrics,aggregate}.ts`, `core/src/realtime/{liveScoring,reconstruct}.ts`, `core/src/backtest/standings.ts`, `sdk/src/{valuation,pnl,stables}.ts`.

## 6.1 Four layers

```
[1] holding → USDC        token kinds and venue adapters price it
[2] cross-section → series  every agent read at the same block, at each epoch boundary
[3] series → P              P = V_K − V_0 (the two ends of the boundaries; one per run)
[4] epochs → standings      T = 50 + 10 (P − μ) / σ over the field → Score = Σ w·T / Σ w (rules §4.4)
```

**Layers 1–3 complete inside one run; layer 4 needs a field (everyone who ran the same epoch)** — the matrix's `standings.json` and the dashboard compute it, and a run's `summary.json` stops at P. Every layer's output is stored, so an upper layer can be swapped without re-running a lower one ([00 §0.5 P5](00-overview.md)).

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

The staged generator from [01 §1.4](01-architecture.md). An adapter returns `valueUsdc` (the mark) and `liquidatableValueUsdc` (what an exit would realize). **Scoring sums the first.**

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
| LST | No | The scored mark is face value (redemption rate × WETH fair) and reads no pool at all |

Live and sweep use the same window. How much the rule actually moved is reported in `valueSeries.markMedian.maxDeviationBps`.

### α (PnL with β removed)

Only the sweep produces it. Free inventory is valued at **a reference fair price fixed within the run** (`alphaRefFairUsdcPerWeth`), and `alphaByAgent = alphaLast − alphaFirst`. Only the first and last cross-sections are used, so thinning does not affect it.

**α removes β only from free inventory.** Venue positions (an LST holding, say) are live-marked, so under USDC-denominated scoring an LST-holding strategy is structurally penalised by β (measured: noop 0 > lst-carry −203 > lst-carry-wide −233, while venue-arb, which holds no WETH, was +115).

## 6.4 Layer 3: the score (the deviation score of rules §4.4; ADR 0022)

Source: `core/src/scoring/deviationScore.ts`. **One number per epoch (= one run)**; the intra-run interval series is not used.

```
P(a, s)   = V_K − V_0                       USDC profit and loss, each end at its own boundary's marks (§4.1's 5-block median)
μ_s, σ_s  = mean and population std of P over every agent placed in the epoch (benchmark excluded)
T(a, s)   = 50 + 10 × (P(a, s) − μ_s) / σ_s          the deviation score
w_s       = 1 + 0.5 × (s − 1) / (k − 1)              first 1, last 1.5 (k = 1 gives 1)
Score(a)  = Σ_{s∈S} w_s T(a, s) / Σ_{s∈S} w_s        S = the valid epochs with σ_s > 0
```

- **P is the two ends of the boundary series** (`core/src/scoring/epochPnl.ts`; `summary.json`'s `agents[].pnlUsdc`). If the final boundary did not report, **the most recent one that did** is used (§4.4.2; recorded as `pnlFinalBoundaryIndex`). It differs from `netPnlUsdc` (both ends at the final marks) by a constant across the field when everyone starts with the same basket, so the deviation score is the same either way — but this is the quantity the rules name
- **The population is everyone placed.** Bankruptcy (asset value ≤ 0) counts at its negative value; **no floor, no freeze** (§4.4.2). The benchmark (the roster's `baseline: true`) is valued and shown but not in the population (§4.3)
- **An epoch with σ_s = 0, or invalidated by the organizer's facilities, leaves S for everyone.** The other weights do not move (w_s is a function of the scheduled ordinal s and k)
- **An agent not placed** in an epoch (absent from its summary) is not in that population and is averaged over the epochs it was placed in
- A single epoch's T is bounded by 50 ± 10√(n − 1) (n = the population)
- **There is no disqualification** (rules amendment of 2026-09-06). An early process exit, a fee-cap violation, a transaction absent from the submitted log are `flags` beside the number and do not change P; §8 is the operator's call

### Ranking (§4.6)

- T and Score are compared at **two decimals** (third rounded half away from zero = `round2`)
- Ties break on (1) the smaller population std of the agent's own T series → (2) the larger worst-epoch T → (3) the earlier final submission. What is still equal is a tie (shared rank, next rank skips)

## 6.5 Layer 4: scenario-matrix standings (`core/src/backtest/standings.ts`)

- **One scenario of the matrix is one epoch.** The ordinal s is the run order for a `{regimes, seeds}` product, and explicit for a `{k, epochs: [{s, regime, seed}]}` plan (`npm run competition -- plan`). k is the set's size or the plan's `k`
- `matrix.json` (schema 2) stores per-agent `pnlUsdc` / `pnlSource` / `netPnlUsdc` / `alphaUsdc` / endpoints / `baseline` / `flags`; `standings.json` is `computeStandings`' output (`k` / `S` / `epochs` (μ, σ, n, w, exclusion) / `agents` (rank, tied, score, epochs, tStd, worstT, flags) / `benchmarks`)
- **A scenario with no summary.json is an invalid epoch for everyone** (§4.4.2); it is never excluded for some participants only
- `--metric` and `npm run metrics` are retired (M1…M27 and the aggregators were deleted)

### The epoch order and its commitments (rules §3.3 / §7)

`core/src/competition/schedule.ts`. From the hidden set (regime → seeds) and the lottery seed it derives the epoch sequence, **every regime the same number of times**: SHA-256 in counter mode, unbiased integers by rejection, Fisher-Yates. The lottery seed decides only the order (and, where a regime has spare seeds, the choice among them). Both files are committed to as the sha256 of their canonical JSON (`npm run competition -- commit <file>`) and published in full after the results.

## 6.6 Standings display rules (dashboard)

- `dashboard/src/data/standings.ts` **imports** `@core/scoring/deviationScore` (two implementations of one ranking leave no way to tell which is real when the CLI and the screen disagree)
- Score column = Score at two decimals. Regime columns = the agent's mean T in that regime (an explanation, not a second ranking). Reference column = net PnL (final marks)
- While the round cursor is mid-competition, P = V_k − V_0 is re-read from the boundary series and T and Score recomputed (**never show the future**)
- The agent page's Standing tab: every scored epoch (s / scenario / P / T / w), the mean, std and worst of T (the tie-breaks), a per-regime split, and bankruptcies (scenarios ended at or below zero)
- A single run's leaderboard shows T for that epoch (the benchmark shows —). Per-round log returns are the raw change of account value and are not scored

Details in [09](09-dashboard.md).

## 6.7 Open questions in scoring

| Question | Status |
|---|---|
| **The value of k** | Published in Appendix A before the submission period opens. Recommended 40 (8 regimes × 5) |
| **The actual hidden set and lottery seed** | Generating them and publishing the commitments is operator work (`npm run competition -- commit`) |
| **What an LST is scored at** | The implementation marks at par; issue #38 intends realizable. To be decided before `lst` enters the competition set |

→ [12 Known limits and open questions](12-open-issues.md)
