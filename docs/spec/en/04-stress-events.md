[← Index](README.md) | [← 03 The market](03-market.md) | [05 The agent contract →](05-agent-contract.md)

# 04. Stress events

Sources: `core/src/realtime/events.ts` (the schedule) and `core/src/realtime/{liquidity,stableDepeg,whale,lst}.ts` (execution). Configured under `stress:`. Off by default.

## 4.1 The shared model

| Principle | Contents |
|---|---|
| **Ranges, not values** | `magnitudeRange` and `windowFrac` are `[min, max]`. The actual values are drawn deterministically from the seed, which prevents memorizing constants and measures generalization (ADR 0004) |
| **An independent Rng** | The seed is XORed with the salt `0x53545253` ("STRS"), so the price and flow streams are untouched |
| **A pure function** | `EventSchedule` resolves `(config, seed, runBlocks)` into a schedule. It touches neither the chain nor I/O |
| **A fixed-length run is required** | Window positions are fractions of run length, so `run.blocks > 0` or it throws |
| **Windows fit inside the run** | `startBlock` is clamped to `runBlocks − span` |
| **RNG consumption is a pure function of the event list** | `side` and `kappaMult` are **always drawn**, even for types that never use them. Making the draw conditional would let one event's settings shift every later event's schedule |

## 4.2 The types, and how each is consumed

Nine of them. `EVENT_KIND` (`events.ts:81`) is a **total Record over every type**, so adding a type and forgetting a consumer does not compile.

| type | Consumption | What it does |
|---|---|---|
| `spike` | overlay | Distorts the fair price upward for the window |
| `crash` | overlay | The same, downward |
| `lstSlash` | point | Permanently lowers the LST vault's redemption rate in one block |
| `whale` | point | A single large market order. **The fair price does not move** — only the pool does |
| `liquidityPull` | state | Withdraws pool depth for the window and puts it back afterwards |
| `eusdDepeg` | state | Sells eUSD into its own market for the window and buys it back |
| `depeg` | state | The same mechanism for any market-priced stable (`stable:` required) |
| `cexDrift` | process | Changes **the price walk itself** (adds drift, weakens kappa) |
| `flowTrend` | process | Leans the uninformed flow for the window |

**The four kinds of consumption** (`events.ts:67-75`):

- **overlay** — a multiplier applied to the fair price every block of the window (`at()`)
- **point** — executed once, on the block it lands on (`pointEventsAt(fromIndex, toIndex)`)
- **state** — a target the coordinator **reconciles the venue against every block** (`depthMultiplierAt()` / `depegFractionAt()`)
- **process** — a parameter the generator itself reads for the window (`ouOverrideAt()` / `flowTrendAt()`)

**Why state is not a one-shot removal**: the target is a pure function of the block index, so a dropped block notification costs one block of lag instead of stranding the pool at the wrong depth. `pointEventsAt` takes a **range** for the same reason — when it matched a single index, one dropped notification swallowed the entire stress axis.

## 4.3 The trapezoid

```
envelope(t) ∈ [0,1],  t = blockIndex − startBlock

t < 0                    → 0
t < ramp                 → (t+1)/ramp          rise (in effect from the window's first block)
t < ramp+hold            → 1                   hold
persist: true            → 1                   never closes (1 from here on)
t < ramp+hold+decay      → 1 − (t−(ramp+hold)+1)/decay   decay
beyond                   → 0
```

`spike` is `wethMult = 1 + m·e`, `crash` is `1 − m·e`. An instantaneous jump interacts badly with the one-block oracle lag, so the trapezoid **leaves room for everyone to react with the same one-block delay** (ADR 0009 §1).

A point event's window is a single block (`POINT_EVENT_SPAN`).

## 4.4 Per type

### `spike` / `crash`

`magnitude` is the deviation width of the price multiplier. `base:` selects the target (WETH by default).

### `lstSlash`

`magnitude` is the fraction of the staking pool burnt (0.02 = a 2% slash). **Bounded below 1.0** (exclusive) — at 100% `totalPooledWeth` hits zero, `convertToAssets` falls back to its 1:1 branch, the pool's rate oracle snaps to par, and **every staker is silently erased while the discount reads 0**.

