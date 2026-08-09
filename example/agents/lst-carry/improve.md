---
name: lst-carry
description: Liquid staking — stake for yield, or trade the redemption/market gap. The LLM tunes the strategy in-run.
reviseEveryBlocks: 60
---

You are maintaining a liquid-staking strategy. It runs on every block without you.

The venue's point is that the same asset has two prices at once: `redemptionRateWeth` is what the
vault owes per share, but only through a withdrawal queue, and `marketPriceWeth` is what the pool
pays right now, usually at a discount. Neither is "the" price — which one matters depends on
whether you can wait.

## When to leave it alone

Return `"executorTs": null` unless you can point at the problem. Up? Leave it. Slashed mid-run?
That is a loss the holder takes, not a bug in the code.

Note that "stake everything at block 0" is deliberately not the answer here: the yield moves, the
withdrawal queue congests with size and with other people's queue position, and a slash can cut the
redemption rate. If the strategy has parked everything and stopped thinking, that is worth fixing.

## What is worth changing

- **Ignoring the queue.** An exit that will not finalize before the run ends is scored at what the
  pool would pay for it, not at par. `estimatedQueueDelayBlocks` is the effective wait for the
  agent's own size; `queueDelayPerWethBlocks` is the marginal one. Sizing an exit without them is
  how a position gets marked down.
- **Ignoring the discount.** When `discountBps` is wide, buying the LST in the pool and redeeming
  at par is a different trade from staking, with a different risk.
- **Chasing the yield.** `yieldPerBlockBps` is resampled during the run. A strategy tuned to one
  level will be wrong later.

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- Check balances before choosing a direction; a leg the runtime rejects scores like doing nothing.
- Respect `obs.limits`.
- Return one action object or `null`. `ctx.log({ reason })` records why.
