[← Index](README.md) | [← 02 Execution model](02-runtime.md) | [04 Stress events →](04-stress-events.md)

# 03. The market

The environment moves the market through exactly three channels: **generating and distributing the fair price**, **the flow bot's orders**, and **the keeper's execution**. Stress events ([04](04-stress-events.md)) ride on the first two.

## 3.1 The fair-price model

### 3.1.1 The step

Source: `sdk/src/rng.ts:108`, `nextFairPrice`. A discrete mean-reverting (OU-type) update.

```
shock  = (rng.next() − 0.5) × 2 × volatility
revert = kappa × (anchor − current) / current
next   = max(100, current × (1 + drift + revert + shock))
```

| Parameter | Config key | Default | Meaning |
|---|---|---|---|
| `volatility` | `market.volatility` | 0.004 | Width of the uniform per-block shock |
| `kappa` | `market.kappa` | 0.02 | Strength of the pull back to the anchor |
| `drift` | `market.drift` | 0 | A constant direction |

Per-base overrides are `market.baseVolatility` / `baseKappa` / `baseDrift`, written as `{WBTC: ...}`.

`anchor` is **the base fair price at the start of the competition** and is fixed for the run — except that a `cexDrift` episode moves it (§3.1.4).

**The generator is an LCG** (`state = (1664525·state + 1013904223) mod 2³²`). `gaussian()` is Box-Muller, `lognormal(mean, σ)` sets `μ = ln(mean) − σ²/2` so the expectation equals `mean`, and `poisson(λ)` uses Knuth's method.

### 3.1.2 Why mean reversion

Under a geometric random walk with drift, **each seed picks up a trend, and that cumulative directional exposure (β) dominates PnL, so "random trading ≈ smart arbitrage"** (`rng.ts:59-64`, ADR 0003). Making the process mean-reverting and pulling it back to the anchor returns the price near its start by the end of the run, so direction pays nothing. What is left is the arbitrage skill (α) of reading the gap between the pool and fair.

### 3.1.3 Multi-asset

