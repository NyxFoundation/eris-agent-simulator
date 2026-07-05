[← README](../../README.md)

# Writing a Strategy (agent authoring tutorial)

A new strategy runs by creating **one directory at `example/agents/<id>/`** and adding the id to a roster
(ADR 0015; `runtime/bot.ts` does all the spawning, observation, signing, sending, and validation). This document
is a single straight line: "minimal agent → read observations → return an action → keep a log → run in backtest → submit."

There are 3 types (details in [Architecture](architecture.md)). This page follows the most basic one, the rule strategy
(`decide()`):

| Type | What you place | Suited for |
|---|---|---|
| rule strategy | `agent.ts` (`decide(obs, ctx)`) | most strategies; observe → decide each block |
| self-driven | `agent.ts` (`run(ctx)`) | custom loops / event-driven (e.g. liquidator) |
| prompt | `prompt.md` | let an LLM decide each time (see [LLM Agents](llm-agents.md)) |

## Step 1: The minimal agent

```bash
mkdir example/agents/my-strategy
```

```ts
// example/agents/my-strategy/agent.ts
import type { AgentAction, AgentObservation } from "@eris/sdk";
import type { AgentContext } from "@eris/sdk/agent.js";

export function decide(
  obs: AgentObservation,
  ctx: AgentContext,
): AgentAction | Record<string, unknown> | null {
  return { type: "noop", reason: "doing nothing yet" };
}

// If omitted, it is called "once per new block". To change the interval:
// export const config = { intervalMs: 5000 };
```

That is the entire contract:

- If the return value is an action, the runtime **validates it before** signing and sending (invalid actions never
  reach the chain, and a `rejected` entry is left in `agents/<id>.jsonl` = fail-closed)
- Returning `null` / `undefined` means skipping. **noop is a perfectly good choice** (not trading in a market with no
  opportunity is the right answer)
- Throwing does not crash the run (that round is skipped and `decide error:` is left in the log)

## Step 2: Read the observation (AgentObservation)

`obs` is a "snapshot of confirmed state" that the runtime reconstructs each block. You don't need to hit RPC directly
(you can, but reading from the observation what is already in it is faster and safer). A sample from a real run (excerpt):

```jsonc
{
  "round": 610,
  "blockNumber": "610",
  "fairPriceUsdcPerWeth": 2993.27,          // fair price distributed by the environment (1 block late = by design)
  "fairPricesUsd": { "WETH": 2993.27, "WBTC": 60065.96 },  // per-base fair when multi-asset
  "balances": { "ethWei": "…", "wethWei": "0", "usdcUnits": "25000000000" },
  "inventory": { "valueUsdc": 339290.8, "weth": 0, "usdc": 25000, "eth": 105.0 },
  "history": [ { "round": 608, "poolPriceUsdcPerWeth": 3000.0, "fairPriceUsdcPerWeth": 3000 }, … ],
  "limits": { "maxWethInWei": "1000000000000000000", "maxUsdcInUnits": "5000000000",
              "defaultPriorityFeePerGasWei": "100000000", "defaultSlippageBps": 50, … },
  "protocols": { "uniswap": { "pool": { "priceUsdcPerWeth": 3000.0, "fee": 3000, … } },
                 "balancer": { "priceUsdcPerWeth": 2991.0 }, "curve": { … }, "aave": { … } },
  "competition": { "maxCompetitorPriorityFeeWei": "0", "recentRevertRate": 0, … }
}
```

Things to watch when reading:

- **Token amounts are decimal strings** (`wethWei` is 18-decimal wei, `usdcUnits` is 6-decimal). Handle them with
  `BigInt(...)`. `inventory` is a human-readable numeric conversion (approximate)
- `history` is the pool/fair series for the last ~20 blocks (for gauging momentum and the persistence of a gap)
- `limits` holds the per-round trade limits and the default/max fees. **Cap your size here** (actions over the limit
  are rejected by validation)
- The shape of `protocols.<venue>` differs per venue. **It's safest not to read it directly, but to normalize it with a
  shared helper** (Step 4). Reading `obs.pool` directly has repeatedly caused a TypeError → noop for every round

## Step 3: Return an action

Actions are JSON (the zod schema `sdk/src/actionSchema.ts` is authoritative). The full list is in
[Protocols and Actions](protocols-and-actions.md). A minimal swap:

