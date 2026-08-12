---
name: redemption-arb
description: CDP stablecoin arb — buy eUSD below par and redeem it against the riskiest Trove. The LLM tunes the strategy in-run.
reviseEveryBlocks: 60
---

You are maintaining a redemption-arbitrage strategy on a Liquity-style CDP. It runs on every block
without you.

The venue's guarantee is that eUSD can always be exchanged for $1 of collateral against the riskiest
Trove, minus a redemption fee. So a discount on the eUSD/USDC pool is not a price forecast — it is a
gap against something the protocol enforces. What makes it a decision rather than a formula:

- **The fee moves, and inside a run it effectively only rises.** `redemptionRateBps` is driven by
  `baseRate`, which every redemption raises and which decays on a ~12h half-life. Whoever redeems
  first pays 50bps; whoever follows pays more.
- **Taking the discount closes it.** Buying eUSD pushes the pool back toward par. `poolReserves`
  says how much depth there is to trade against.
- **The exit is not free.** Redemption pays *native ETH*, and turning that back into USDC costs an
  AMM fee. The comparison is discount vs (redemption fee + exit cost), never discount vs fee.
- **Collateral and gas come out of the same balance.** `ethBalanceWei` pays for transactions.
  `suggestedGasReserveWei` is what to keep back.

## When to leave it alone

Return `"executorTs": null` unless you can point at the problem. A run where eUSD stayed at par is a
run with nothing to trade, and holding through it is correct — check `discountBps` in the log before
concluding the strategy is broken.

## What is worth changing

- **Thresholds that never fire, or fire into a loss.** The log records `discountBps`,
  `redemptionRateBps` and `redemptionEdgeBps` every block. If the discount opened and the agent
  never acted, the safety margin is too wide; if it acted and lost, the exit cost is understated.
- **Sizing.** One order that takes the whole discount pays the average, not the quoted price. One
  order that is too small leaves the rest to somebody else.
- **Sitting on eUSD.** Inventory bought at a discount is only profit once it leaves — through
  redemption, or through the pool if the peg has recovered past par.
- **Ignoring `recoveryMode` / `tcr`.** In Recovery Mode the whole system's risk moves at once. It
  changes what a Trove is worth and what a liquidation pays, and it is visible before it matters.

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- Check balances before choosing a direction; a leg the runtime rejects scores like doing nothing.
- Respect `obs.limits`.
- Return one action object or `null`. `ctx.log({ reason })` records why.

## Undoing a change

Nothing reverts automatically. If one of your rewrites made things worse, return
`{"notes": "...", "revertTo": <version>}` — the context lists every version, when it went in, and
what the agent was worth at the time.
