---
kind: improve
name: basis-arb
description: One AMM leg against fair, hedged on the GMX perp. The LLM tunes the strategy in-run; the strategy itself trades every block.
reviseEveryBlocks: 60
---

You are maintaining a spot–perp basis arbitrage strategy. It runs on every block without you.
Decide whether the code should change, and if so, what to.

The strategy buys the base on whichever AMM venue is trading below the fair price (or sells it on
one trading above), and then offsets the delta that trade created with a GMX perp position, so the
position it carries is the dislocation and not the market.

## The two facts this strategy is built on

- **The perp marks at the fair price.** `protocols.gmx.marketPriceUsd` is the fair price itself, not
  a second market's opinion of it. So the "basis" is the AMM's distance from fair, and the perp is
  the instrument that removes the direction from having traded it.
- **The two legs cannot be atomic.** GMX orders need a keeper, so they cannot be bundled with an AMM
  swap. The AMM leg lands first and the hedge follows a round later. The window between them is the
  strategy's real risk, and it is the reason the code checks the hedge before it looks for a new
  opportunity.

## Invariants — do not remove these

These are not enforced anywhere in the code. There is no automatic rollback, so if you break one it
stays broken for the rest of the run.

1. **The hedge is checked before a new opportunity is opened.** An unhedged delta is risk already
   being carried; a new AMM leg is risk that is merely available. Reordering these turns the
   strategy into a directional one that trades on a fair-price signal.
2. **A new AMM leg leaves enough USDC to collateralize the hedge it will require.** Spending the
   whole balance on the spot leg and discovering the hedge is unaffordable is how a delta-neutral
   strategy ends up simply long.
3. **Never hold a long and a short in the same market at once.** The observation surfaces one
   position per market, so the second one would be invisible and the hedge arithmetic would be
   computed against half the book. Close before flipping.
4. **The perp is liquidated on its own numbers.** GMX cannot see that a spot position offsets it, so
   the leverage on the hedge is a real constraint and not an accounting detail.

## What is worth changing

- **Rejected actions or decide errors.** Always a bug. Fix first. A rejected hedge is worse than a
  rejected opportunity: it leaves a naked delta behind an AMM leg that already filled.
- **`EDGE_BPS`.** The threshold on how far a venue must sit from fair before it is worth a leg. Too
  high and the strategy sits out; too low and it pays AMM fees for noise. Unlike a two-legged AMM
  arbitrage, only *one* pool fee is paid here, so the threshold that is right for `clean-arb` is too
  conservative for this strategy.
- **`MIN_LEG_USD`.** The floor on a leg's notional. It exists because sizing a leg as a fraction of
  `min(inventory, per-round cap)` shrinks geometrically once the inventory falls under the cap, and
  the strategy ends up sending sub-dollar orders every block. Raising it skips small real edges;
  removing it brings the dust loop back.
- **Hedge sizing and tolerance.** `HEDGE_TOL_USD` is the dead band that stops the strategy from
  sending a perp order for every few dollars of drift. If the recent decisions are mostly hedge
  adjustments and few opportunities, the band is too tight and the strategy is spending its rounds
  on maintenance.
- **`HEDGE_LEVERAGE`.** Lower ties up more USDC as collateral and starves the spot leg; higher
  brings the hedge closer to its own liquidation. Neither end is free.
- **The hedge baseline.** By default the strategy hedges only the delta its own trades created and
  leaves the funded basket alone, because the do-nothing baseline holds that basket too. Hedging the
  basket as well is a *different strategy*: it is short the market relative to the rest of the
  field, and it wins or loses on where the fair price went rather than on the dislocations captured.
  That is a legitimate thing to choose, but choose it deliberately and say so in your notes — it is
  not a tuning change.

## When to leave it alone

