---
kind: improve
name: sp-underwriter
description: CDP underwriting — deposit eUSD into the Stability Pool, liquidate what falls under MCR, and bank the collateral.
reviseEveryBlocks: 60
---

You are maintaining a Stability Pool underwriting strategy on a Liquity-style CDP. It runs on every
block without you.

A Stability Pool deposit is not a yield position. It sits idle until a Trove falls under a 110% ICR,
and then it is *spent*: the pool burns the deposited eUSD against that Trove's debt and pays out the
collateral that backed it. Because liquidation only happens below 110%, the collateral is worth more
than the debt it cancelled — that difference is the entire return, and a run with no liquidations
pays nothing at all.

Three separate decisions:

- **Depth.** `spShareBps` is the share of the next liquidation this agent receives. Deposited eUSD
  cannot be used for anything else while it is in the pool.
- **Whether to liquidate.** Liquity's liquidation is permissionless and pays the caller a gas
  compensation plus 0.5% of the collateral — and nothing in the pool pays out until somebody makes
  the call. `riskiestTrove.icr` against `mcr` is the whole trigger. The oracle is one block stale
  for everyone, so a Trove barely under the line may be back above it by the time the call lands;
  that attempt reverts and costs gas.
- **When to take the ETH.** `spEthGainWei` accrues as collateral — a price bet the agent never
  chose. Withdrawing `"0"` claims it without touching the deposit.

Recovery Mode (`recoveryMode`, below a 150% system TCR) changes the game: a Trove becomes
liquidatable once its ICR is under the *current* TCR rather than under 110%, so the pool can be
spent far faster than usual. Two things change with it — the payout is capped at 110% of the debt
(the borrower keeps the surplus), and the liquidation only goes through if the pool can absorb that
Trove's whole debt.

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

- **A reverted `liquidate` is the signature failure here**, and the annotation now separates it from
  a liquidation that never fired. `[liquidate: reverted @+1 idx 2]` means the Trove was back above
  the line by the time the call landed: the margin is too thin for a one-block-stale oracle, and the
  fix is the margin, not the frequency. `[liquidate: not mined yet]` repeated means the call is not
  getting into blocks at all.
- **Losing the race is different again.** A liquidation that reverts at a high `idx` while somebody
  else's succeeded is a priority-fee loss. Compare `mean position in the block` across intervals
  before assuming the trigger is wrong.
- **Underwriting at a premium** shows as a *positive* worst in the `EUSD` par window, or as a
  negative `liquity:EUSD-vs-par` discount: the pool is paying above par, and the liquidation
  discount has to earn that back before anything is profit. The sign is the whole signal — read it,
  do not read the magnitude alone.
- **An unclaimed ETH gain** is directional exposure the strategy never decided to take. It is
  visible in the marked value drifting with the fair `WETH` series while the settled trades are flat.

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
