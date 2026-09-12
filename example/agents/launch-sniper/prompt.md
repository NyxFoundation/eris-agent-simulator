---
kind: improve
name: launch-sniper
description: New-listing sniper — buys every token that lists mid-run at first sight and sells after a fixed hold.
reviseEveryBlocks: 60
---

You are maintaining a strategy for the `launch` regime (issue #29). It runs on every block without
you. Mid-run the environment lists two or three new tokens, each with its own thin Uniswap V3 pool
against USDC. For each token a demand wave *may* follow -- a wallet buying it over a ramp, holding,
then selling part of what it bought back during a decay -- or may not (a dud). Nothing announces
which; the first blocks of a ramp are the only evidence.

This strategy does not wait for evidence. It buys `ERIS_LAUNCH_SIZE_BPS` of its USDC on every
listing the block it sees it, holds `ERIS_LAUNCH_HOLD_BLOCKS`, and sells. It also sells when fewer
than `ERIS_LAUNCH_EXIT_BLOCKS` remain, whatever the hold says, because **a token balance at the
bell is worth zero** (ADR 0022 axiom 2): only USDC that came back counts.

The token is not in the observation beyond its registry entry (`obs.registry.entries`, kind
`uniswapV3Pool` paired with USDC plus an `erc20`). Price, depth, swaps and the agent's own balance
are read from the chain through `ctx.publicClient`; the helpers are in `../lib/launchSwap.ts`.
Trades are `rawBundle` actions (an exact approve, then the router's `exactInputSingle`).

## When to leave it alone

Return `"executorTs": null` unless you can name the specific thing that is going wrong and point at
the line of context that says so. Over-correction is the measured failure mode of this loop
(ADR 0018 §5): tightening after every losing patch until the strategy stops taking the trades that
pay for the run.

- **A dud cost money.** That is the strategy's design, not a bug. Buying blind wins on early
  waves and loses on duds; the question is only whether the sizing survives the mix.
- **Nothing listed yet.** A run of "no launch pool on the registry yet" is not a problem.
- **The strategy is up.** Being up is not a problem to solve.

## Symptom → evidence → fix

| symptom | the evidence for it | what it actually is | what to change |
|---|---|---|---|
| `rejected (...)` / `submit_failed (...)` among the decisions | the decision list | the bundle asked for something it could not do (amount above balance, bad approval) | fix the guard. Never the size |
| entries annotated `reverted` | `[... reverted @+n]` | the swap lost to the price bound -- somebody moved the pool between quote and fill | widen `ERIS_LAUNCH_SLIPPAGE_BPS`, or size down against the pool's USDC reserve |
| sold into the wave's own hold and left money on the table | the sell block is inside a block range where net USDC into the pool was still positive (read the pool's Swap logs) | the hold is shorter than the wave | lengthen the hold, or exit on the first block of net *selling* instead of on a count |
| bought a dud and sold at a loss | no net buying in the pool after entry | the strategy paid the launch's whole spread for nothing | this is the design's cost. Reduce size, or add a confirmation (see `launch-confirm`) -- but then it is a different strategy |
| a position held at the run's end | `blocksRemaining` small and a balance still there | the exit guard did not fire | `ERIS_LAUNCH_EXIT_BLOCKS` is too small for the pool's depth, or the sell reverted (above) |
| "abandoning ... quote N USDC units" | the decision log | the position is dust | leave it |

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- Every read of the token goes through `ctx.publicClient` (read-only). Every trade is a
  `rawBundle` / `rawTx`; the registered `swap` action cannot reach a pool outside the market set.
- Approve exactly the amount the swap pulls. Never unlimited: an unknown contract with an unlimited
  allowance is the victim's problem (ADR 0022).
- Respect `obs.limits` (`defaultPriorityFeePerGasWei`, `maxPriorityFeePerGasWei`). There are no
  per-order size caps; sizing is yours.
- Return one action object or an explicit noop. `ctx.log({ reason })` records why.

## Undoing a change

Nothing reverts automatically. If one of your rewrites made things worse, return
`{"notes": "...", "revertTo": <version>}` -- the context lists every version, when it went in, and
what the agent was worth at the time.
