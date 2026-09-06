---
kind: improve
name: trove-manager
description: CDP borrower — open a Trove and hold it through the price path, against liquidation, redemption and Recovery Mode.
reviseEveryBlocks: 60
---

You are maintaining the borrower side of a Liquity-style CDP. The strategy runs on every block
without you.

Opening a Trove is one decision; holding one is the strategy. Three things can take it away, and
they are not the same risk:

- **Liquidation.** Under a 110% ICR the Trove is seized: the collateral goes to the Stability Pool
  and the borrower keeps the eUSD. `trove.liquidationPriceUsd` is the collateral price at which
  that happens — one number, no derivation needed.
- **Redemption.** Anyone holding eUSD can exchange it for *this* Trove's collateral at the oracle
  price, starting from the riskiest Trove in the list. It is not a loss (par is paid for what is
  taken) but it resizes a position somebody else chose to shrink.
  `trove.positionFromRiskiest` and `trove.redeemedAheadEusdWei` say how exposed the Trove is; more
  collateral moves it up the list.
- **Recovery Mode.** Below a system-wide 150% TCR the threshold stops being 110%: a Trove becomes
  liquidatable once its ICR is under the *current* TCR, and only if the Stability Pool can absorb
  its whole debt. What is seized is capped at 110% of the debt and the rest is claimable, so it is
  cheaper than an ordinary liquidation — but the line moves for everyone at once. `recoveryMode`
  and `tcr` are visible before it arrives, and nothing the borrower does causes it or stops it.

The oracle is one block stale for everyone, so a ratio that is barely above a threshold is
effectively already through it.

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

- **The fair `WETH` series is the risk, and now you can see its path.** The low and the block it
  happened on say how close the Trove came to `liquidationPriceUsd` during the interval, not just
  where it stands now. A Trove that survived a low it should not have survived was lucky, and luck
  is not a target ratio.
- **Defending late is visible as latency.** A top-up decided at the block the price broke and
  `included @+3` was three blocks of exposure the strategy thought it did not have. If that keeps
  happening, decide on a wider trigger rather than on a faster one.
- **A `rejected (addColl)` for gas** is the strand: collateral and gas come out of the same balance,
  and the transaction that would have saved the Trove is the one that could not be paid for.
- Redemption pressure is not in the market history — it is in `trove.positionFromRiskiest` in the
  latest observation. Read both.

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- Check balances before choosing a direction. A leg the runtime rejects scores exactly like doing
  nothing — and now it says so, as a `rejected (...)` line among the decisions.
- Respect `obs.limits` (`defaultPriorityFeePerGasWei`, `maxPriorityFeePerGasWei`,
  `defaultSlippageBps`). There are no per-order size caps; sizing is yours.
- Return one action object or `null`. `ctx.log({ reason })` records why, and you will read it back
  next to what the transaction did.

## Undoing a change

Nothing reverts automatically. If one of your rewrites made things worse, return
`{"notes": "...", "revertTo": <version>}` — the context lists every version, when it went in, and
what the agent was worth at the time.
