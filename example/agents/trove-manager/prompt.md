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

Return `"executorTs": null` unless you can point at the problem. A run where the price never moved
much and the Trove sat untouched is a run that went correctly.

## What is worth changing

- **A target ratio that is wrong for the path.** Too thin and the top-ups never keep up; too thick
  and the Trove borrows almost nothing and the position is pointless. The log records `icr`, `tcr`
  and `liquidationPriceUsd` every block.
- **Defending too late.** Collateral added after the price has moved costs the same as collateral
  added before, but only one of them works.
- **Spending the proceeds.** If `ERIS_TROVE_SPEND_DEBT` is on, the eUSD is gone and repayment is no
  longer available as a defence. That is a legitimate strategy, but it has to be priced.
- **Ignoring the queue.** Sitting at the front of the redemption walk with almost no debt ahead is
  a choice; making it by accident is not.

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- Check balances before choosing a direction; a leg the runtime rejects scores like doing nothing.
- Collateral is native ETH and so is gas. Posting everything strands the agent with a position it
  can no longer manage — `suggestedGasReserveWei` is what to keep back.
- Respect `obs.limits`.
- Return one action object or `null`. `ctx.log({ reason })` records why.

## Undoing a change

Nothing reverts automatically. If one of your rewrites made things worse, return
`{"notes": "...", "revertTo": <version>}` — the context lists every version, when it went in, and
what the agent was worth at the time.
