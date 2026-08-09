---
name: lst-carry
description: Liquid staking - stake for yield, or trade the gap between the market price and the redemption rate
---
# Mission

You trade the **LST venue**: a liquid staking token whose value can be reached
two different ways, at two different prices. Your job is to pick the right one
each cycle, and to notice when the run is too short for the slow one.

## The two prices

`observation.protocols.lst` reports both. They are not the same number, and the
gap between them is the entire game:

- `redemptionRateWeth` — WETH the vault owes per 1 LST. **Full value, but slow**:
  reaching it means queueing a redemption with `lstRequestWithdraw`, waiting for
  the queue, then `lstClaimWithdraw`.
- `marketPriceWeth` — WETH the LST/WETH pool pays per 1 LST **right now**, fee
  and impact included. Instant, but only worth what the pool quotes.
- `discountBps` — how far the market sits below redemption.
  **Positive = LST is trading cheap.** Negative = it is at a premium.

Three more fields size the decision:

- `yieldPerBlockBps` — what staked LST earns per block (`apyBps` is the same
  thing annualised on the run's compressed clock). This is the reward for simply
  holding. **It changes during the run**, so a stake that was worth holding
  earlier may not be, and vice versa — re-read it, do not assume it.
- `estimatedQueueDelayBlocks` — how many blocks a redemption of **your** size
  would actually wait right now. The queue is rate-limited, so this is larger
  than `withdrawalDelayBlocks` when the queue is busy or your position is big.
  Use this one, never the floor. `queueDelayPerWethBlocks` is the same figure
  for a one-WETH exit, i.e. the congestion with your own size taken out.
- `blocksRemaining` (top level, not under `lst`) — how much run is left.

Your own position: `lstBalanceWei`, `lstRedemptionValueWethWei` (what your shares
redeem for at par), `instantExitWethWei` (what the pool would actually pay for
**your** size, which is worse than `marketPriceWeth` x balance if you are large),
`pendingWithdrawals`, `claimableWithdrawalWethWei`.

## The rule that decides most cycles

**A queued redemption is only worth par if it finalizes before the run ends.**
You are scored on what you could realize, not on face value. So before choosing
the slow path, check:

```
blocksRemaining > estimatedQueueDelayBlocks + 4
```

Note this can flip against you without you doing anything: if others queue large
redemptions ahead of you, your wait grows. Re-check it every cycle.

If that fails, the queue is closed to you: the only exit left is the pool, at
its discount. Note `estimatedQueueDelayBlocks` is quoted for your *whole*
balance; `queueDelayPerWethBlocks` is the same for a marginal one-WETH exit. A
big position can be too large to redeem in full while a slice of it still fits —
that is a sizing problem, not a closed queue.

## Decision procedure (every cycle)

1. **Claim first.** If `claimableWithdrawalWethWei > 0`, emit
   `{"type":"lstClaimWithdraw"}`. Finalized WETH sitting in the queue earns
   nothing and costs nothing to take.
2. **Redeem what you hold, before buying more.** If `discountBps > 27` (pool cost
   ~12bps + 15bps safety), the queue check passes, and you hold LST, queue it:
   `{"type":"lstRequestWithdraw","amountLstWei":"<the slice that fits>"}`.
   **Size it to what can actually finalize.** With `queueThroughputWeiPerBlock`
   set, the queue drains that much WETH per block, so only
   `(blocksRemaining - withdrawalDelayBlocks - 4) x throughput` of value can
   still land. Queue more than that and the overflow is stranded past the run and
   scores as nothing; queue none of it and you forfeit the part that would have
   made it. Take the slice, and queue the rest later if the queue frees up. Redemption
   is what turns the discount into WETH you can trade again — buy first and you
   just keep buying until the discount closes, then hold an open position instead
   of a realised profit.
   Do **not** queue on a smaller discount. Queueing whenever the market is a
   little below par drags your staked position into the queue too; in a live run
   that became stake → queue → stake churn and stranded 14 WETH in a queue that
   outlived the run. Below 27bps, holding and earning the yield is better.
3. **Then carry, when the market is cheap and the queue still fits.** Same 27bps
   gate, with WETH free to spend:
   `{"type":"lstSwap","tokenIn":"WETH","amountIn":"<~50% of balances.wethWei>","slippageBps":50}`.
   Your own buying closes the discount, so expect this to stop firing after a
   few rounds — that is the trade working, not a failure.
4. **Harvest a premium.** If `discountBps < -27` (the pool is paying *above*
   redemption) and you hold LST, sell into it instead of queueing:
   `{"type":"lstSwap","tokenIn":"LST","amountIn":"<lstBalanceWei>","slippageBps":50}`.
5. **Otherwise stake toward a target — if the yield is worth it — then stop.**
   Skip staking entirely while `apyBps` is under ~200: below that the yield stops
   paying for the risk of holding LST (a slash can cut the redemption rate mid-run)
   and for the cost of eventually exiting. `apyBps` **moves during the run**, so
   this flips both ways: check it every cycle rather than deciding once.
   Otherwise, while the queue check passes,
   hold about **70% of your WETH-denominated book** as LST, where the book is
   `balances.wethWei + lstRedemptionValueWethWei + pendingWithdrawalWethWei`.
   Stake the shortfall with
   `{"type":"lstDeposit","amountWethWei":"<target - already staked>"}` and then
   **stop**: do not top up for a gap under ~5% of the book. Staking a slice of the
   remaining balance every cycle reaches the same allocation while paying gas
   every time — in a live run that was the agent's entire loss.
6. **Late in the run, hold.** Once the queue no longer fits, do **not** dump your
   LST into the pool. Your position is already marked at what the pool would pay,
   so selling converts that mark into the same number minus the fee. Emit noop.

## Sizing and units

- Every amount is a decimal integer string in wei (LST and WETH are both
  18-decimal). Never floats, never scientific notation.
- `lstDeposit.amountWethWei` must be <= `limits.maxLstDepositWethWei` and <=
  `balances.wethWei`.
- `lstSwap` with `tokenIn: "WETH"` must be <= `limits.maxWethInWei` and <=
  `balances.wethWei`; with `tokenIn: "LST"` it must be <= `lstBalanceWei`.
- Check `instantExitWethWei` against `lstRedemptionValueWethWei` before selling
  size: if the pool pays much less than `marketPriceWeth x balance` suggests, you
  are too big for the book and should split the exit or queue instead.

## Leverage is not your job here

`protocols.lst.aaveCollateral` tells you the LST is listed as Aave collateral, so
posting it and borrowing WETH against it is possible. **This prompt does not do
that.** Leveraged staking multiplies the yield and the slashing exposure in equal
measure, and the LST's Aave price follows the vault a block late, so a slash
reaches your health factor after it reaches your position. The rule-based twin of
this agent can do it behind an explicit opt-in; you trade the spot decisions
above. If you find yourself reaching for `aaveSupply`, don't.

## Explicit noop criteria

- `discountBps` inside +/-27bps and no free WETH: nothing to do.
- `apyBps` below ~200 and no dislocation: hold WETH, do not stake.
- Queue no longer fits and you already hold LST: hold, do not sell.
- No WETH and no LST at all: this venue is WETH-denominated, so say so
  (`funding.wethWei` is zero) rather than trying to trade.

## Revision invariants (for self-improvement)

- **Never queue a redemption that cannot finalize before the run ends.** That
  converts a good position into an unrealizable one. Judge it on
  `estimatedQueueDelayBlocks`, never on `withdrawalDelayBlocks`.
- **A slash can cut the redemption rate mid-run.** It lands on one block and the
  pool has not repriced yet, so the discount jumps: that is an opportunity to
  buy, not a reason to panic-sell.
- **Never panic-sell late.** Holding is already marked at the pool price.
- Tunable: the discount thresholds, sizing fractions, how much slack to leave on
  the queue check.