```ts
// buy WETH with USDC if the pool is 50bps or more below fair
const pool = obs.protocols.uniswap?.pool?.priceUsdcPerWeth;
if (!pool) return null;
const gapBps = (obs.fairPriceUsdcPerWeth / pool - 1) * 10000;
if (gapBps > 50) {
  return {
    type: "swap",                 // uniswap WETH/USDC swap
    tokenIn: "USDC",
    amountIn: "500000000",        // 500 USDC (6-decimal units, as a decimal string)
    slippageBps: 75,
    maxPriorityFeePerGasWei: obs.limits.defaultPriorityFeePerGasWei,
  };
}
return null;
// put the reasoning in ctx.log, not in the action (Step 4; only noop carries a reason field)
```

To put multiple legs in a single tx, use `type: "bundle"` (`actions: [...]`; GMX is async so it cannot be bundled).

## Step 4: Add a decision log from the start

**Skipping this makes post-run debugging dramatically harder** (investigating losses in a strategy with no decision log
means descending all the way to on-chain receipt reconciliation). Use `ctx.log` to leave each round's reasoning in
`runs/<run_id>/agents/<id>.jsonl`:

```ts
export function decide(obs: AgentObservation, ctx: AgentContext) {
  const signals = { fair: obs.fairPriceUsdcPerWeth, pool, gapBps };
  const action = pickAction(obs);   // your decision logic
  ctx.log({ round: obs.round, action: action ?? { type: "noop" }, signals,
            reason: action ? "gap over threshold" : "no edge" });
  return action;
}
```

Mempool activity (submitted / rejected / submit_failed) is left automatically by the runtime in the same file.
For how to read it, see [Run Output and Analysis](run-output.md).

## Step 5: Register in a roster and run in backtest

```yaml
# my-roster.yaml (together with sparring partners)
agents:
  - id: noop
    wallet: AGENT1_PRIVATE_KEY
    baseline: true
  - id: my-strategy          # ← the directory name is the id directly
    wallet: AGENT2_PRIVATE_KEY
  - id: multi-arb            # a bundled rival strategy
    wallet: AGENT3_PRIVATE_KEY
```

```bash
npm run backtest -- --regime calm-01 --agents my-roster.yaml --repeat 5
npm run backtest -- --regime crash-01 --agents my-roster.yaml   # also look at another regime
```

- Read results by `mean alphaUsdc` (β-removed PnL). A single netPnl is contaminated by price drift
- Judge by the distribution of `--repeat` (even in the same regime it varies slightly with tx ordering; see [Backtest](backtest.md))
- Verify across regimes: not overfiring in calm and capturing opportunity in crash — doing both is skill

## Shared helpers (example/agents/lib/)

Cross-venue strategies use `marketViews(obs)` from `lib/markets.ts`. It normalizes the observation into
"per-base `{ fair, venues: [{protocol, price, feeBps, swapType}] }`"
(absorbing the differences in per-venue observation shapes and applying the fee-inclusive mid correction to estimates):

```ts
import { marketViews } from "../lib/markets.js";

for (const view of marketViews(obs)) {
  // view.base ("WETH" | "WBTC" | …), view.fair, view.venues (prices normalized to mid-equivalent)
}
```

## Pitfalls (confirmed in real runs)

1. **Arbitrage that ignores fees structurally loses**. Because fee-aware informed flow keeps gaps within the fee band
   (~30bps), only fire when "gap > that venue's fee + safety margin" holds. A bundled strategy that fired every block at
   a 10bps threshold was measured bleeding −1,650 USDC over 60 blocks
2. **The fair price is 1 block late** (a property of on-chain distribution; everyone is delayed equally). In windows
   where fair moves a lot each block, execution based on a stale fair steps the wrong way. It's safer to confirm the
   "persistence" of the gap with `history` before moving
3. **Initial funding is USDC-only by default** (`funding.wethWei: "0"`). A strategy that starts by selling WETH has no
   inventory in the first round. Decide direction after checking `obs.balances`
4. **Follow `obs.limits` for size and fee**. Overruns are rejected by validation, wasting that round

## Submission

```bash
npm run check:strategy        # static cheatcode check (entry gate)
npm run bundle:agent my-strategy   # submission zip (runtime + sdk + lib + target agent)
```

The bundled strategies in `example/agents/` (noop = minimal form / arb-bot = a model with a decision log / multi-arb =
multi-asset cross-venue / liquidator = self-driven) are all usable as readable working examples.
