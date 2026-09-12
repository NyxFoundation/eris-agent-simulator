---
kind: improve
name: peg-arb
description: Market-priced stable peg arbitrage — buy a stable below a dollar and sell it back as the peg recovers.
reviseEveryBlocks: 60
---

You are maintaining a peg-arbitrage strategy on the run's market-priced stables. It runs on every
block without you. It had no improvement policy before issue #76, which meant the `depeg` regime —
the one regime whose whole event is a diagnosable dislocation — had no self-improving agent trading
it at all.

The strategy buys a stable that trades below a dollar and sells it back as the peg recovers. Two
thresholds and a size:

  below par by more than `ERIS_PEG_ARB_BUY_BPS`   spend USDC to buy the stable
  within `ERIS_PEG_ARB_SELL_BPS` of par           sell the holding back for USDC

**This is an opinion, not a claim.** eUSD has a floor — a CDP will always exchange it for $1 of
collateral, which is what `redemption-arb` trades. A plain stable has no such thing. All this
strategy has is the belief that the dislocation is a window rather than a repricing, and an agent
still holding at the last block is marked at whatever the pool pays then, not at par. `EUSD` is
deliberately excluded here: redeeming it enforces par and this strategy would take the strictly
worse side of the same event.

`marketQuoted: false` means the price is par by assumption, not an observation. There is nothing to
trade against it.

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
  marked-value change across the trades that have had time to settle, **split in two**: what
  holding the pre-trade inventory at fair prices would have made over the same windows (the
  market's share), and what is left, which is what the trades themselves did. The gap is what it
  expected; `the trades themselves made` is what it got. The raw figure and the PnL above it both
  contain the market's move on inventory the strategy was holding anyway — a rising market is not
  evidence the strategy works, and the `holding the inventory you had then` figure next to each
  PnL line is there to take it out.
- **`market history, blocks A..B`** — the interval, not the instant. Each base's fair price with
  its high and low and the blocks they happened on; each venue's gap against fair in bps with the
  same, plus how many blocks the gap spent above 5 / 10 / 25 / 50 bps and the widest round-trip cost
  the venue quoted; every market-priced stable's departures from par as **signed** windows
  (`outside b141..b167 ... worst -180.0 bps (0.9820)`, negative being below a dollar); and the
  LST's market price against its redemption rate — `lst:market-vs-redemption` — as a window of
  its own. eUSD is a market-priced stable, so its departures are in the stables section and
  nowhere else (negative is below par: a redemption is worth taking; positive is a premium). A
  window still open at the moment of the revision says so.
- **`recent decisions`** — each one annotated with what its transaction did:
  `[swap: included @+1 idx 3, value +12.40 after 3b (market +11.90, trade +0.50), decided on a 31.0 bps gap]`,
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
| `mean gap the strategy fired on` is small and `the trades themselves made` is negative | the transaction aggregate, against `round trip cost up to N bps` in the market history | fee bleed: the edge does not cover the round trip | raise the margin to clear the quoted round-trip cost. Not the size |
| `over: 0/0/0/0` and a quiet market | the market history | there was nothing to trade | **return `"executorTs": null`.** A strategy that correctly sat out is not broken |
| a window is open *now* (`STILL OUTSIDE` / `STILL OPEN`) and the agent holds nothing | the stables or discounts section | the opportunity has not closed yet | act on the open window, not on the interval average |
| the PnL fell but `the trades themselves made` is positive | the `holding the inventory you had then` figure next to the PnL, and the trade split | the market moved against inventory the strategy was right to hold | leave it alone |

### For this strategy in particular

The stables section of the market history is this strategy's entire subject. Read it first.

- **A window with no decisions inside it** — `DAI: outside b141..b167 (27 blocks), worst 0.9820` and
  `no action` throughout — means `BUY_BPS` sits outside where the dislocation actually went. The
  `worst` price is the number to set it against, not the current one.
- **A window the strategy bought into and lost on** means the exit was wrong, not the entry.
  Compare the block it bought against `back inside`: selling after the window closed is selling at
  par into a pool that has already moved.
- **`STILL OUTSIDE` at the moment of the revision** is the case that matters most, because the run
  ends and an unsold position is marked at the pool price. If `blocksRemaining` in the latest
  observation is small and the window is open, the revision to make is about the exit, not the entry.
- **Buying into a window that keeps deepening** is what the fractional size is for. One fill at the
  first threshold, at the worst price of the interval, is the sizing failure this venue produces.
- A recovery that never comes is a legitimate loss. Do not rewrite the strategy into one that holds
  through anything because one window did not close.

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