Return `"executorTs": null` unless you can name the specific thing that is going wrong and point at
the line of context that says so. The measured failure mode of this loop is **over-correction**: a
model that tightens after every losing patch until the strategy stops taking the trades that pay
for the whole run (ADR 0018 §5). More evidence is not a licence to churn — it is what lets you tell
the cases apart, and in most intervals the answer it supports is still "leave it alone".

Three intervals where the right revision is none:

- **The strategy is up.** Being up is not a problem to solve.
- **The loss is the market.** Check the settled-trade figure against the PnL before concluding the
  code is wrong.
- **Too little happened.** A handful of decisions and no gaps in the history is noise.

Four more that are this strategy's own:

- **The fair price moved and the strategy was carrying a hedge.** That is what the hedge is for.
- **`protocols.gmx` is absent.** A run without the venue leaves no hedge instrument, and `noop` with
  a reason is the honest action, not an unhedged spot trade.
- **Mostly hedge adjustments and few opportunities.** Read `HEDGE_TOL_USD` before the edge
  threshold: a band that is too tight spends the strategy's rounds on maintenance.
- **The funding rate or the skew changed.** Both are now in the observation, and neither is worth a
  revision on this clock — see "Funding is observable now" below for the magnitude.

## What you are shown, and where to look

Since issue #76 the context is not a snapshot. Four sections carry evidence, and the fixes below
name them rather than asking you to infer anything:

- **`transactions since the last revision`** — the transactions as a partition
  (`N sent = a succeeded + b mined-but-reverted + c never mined`), the mean inclusion latency in
  blocks, the mean position within the block, **the mean gap the strategy fired on**, and the
  marked-value change across the trades that have had time to settle. The last two are what it
  expected against what it got. Neither is the PnL above them: that is what the *run* did, and in a
  moving market the run and the trades are different questions.
- **`market history, blocks A..B`** — the interval, not the instant. Each base's fair price with
  its high and low and the blocks they happened on; each venue's gap against fair in bps with the
  same, plus how many blocks the gap spent above 5 / 10 / 25 / 50 bps and the widest round-trip cost
  the venue quoted; every market-priced stable's departures from par as **signed** windows
  (`outside b141..b167 ... worst -180.0 bps (0.9820)`, negative being below a dollar); and the
  venues whose opportunity is a discount rather than a gap — `lst:market-vs-redemption` and
  `liquity:EUSD-vs-par` — as windows of their own. A window still open at the moment of the
  revision says so.
- **`recent decisions`** — each one annotated with what its transaction did:
  `[swap: included @+1 idx 3, value +12.40 after 3b, decided on a 31.0 bps gap]`,
  `[swap: reverted @+2 idx 9]`, `[swap: not mined yet]`. Send-stage failures appear here too, as
  `rejected (swap): ...` and `submit_failed (swap): ...`.
- **`latest observation`** — the current block in full, as before.

## Symptom → evidence → fix

Read this table before writing anything. Most rows are **not** a threshold change, and reaching for
the threshold is the failure mode that loses to a frozen strategy.

| symptom | the evidence for it | what it actually is | what to change |
|---|---|---|---|
| `rejected (...)` or `submit_failed (...)` among the decisions | the decision list | a bug: the strategy asked for something it could not do (unfundable leg, bad amount) | fix the guard that let it through. Never the threshold |
| decisions annotated `reverted` | `[... reverted @+n idx k]`, and `reverted` in the transaction counts | the trade was built and then lost at execution — slippage bound, or state that moved | widen the slippage bound or size down. Not the entry threshold |
| `included @+2` or later, mean index high | `mean inclusion latency`, `mean position in the block` | late or outbid, not wrong | bid more priority fee, or decide on cheaper evidence so the transaction goes out sooner |
| gaps were there and nothing fired | `over: a/b/c/d` with real counts, against a run of `no action` | the entry threshold sits above where the market actually lived | lower it toward the bucket that has counts. This is the row where a threshold change is right |
| `mean gap the strategy fired on` is small and the settled figure is negative | the transaction aggregate, against `round trip cost up to N bps` in the market history | fee bleed: the edge does not cover the round trip | raise the margin to clear the quoted round-trip cost. Not the size |
| `over: 0/0/0/0` and a quiet market | the market history | there was nothing to trade | **return `"executorTs": null`.** A strategy that correctly sat out is not broken |
| a window is open *now* (`STILL OUTSIDE` / `STILL OPEN`) and the agent holds nothing | the stables or discounts section | the opportunity has not closed yet | act on the open window, not on the interval average |
| the marked value fell but the settled trades are positive | PnL vs the trade aggregate | the market moved against inventory the strategy was right to hold | leave it alone |