**No discount opens** — the pool reprices by following the rate oracle, which is evidence the oracle is wired correctly. A slash is a risk holders bear, not an arbitrage. So the magnitude is calibrated **on the yield scale**: 10–30bps against the 3–8bps of yield a 70-block run produces. The first attempt, 100–300bps, was fifteen times the yield and made staking a guaranteed loss.

### `whale`

`magnitude` is **an absolute number of base units** (30 = a 30 WETH market order). Not a fraction, because what matters is size against pool depth, and depth is a property of the deployment rather than of this config.

- `venue:` defaults to `uniswap` (the deepest pool — the size has to be real to move it)
- `side:` defaults to `random` (the seed decides, which stops the direction being memorized across a published regime's seeds)
- **Against `crash`**: a crash moves fair itself; a whale knocks the pool away from an unchanged fair. **The dislocation points the other way**, and the trade to find is a different one
- It is relayed through the ordinary flow path, so it is signed, ordered and attributed like any other flow order. It trades from a dedicated address endowed at setup, so it is **anticipatable** (deliberately)

### `liquidityPull`

`magnitude` is the fraction of depth withdrawn at the top of the trapezoid. **Bounded below 1.0** — with no depth every swap reverts, which is an outage rather than a thin book.

- `venue:` **omitted means every enabled venue**. Thinning one only moves execution elsewhere, so narrowing is opt-in
- Depth is withdrawn **proportionally on both sides**, so the mid does not move and no risk-free arbitrage opens
- It moves LP positions the environment seeded (the deployer = anvil account 0), so a roster using that same account fails fast ([02 §2.1](02-runtime.md))
- On a fork there are no seeded LP positions, so it fails fast there too
- Local deploy only

### `eusdDepeg` / `depeg`

`magnitude` is the fraction of the pool's seeded stable depth the environment has sold (0.3 = 30k sold into a 100k pool). **Bounded below 1.0** — selling the side out entirely leaves nothing to buy, and the discount stops being a price. The resulting discount is **a property of the curve**, not of this number.

- `depeg` **requires `stable:`**. A run can hold several, and picking one silently would make the regime depend on registry order
- The implementation is shared (`core/src/realtime/stableDepeg.ts`); only the event names differ (`stress_eusd_depeg*` vs `stress_depeg*`)
- The trade differs: **eUSD has a redemption floor a CDP enforces**, while a plain stable has only the belief that it is a dollar. One is a claim on collateral, the other an opinion

### `cexDrift`

Changes **the walk itself** (`ouOverrideAt`).

```
driftAdd += (side === "sell" ? −1 : +1) × magnitude × envelope(t)
kappaMult *= 1 + (ev.kappaMult − 1) × envelope(t)
```

- `kappaMultRange` weakens mean reversion. **Adding drift alone is not a drift** — the OU pulls it straight back out (the `cex-drift` regime did this with a run-wide kappa of 0.004 against the 0.02 default, a multiplier of 0.2)
- Because it is not an overlay, **the price does not return when the window closes** — which is what a drift means
- With `repriceAnchor: true` the anchor moves by exactly the drift applied so far (`anchorMultiplierAt`), so mean reversion has nothing to fight during the episode and the level reached is still there afterwards

### `flowTrend`

Leans the uninformed flow for the window (`flowTrendAt`).

- `magnitude` is a size multiplier (the `informed-flow` regime used 3×)
- `trendCorrelation` and `persistBlocks` **do not fade with the trapezoid**. They apply as long as the window is open — "correlation 0.5 during the ramp" is not a weaker regime, it is **a different one**

## 4.5 Composition

| Quantity | How overlapping events compose |
|---|---|
| Price overlay | **Multiplicative** (`baseMults[base] *= 1 + sign·m·e`) |
| Depth | **Multiplicative** (`byBase[base] *= 1 − m·e`) |
| Depeg sold fraction | **Additive** (two overlapping dumps sell two amounts) |
| OU drift | **Additive**; kappaMult is multiplicative |
| flowTrend sizeMult | **Multiplicative**; the shape knobs (correlation, persistBlocks) take the **max** |

## 4.6 `alignWith`

Shares a window's start position with an event of another type.

**"The same range" is not "the same window."** Two events sampling `windowFrac: [0.25, 0.7]` of a 360-block run land ~160 blocks apart on average. "The book is thin while the gap is open" is **a property of the pair**, so it has to be stated rather than hoped for (issue #52; see `config/regimes/crash.yaml`).

Constraints:

- It may not name its own type (ambiguous once there are two, and it says nothing)
- **Chains are refused** (throwing if the anchor is itself aligned) rather than resolved correctly half the time depending on visit order
- If the anchor sits late in the run and the follower's trapezoid is longer, it throws. Silently sliding it earlier would break **the one thing alignWith exists to guarantee**
- `windowFrac` is still required and still drawn (just unused), keeping RNG consumption a pure function of the event list

## 4.7 The two flags that do not restore

By default the environment buys back when a window closes and the OU pulls back to the initial anchor, so **every price move is temporary**. The answer to "will it return to par" is then always yes, and a strategy that simply waits wins structurally rather than by judgement (issue #56).

| Flag | Applies to | Effect | Constraint |
|---|---|---|---|
| `persist: true` | `depeg` / `eusdDepeg` | Holds the level to the end of the run | **`decayBlocks: 0` required** (silently ignoring a decay would read as a window that closes, so it throws) |
| `repriceAnchor: true` | `cexDrift` | Moves the OU anchor by the drift applied | — |

**The teardown buy-back still happens.** The startup check refuses to begin on a depegged pool, so leaving it dislocated would stop the *next* run from starting. That restore happens **after the last scored block** ([02 §2.1 G](02-runtime.md)).

## 4.8 Liquidation victims

`stress.victimCount` (0 = off), `stress.victimHf0` (1.10), `stress.victimWethWei`. Aave positions are opened on seed-derived addresses. They are **not scored**, so they are a profit source for a liquidator agent.

### Coupled calibration

| Requirement | Condition | Example |
|---|---|---|
| The position can be opened | `HF0 ≳ LT / (0.97 × LTV)` | ≈1.08 for Arbitrum WETH (LT=0.84, LTV=0.80). Below that, borrowing pins to the LTV edge, so it fails fast |
| The position can be breached | crash `m > (HF0 − 1) / HF0` | HF0=1.10 needs m > 9.1% → `[0.12, 0.16]` breaches reliably |

A configuration that cannot breach emits `stress_calibration_warning` (it does not throw). A silently reverted borrow is caught by verifying the debt during setup.

### Fresh state

A soft reset leaves the previous run's victim positions standing and breaks the health-factor computation, so one of the following is required (or it throws).

- Fork: a full re-fork (`ARB_RPC_URL` set, `run.skipReset` not set)
- Local deploy: the clean cross-section `resetFork`'s snapshot/revert provides

Locally, the Aave oracle is calibrated to the initial fair price before victims are opened (a fork's implicit "oracle ≈ spot ≈ fair0" does not hold). The coordinator does this automatically.

**Victim addresses are distributed to the liquidator agent** through `ERIS_LIQUIDATION_VICTIMS` ([01 §1.3](01-architecture.md)).

## 4.9 Configuration validation (fail-fast)

`parseStressEvents` (`events.ts:616`) throws before the run starts.

| Check | Rule |
|---|---|
| type | Anything outside the nine is rejected |
| `stable` | Required for `depeg`, forbidden elsewhere |
| `side` | `whale` / `cexDrift` only; `buy` / `sell` / `random` |
| `persist` | `depeg` / `eusdDepeg` only, and `decayBlocks: 0` |
| `repriceAnchor` / `kappaMultRange` | `cexDrift` only |
| `trendCorrelation` (0..1) / `persistBlocks` (integer ≥1) | `flowTrend` only |
| `venue` | `whale` / `liquidityPull` only; one of the three AMMs |
| `magnitudeRange` | `min > 0`; `max < 1` for `lstSlash` / `liquidityPull` / `eusdDepeg` / `depeg` |
| `windowFrac` | Within `[0,1]` |
| ramp/hold/decay | Non-negative integers; a positive total for non-point events |
| `alignWith` | A real type, a different type, and not itself aligned |

The coordinator adds its own startup checks ([02](02-runtime.md)):

- A `whale` pointing at a venue this run did not enable → throw
- `eusdDepeg` without `liquity` → throw
- `depeg` without local deploy → throw
- `depeg` naming a stable this run does not price from a market → throw (a stable with no market is scored at $1 whatever the event does)
- A liquidityPull or depeg using the deployer account while an agent is bound to the same address → throw

## 4.10 Events emitted

| type | Meaning |
|---|---|
| `stress_schedule` | The whole resolved schedule plus `runStartBlock` (so windows can be judged in absolute blocks) |
| `stress_calibration_warning` | The crash magnitude may not breach a victim's health factor |
| `stress_victims_setup` / `stress_victim_hf` | Victim opening health factors / their movement inside a window |
| `stress_liquidation` | A drop in victim debt, detected as a liquidation |
| `stress_whale_funded` / `stress_whale` / `stress_whale_failed` / `stress_whale_reverted` | Funding, firing, failure, and **on-chain revert** |
| `stress_liquidity_pull` (`_setup` / `_failed`) / `stress_liquidity_restored` (`_incomplete`) | Depth withdrawal and restoration |
| `stress_eusd_depeg*` / `stress_depeg*` (`_setup` / `_capped` / `_failed` / `_restored`) | The depeg stages |
| `lst_slash_failed` / `lst_apy_changed` | The LST side |
| `stress_run_time_limit_disabled` | The time limit was auto-disabled |

**Why `stress_whale_reverted` is separate**: a whale goes through the ordinary relay, which catches **submission** errors — but **an on-chain revert is not an error**. The transaction lands, the schedule says the whale fired, and only blocks.csv shows nothing happened. A missing approval once degraded this regime into calm with every log looking healthy.

**`crash` / `spike` / `cexDrift` / `flowTrend` leave no per-block record** (they change the price walk itself), so the dashboard never says "never fired" — it says "look at the price chart" ([09](09-dashboard.md)).

## 4.11 The official regimes

In `config/regimes/`, referenced by the scenario matrix.

| Regime | Contents |
|---|---|
| `calm` | No events |
| `cex-drift` | Drift on the OU, weakened mean reversion |
| `informed-flow` | Correlated directional flow |
| `whale` | A single large point event |
| `lending-incident` | A crash plus victims plus liquidations plus a pull in the same window |
| `crash` | A price gap with a pull in the same window (three venues thin at once) |
| `depeg` | A registry stable stops being worth $1 |
| `vuln` | Pools appear mid-run, most of them rigged (ADR 0014) |

`cex-drift` and `informed-flow` are expressed as **windowed events** (`cexDrift` / `flowTrend`) rather than run-wide settings. Measured (seed 101, 360 blocks, mean pool-to-fair gap in bps):

| Regime | Run-wide | Windowed | calm reference |
|---|---|---|---|
| `cex-drift` | **1,055 bps** (fair ran away +34.6%, venue-arb +8,458) | **461 bps** (fair −5.1%, venue-arb +1,191) | 39 bps |
| `informed-flow` | 45.0 bps | 42.7 bps | 39 bps |

**Run-wide, `cex-drift` was broken at the length it declares** — over 60 blocks the same settings read as a sane 55bps, which is how it survived unnoticed. Windowing is both the undisclosed schedule and the fix that bounds the runaway inside a trapezoid.

**All seven deploy every venue, `lst` and `liquity` included.** A five-venue variant of each used to sit beside a seven-venue `full-*` one; the five-venue set was retired rather than kept as a second answer to what the competition is. `config/regimes/{lst,liquity,liquity-crash}.yaml` remain outside the set for **single-venue verification** — that is about regimes, not about which venues exist.

**A week built from one kind of event only makes work for one kind of strategy.** Measured: in a depeg-only week, venue-arb made no trades in three of five seeds ([`docs/scoring-metric-measurements.md`](../../scoring-metric-measurements.md)). That is why `cexDrift` and `flowTrend` became windowed events at all — a continuous economy cannot inject "a week that drifts", because the week is one run containing several episodes on an undisclosed schedule.