Each base has **its own independent Rng** (`rng.ts:135`, `priceRngForAsset`). WETH uses salt 0, i.e. `Rng(seed)` itself (byte-identical to existing runs' WETH path); every other base gets an independent stream from a deterministic symbol-derived salt.

**Cross-asset correlation is zero** (v1). Adding it means consolidating onto a shared Rng, which changes WETH's consumption sequence and breaks backward compatibility, so it is not done by default.

### 3.1.4 Base price and effective price

The core of ADR 0009 §1.

```
baseFair  ← stepped by the OU (stress events never touch it — cexDrift excepted)
effective ← baseFair × overlay.wethMult (the multiplicative distortion of a stress event)
```

Outside every window `overlay = 1`, so β ≈ 0 is preserved (ADR 0007 is not compromised). **The effective price propagates consistently to the PriceFeed, the Aave oracles, GMX and scoring.**

There are two exceptions ([04 §4.4](04-stress-events.md)).

- **`cexDrift`** changes **the walk itself** rather than overlaying it (it adds drift and weakens mean reversion via `kappaMult`). As an overlay, mean reversion would erase the episode the moment the window closed.
- **`repriceAnchor`** moves the anchor, so the level reached becomes the new normal.

### 3.1.5 Distribution and the one-block lag

| Path | Covers | Implementation |
|---|---|---|
| The `PriceFeed` contract | Fair price for every base | `core/src/realtime/priceFeed.ts`; reads via `sdk/src/priceFeed.ts` |
| Aave `MockAggregator` | WETH / USDC / extra bases / market-priced stables / the LST | `sdk/src/protocols/oracles.ts` |
| GMX `MockOracleProvider` | Index market prices | `ctx.updateGmxOracle` |
| Liquity `LiquityPriceFeedAdapter` | The price Troves are marked against | Swapped per run by `core/src/realtime/liquity.ts` |

There are **three write paths**, chosen by profile (`oracles.ts`).

| Function | Mechanism | Used for |
|---|---|---|
| `updateOracles` | `sendAndMine` (synchronous) | Setup, prewarm, external calibration |
| `updateOraclesMempool` | `sendNoMine` with a high priority fee | The default profile, every block |
| `writeAaveOraclesStorage` | `setStorageAt` (cheatcode) | The `economicGas` profile (removes the front-run target) |

**The write lands in the next block**, so what an agent can observe is one block old. This applies to everyone equally by design ([00 §0.5 P2](00-overview.md)) and has two consequences.

- Liquidations on Aave and Liquity lag by **two blocks**: the price moves, the next block is the first an agent can observe it in, and the transaction lands in the one after. One block of observation, one of mempool — the same for every venue.
- **The LST's Aave price is `WETH × the redemption rate`**, and inherits the same one-block lag (`oracles.ts:15-25`). A slash hits the vault first and reaches health factors a block later — which is what makes it the start of a liquidation cascade.

### 3.1.6 Ordering inside a block

Decided by `--order fees` (descending priority fee). In the default profile the environment bids above every agent cap, which pins **the oracle update at txIndex 0 and the keeper just below it** ([02](02-runtime.md)). `npm run check:ordering -- --live` measures whether that assumption actually holds ([11](11-invariants.md)).

## 3.2 Orderflow

### 3.2.1 Process shape

The flow bot is an **independent process** (`core/src/flow/market-maker.ts`) whose generation logic is pure (`core/src/flow/logic.ts`).

- **The bot never touches RPC.** The coordinator pushes a context down stdin every block, and relays each order the bot writes to stdout into the mempool, signed by a flow wallet.
- It runs deterministically off its own `Rng(flow.seed)`, calling the generators in the protocol order the coordinator passes (default `uniswap, balancer, curve, gmx, aave`).
- Aave reserve state is read by the environment and passed in the context (the bot cannot read it).

### 3.2.2 AMM flow (uniswap / balancer / curve)

`buildAmmFlow` (`logic.ts:247`). Each venue gets **two kinds** of order: uninformed (opening a gap) and informed (closing it).

**Uninformed (noise traders)**

| Element | Rule | Default |
|---|---|---|
| Arrivals | `Poisson(λ)`; with λ=0, a fixed `uninformedCount` | λ = 0.9 |
| Size | `lognormal(mean = max×0.5, σ)` clamped to `[2%, 300%]`; with λ=0, uniform over `max/20 .. max` | σ = 1.0 |
| Direction | With `persistBlocks > 1`, fixed per window of `floor(round/persistBlocks)` by `trendBit(flowSeed, window, venue)`; otherwise `rng.bool()` each time | persist = 1 |
| Correlation | With probability `trendCorrelation`, follow a **market-wide** bit instead of the per-venue one | 0 |
| Priority fee | `default + [1,50) × 10⁶ wei` | |

`trendCorrelation` only bites when `persistBlocks > 1` (without a persisted direction there is nothing to correlate). The per-venue bit manufactures a **cross-venue spread**; the market-wide bit **pushes the whole market one way** — and there an agent has to take a side rather than arbitrage the middle (ADR 0017 regime 2, `informed-flow`).

**Informed (the arbitrage side)**

```
rawDeviation = |fair/pool − 1|
if (feeBps > 0 && rawDeviation×10000 <= feeBps)  → emit nothing (the no-arb band)
effectiveDeviation = max(0, rawDeviation − feeBps/10000)
size = informedMax × min(1, effectiveDeviation × 20)
```

`flow.informedArbFeeBps` (30bps by default) expresses "inside the fee band arbitrage does not pay, so do not close it". **A residual equal to the fee band is left standing**, so the market is never fully closed to fair each block — which is what leaves agents something to take. The priority fee is `default + [50,100) × 10⁶ wei`, above the uninformed side.

Under USDC-only funding the flow wallets hold no base either, so base-selling orders fall over to buying with USDC.

### 3.2.3 GMX flow

`buildGmxFlow` (`logic.ts:440`).

- Count: `Poisson(λ)` (0.75 by default); with λ=0, a `Bernoulli(activityProb)` gate and a uniform burst of `1..maxBurst`
- Size: `lognormal(mean = gmxMax×0.025, σ)` clamped to `[0.5%, 10%]`
- Collateral: `sizeUsd/2` converted at roughly 2100 USD/ETH (≈2× leverage)
- On a block with no WETH inventory it emits one USDC→WETH preparation swap and stops

### 3.2.4 Aave flow

The realtime path is an **actor pool** (`buildAaveActorsFlow`). `flow.aaveActorCount` independent addresses hold **persistent positions**, and each acts once per block with probability `flow.aaveActivityProb` (supply / borrow / repay / withdraw). The maximum simultaneous borrows in one block is the actor count — which arises naturally from having separate actors.

`flow.aaveActorSizeSigma` (1.0 by default) spreads each actor's target collateral lognormally (whales and minnows). Borrowing tracks each actor's 30% LTV of collateral, so health-factor safety is unchanged.

Actors are endowed with collateral WETH directly: a USDC→WETH preparation swap tends to fail on slippage, and the actor never secures collateral and never reaches borrowing. That collateral sits in a non-scored flow wallet, so it never affects an agent's β.

### 3.2.5 What is and is not deterministic

| Deterministic | Not deterministic |
|---|---|
| The price path (a pure function of the seed) | Transaction arrival timing |
| The stress schedule (likewise) | In-block order among equal fees |
| The flow bot's orders (a pure function of flowSeed) | Whether an order actually fills (depends on the book) |

So **the same seed still produces different results** ([00 §0.5 P3](00-overview.md)).

## 3.3 The venues

Enabled through `run.protocols`. `ProtocolId` has seven values (`sdk/src/types.ts:15`).

| id | What it is | What it adds | fork | local |
|---|---|---|---|---|
| `uniswap` | Uniswap V3 | Concentrated liquidity; LP positions (tokenId) | yes | yes |
| `balancer` | Balancer v2 | Weighted pools | yes | yes |
| `curve` | Curve (stableswap-ng / twocrypto-ng) | Stable and crypto pairs; owns `stableSwap` | yes | yes |
| `gmx` | GMX v2 | Perps. **Needs keeper execution**, so it cannot be bundled | yes | yes |
| `aave` | Aave v3 | Lending and liquidation; health factors follow the oracle | yes | yes |
| `lst` | An in-house vault (wstETH-style) + an LST/WETH secondary market | **One asset with two prices** | **no** | yes |
| `liquity` | An unmodified Liquity V1 fork (eUSD) | CDPs, the Stability Pool, redemptions, Recovery Mode | **no** | yes |

`lst` and `liquity` have no Arbitrum counterpart, so they are **local-deploy only** and fail fast at startup on a fork.

### 3.3.1 What the LST venue brings

**One asset with two prices** (`sdk/src/types.ts:460-467`).

| Price | Meaning | Reachable via |
|---|---|---|
| `redemptionRateWeth` | The par the vault owes | The withdrawal queue |
| `marketPriceWeth` | What the pool pays right now | Instantly, at a discount |

The observation reports both, plus `discountBps` / `yieldPerBlockBps` / the queue length / **the effective wait at your own size** (`estimatedQueueDelayBlocks`). Yield accrues on an **economic clock** (`lst.simulatedSecondsPerBlock`, default one block = one hour at 3%/yr), not on EVM time.

The pool's rate-oracle wiring (`stEthPerToken()` registered with asset_type=1) is mandatory: unwired, a rising rate is **a risk-free arbitrage open to everybody**. There is an assert at deploy time and a `lst_setup` check at startup that fails fast above 200bps of divergence.

### 3.3.2 What the Liquity venue brings

The four skills `sdk/src/types.ts:551-560` names.

1. **Redemption arbitrage** — eUSD can always be exchanged for $1 of collateral against the riskiest Trove. A discount is therefore **a dislocation against a price the protocol enforces**, not a forecast
2. **The Stability Pool** — deposit eUSD to absorb liquidation debt and receive collateral at a discount
3. **Recovery Mode** — below CCR (150%) the liquidation threshold stops being MCR: a Trove becomes liquidatable once its ICR is under the *current TCR*. Everyone's line moves at once, in contrast to Aave's per-position health factor
4. **Position in the sorted list** — redemptions walk up from the lowest ICR, so a borrower defends "how much debt is ahead of me"

Only two pieces are ours; the core is unmodified.

- `LiquityPriceFeedAdapter` — Liquity renounces ownership after wiring, so its oracle address is permanent, while every run deploys a new PriceFeed. The adapter sits between them and is repointed each run
- `LiquityRedemptionHelper` — **a partial redemption's hint depends on the execution-time price**. The environment writes the oracle every block and lands ahead of every agent, so a hint computed off-chain is structurally guaranteed to be stale. The helper computes the hint inside the same transaction that pins the price via `fetchPrice()`

Liquidation needs no such mechanism: `liquidate()` has no value that must match at execution time, so if the price recovers the call simply reverts and wastes gas.

Collateral is native ETH (the forked core takes `msg.value`). Actions are denominated in WETH wei and `buildTxs` prepends `WETH.withdraw` — but **it is the same balance that pays for gas**, so sinking all of it strands the agent with no way to send the closing transaction. The observation surfaces `ethBalanceWei` and `suggestedGasReserveWei` but **does not enforce them** (self-stranding is a legitimate loss).

## 3.4 Token kinds and valuation

`TokenKind` has three values (`sdk/src/types.ts:13`). **The kind decides the valuation route.**

| Kind | Example | Priced by |
|---|---|---|
| `base` | WETH / WBTC | The fair-price feed; swept as spot by the scorer |
| `stable` | USDC / DAI / eUSD | USDC is the numéraire at $1. Anything with a market gets the geometric mean of a two-sided probe |
| `lst` | LST | **Its own venue.** Excluded from the spot sweep |

`lst` is a kind of its own to avoid a double count: as a base, the scorer's spot sweep would price it at face value off the fair feed while its adapter separately marked it at what it could realize. The same asset counted twice is **a wrong number**.

### 3.4.1 Market-priced stables

The mechanism that removed the assertion "a stable is a dollar" (issue #27, `sdk/src/stables.ts`).

- The price is **the geometric mean of a two-sided executable probe**, `sqrt(sell × buy)`. One side alone sticks to the sell side and understates
- If no quote comes back, it **falls back to par and is reported as `par-fallback`**. Silently using par is bad; silently using zero reads as "a 100% discount, i.e. unbounded arbitrage" and is worse
- **USDC is the numéraire at $1.** Every metric is denominated in USDC, so floating it would change what past runs' numbers mean
- `obs.balances.stables[sym].marketQuoted: false` means "no market answered, so par was assumed". **Do not read `priceUsdc: 1` as "the peg held"**
- Which stable is quoted by which pool is owned by `STABLE_MARKET_LEGS` (`sdk/src/constants.ts`). A leg carries a `venue`, so **a stable only exists in a run that enabled its venue** — a stable that is swept but cannot be traded is worse than absent
- **Stables with a market are not distributed by funding.** Handing everyone a stable that is about to break makes the loss β on a position nobody chose. Having to buy it first is the point of the regime

Today the market-priced stables are eUSD (`liquity`) and DAI (`curve`). eUSD has a **redemption floor**, so its discount is an exercisable claim; DAI has none, so its discount is "do you believe it comes back" — a different skill.

## 3.5 Keeping the market arbitrage-free

Calibrated pools must not offer a profitable **executable** cross-venue round trip. If they do, the calibration is broken and ADR 0007's α dominance goes with it.

| When | Check | On breach |
|---|---|---|
| Startup | `noArbFindings` across every venue pair | **Throws** above `STARTUP_FAIL_BPS`; warns above `STARTUP_WARN_BPS` |
| Every block | `NoArbMonitor` watches persistence | Emits `no_arb_persistent_warning` if it keeps holding |

**A transient arbitrage is the α agents are meant to take; a persistent one is structurally broken pricing.** Separating the two is what the monitor is for (`core/src/realtime/noArb.ts`).

A real example: every agent bleeding on WBTC turned out to have two causes stacked — the curve observation pinned to fair, and a one-sided probe bias. twocrypto's dynamic fee had widened the real bid-ask to ~128bps while a flat 30bps correction was being applied, producing a **phantom spread**. The two-sided quote fields (`TwoSidedQuoteFields`) and the measured effective cost come from that fix (`sdk/src/types.ts:393-398`).
