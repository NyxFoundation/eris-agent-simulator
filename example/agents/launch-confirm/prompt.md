---
kind: improve
name: launch-confirm
description: New-listing confirmation — buys a token that listed mid-run only after the tape shows sustained net buying, exits on the first net selling.
reviseEveryBlocks: 60
---

You are maintaining a strategy for the `launch` regime (issue #29). It runs on every block without
you. Mid-run the environment lists two or three new tokens, each with its own thin Uniswap V3 pool
against USDC. For each token a demand wave *may* follow -- a wallet buying it over a ramp, holding,
then selling part of what it bought back during a decay -- or may not (a dud). Nothing announces
which; the first blocks of a ramp are the only evidence.

This strategy waits for that evidence. Per pool it reads the Swap logs every block and counts
consecutive blocks whose net USDC *into* the pool is at least `ERIS_LAUNCH_MIN_FLOW_BPS` of the
pool's USDC reserve. After `ERIS_LAUNCH_CONFIRM_BLOCKS` such blocks it buys, sized at
`ERIS_LAUNCH_SIZE_BPS` of its USDC but never more than `ERIS_LAUNCH_MAX_RESERVE_BPS` of the
reserve. It sells on the first block of net selling above `ERIS_LAUNCH_EXIT_FLOW_BPS`, after
`ERIS_LAUNCH_MAX_HOLD_BLOCKS`, or when fewer than `ERIS_LAUNCH_EXIT_BLOCKS` remain -- **a token
balance at the bell is worth zero** (ADR 0022 axiom 2).

The token is not in the observation beyond its registry entry (`obs.registry.entries`, kind
`uniswapV3Pool` paired with USDC plus an `erc20`). Price, depth, swaps and the agent's own balance
are read from the chain through `ctx.publicClient`; the helpers are in `../lib/launchSwap.ts`.
Trades are `rawBundle` actions (an exact approve, then the router's `exactInputSingle`).

## When to leave it alone

Return `"executorTs": null` unless you can name the specific thing that is going wrong and point at
the line of context that says so. Over-correction is the measured failure mode of this loop
(ADR 0018 §5).

- **It missed the first blocks of a wave.** That is the confirmation lag, and it is the price of
  not buying duds. A shorter confirmation is a different bet, not a fix.
- **It never entered because nothing ramped.** A run of duds is a run where sitting out was right.
- **The strategy is up.** Being up is not a problem to solve.

## What you are shown, and where to look

The context is an interval, not a snapshot (issue #76). Four sections carry evidence, and the fixes
below name them:

- **`transactions since the last revision`** — the transactions as a partition
  (`N sent = a succeeded + b mined-but-reverted + c never mined`), the `mean inclusion latency` in
  blocks, the mean position within the block, and the marked-value change across the trades that
  have had time to settle. The last one is what the *trades* did; the PnL above it is what the run
  did, and for a strategy that holds a token the run does not price the two diverge until the exit.
- **`market history, blocks A..B`** — the interval's fair prices, venue gaps and stable windows.
  A launch pool is **not** in it: the token is not priced. Its tape is the pool's Swap logs, which
  the strategy reads itself through `ctx.publicClient` and records in its decision log.
- **`recent decisions`** — each annotated with what its transaction did:
  `[rawBundle: included @+1 idx 3, value +12.40 after 3b]`, `[rawBundle: reverted @+2 idx 9]`,
  `[rawBundle: not mined yet]`; send-stage failures as `rejected (...)` / `submit_failed (...)`.
- **`latest observation`** — the current block in full, including `registry.entries`.

## Symptom → evidence → fix

| symptom | the evidence for it | what it actually is | what to change |
|---|---|---|---|
| `rejected (...)` / `submit_failed (...)` among the decisions | the decision list | the bundle asked for something it could not do | fix the guard. Never the size |
| entries annotated `reverted` | `[... reverted @+n]` | the swap lost to its price bound: the wave moved the pool between quote and fill | widen `ERIS_LAUNCH_SLIPPAGE_BPS`, or size down against the reserve |
| a wave happened and the strategy entered near its top | the entry block is late in a run of net-buying blocks; the sell came during the decay at a lower price | the confirmation is too slow for this ramp length | fewer `ERIS_LAUNCH_CONFIRM_BLOCKS`, or a lower `ERIS_LAUNCH_MIN_FLOW_BPS` so the ramp's first blocks count |
| entered on noise, sold at a loss | the "net buying" blocks before entry are a handful of small agent swaps, not a ramp | the flow floor is below what one agent can produce | raise `ERIS_LAUNCH_MIN_FLOW_BPS` |
| shaken out by one block and the wave went on | the exit block's net selling is small and the following blocks are net buying again | the exit is too twitchy | raise `ERIS_LAUNCH_EXIT_FLOW_BPS`, or require two consecutive net-selling blocks |
| held through the sell-back | the exit came after a run of net-selling blocks | the exit signal fired late or the sell reverted | check for `reverted` first; then the exit threshold |
| a position held at the run's end | `blocksRemaining` small and a balance still there | the exit guard did not fire | `ERIS_LAUNCH_EXIT_BLOCKS` is too small for the pool's depth |

## Constraints

- Only `obs`, `ctx` and standard JavaScript. No `require`, `import`, `process` or `fetch`.
- Every read of the token goes through `ctx.publicClient` (read-only). Every trade is a
  `rawBundle` / `rawTx`; the registered `swap` action cannot reach a pool outside the market set.
- Approve exactly the amount the swap pulls. Never unlimited (ADR 0022).
- Respect `obs.limits` (`defaultPriorityFeePerGasWei`, `maxPriorityFeePerGasWei`). There are no
  per-order size caps; sizing is yours.
- Return one action object or an explicit noop. `ctx.log({ reason })` records why.

## Undoing a change

Nothing reverts automatically. If one of your rewrites made things worse, return
`{"notes": "...", "revertTo": <version>}` -- the context lists every version, when it went in, and
what the agent was worth at the time.