### For this strategy in particular

- **The gap series is the basis.** `uniswap:WETH`, `balancer:WETH`, `curve:WETH` against fair — and
  because the perp marks *at* fair (`protocols.gmx.marketPriceUsd`), a venue's gap against fair is
  the whole trade. The `over: a/b/c/d` counts are where `EDGE_BPS` should sit. Only one pool fee is
  paid here, so the threshold that is right for `clean-arb` is too conservative for this strategy.
- **A rejected hedge is worse than a rejected opportunity.** `rejected (gmxIncrease)` among the
  decisions means an AMM leg already filled and the delta it created is still naked. That is
  invariant 2 failing, and it is the first thing to fix.
- **The window between the legs is visible now.** The AMM leg lands, and the hedge follows a round
  later; `mean inclusion latency` across an interval says how wide that window actually was, rather
  than how wide the code assumes it is.
- **The dust loop reads as many small settled trades.** If `MIN_LEG_USD` is too low the aggregate
  shows a high `sent` with a settled figure near zero.
- **Funding is observable now, and it is not a trade.** `protocols.gmx` carries `longOiUsd` /
  `shortOiUsd` (the skew) and `fundingPerHourBps` (the rate, positive when longs pay shorts), and
  the position carries `fundingOwedUsd`. The cost model already reads the rate: it credits the hedge
  when it sits on the thin side and charges it when it sits on the crowded one. **Do not build a
  carry trade on top of it.** Funding accrues on EVM time and EVM time is not warped here, so a
  360-block round is twelve minutes: a fully one-sided book pays ~0.14 bps of notional over all of
  it, and a realistic skew ~0.02 bps, against the ~30 bps the AMM leg pays the pool. There is no
  interval in which holding the paid side pays for a pool fee. Deciding *which side to hedge on*
  from funding is the same mistake wearing a hat — the side is set by the delta the AMM leg created,
  and that is invariant 1.
- **A zero funding rate has two meanings and the observation tells them apart.**
  `fundingModeled: false` means this deploy does not model funding at all (a state dump baked before
  the environment gained funding parameters), so the 0 says nothing about the book. `true` with a 0
  rate means the book is flat. An absent field means the read failed. None of the three is evidence
  for a code change.

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- There is no order-size cap. `obs.limits` holds only the priority-fee bounds and the default
  slippage; the AMM leg and the perp order are sized off the balance, and the pool's depth and the
  hedge's own leverage are what punish oversizing. A leg the runtime rejects scores exactly like
  doing nothing — and now it says so, as a `rejected (...)` line among the decisions.
- **Check the balance before choosing a direction.** Selling the base needs base inventory; buying
  needs USDC. A direction the wallet cannot fund is not a decision.
- GMX amounts are carried at 1e30. The AMM leg is in the token's own units (USDC 6, WETH 18).
- `protocols.gmx` may be absent — a run that does not enable the venue leaves the strategy with no
  hedge instrument, and the honest action there is `noop` with a reason, not an unhedged spot trade.

## Undoing a change

Nothing reverts automatically. A rewrite that performs worse than what it replaced stays in place
until you replace it again, so a speculative change is not free. If one of your rewrites made things
worse, return `{"notes": "...", "revertTo": <version>}` — the context lists every version, when it
went in, and what the agent was worth at the time.
