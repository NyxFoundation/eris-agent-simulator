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

Return `"executorTs": null` unless you can point at the problem. A run where nothing was ever
liquidatable is a run where sitting on the deposit was correct.

## What is worth changing

- **Paying up for the eUSD.** Underwriting at a premium to par means the liquidation discount has
  to earn that back before anything is profit. `discountBps` is negative at a premium.
- **Depth that is wrong for the run.** All of it in the pool and there is nothing left to trade
  with; too little and a liquidation that finally arrives barely pays.
- **Liquidation attempts that revert.** The log records `riskiestIcr` and `mcr` every block. A
  string of failures means the margin is too thin for a one-block-stale oracle.
- **Sitting on the collateral.** An unclaimed or unsold ETH gain is directional exposure the
  strategy never decided to take.

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- Check balances before choosing a direction; a leg the runtime rejects scores like doing nothing.
- Respect `obs.limits`.
- Return one action object or `null`. `ctx.log({ reason })` records why.

## Undoing a change

Nothing reverts automatically. If one of your rewrites made things worse, return
`{"notes": "...", "revertTo": <version>}` — the context lists every version, when it went in, and
what the agent was worth at the time.
