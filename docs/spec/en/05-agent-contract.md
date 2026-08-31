[← Index](README.md) | [← 04 Stress events](04-stress-events.md) | [06 Scoring →](06-scoring.md)

# 05. The agent contract

Sources: `sdk/src/agent.ts` (contract types), `sdk/src/types.ts` (observation / action), `example/agents/runtime/` (the runtime), `sdk/src/action.ts` (validation).

## 5.1 One agent, one directory

Drop it in `example/agents/<id>/` and add the id to the roster — that is the whole of adding a participant. Spawning is **always `runtime/bot.ts`**, with the strategy directory arriving in `ERIS_AGENT_DIR`.

| Directory contents | Kind | How it runs |
|---|---|---|
| `agent.ts` exporting `decide(obs, ctx)` | Rule strategy | bot.ts drives a read→decide→send loop |
| `agent.ts` exporting `run(ctx)` | Self-driven | bot.ts does not loop; it passes ctx and delegates |
| `agent.ts` + `prompt.md` (`kind: improve`) | Self-improving | decide runs every block, and an LLM rewrites the strategy **out of the trade path** |

`runtime/` (generic scripts) and `lib/` (shared helpers) are **reserved names** and cannot be agent ids.

The roster's `command` / `args` are an override for a fully self-contained agent (another language, say), which does its own reading, sending and validation (unsupported).

### Startup decisions (`bot.ts:200-277`)

```
no agent.ts                              → exit 1
  (with only prompt.md present, it says prompt mode was removed)
agent.ts exports neither decide nor run  → exit 1
only the old improve.md                  → exit 1 (renamed to prompt.md in ADR 0018 Amendment 1)
prompt.md without kind: improve          → exit 1 (below)
prompt.md alongside run(ctx)             → exit 1 (self-improvement applies to decide only)
ERIS_AGENT_MODE / ERIS_PROMPT_* set      → exit 1 (retired)
```

**Why the `kind: improve` marker is mandatory**: `prompt.md` means the opposite of what it used to. The old form said "given this observation, what do you do"; the current one says "when, on what evidence, and how should the strategy change". Nineteen files of the old kind were deleted but survive in git history and in older bundles, and **both formats carry the same `name` / `description` frontmatter** — the marker is the only thing that can tell them apart. Reading one silently would **hand the model trading instructions as its brief**.

## 5.2 The execution contracts

### `decide(obs, ctx)` — rule strategy

```ts
type DecideFn = (obs: AgentObservation, ctx: AgentContext) =>
  AgentAction | Record<string, unknown> | null | undefined | Promise<...>
```

- `null` / `undefined` means "pass". **A plain object is fine too** — the runtime parses and validates before sending, so an invalid action never reaches the chain
- The default cadence is once per new block. `export const config = { intervalMs, offsetMs }` switches to a timer
- It does not re-enter (a `deciding` flag)
- **Passing is logged too.** `send.ts` drops noops, so a strategy that passes every block used to leave nothing behind at all — and an empty log cannot distinguish "never started" from "looked and declined" (`bot.ts:392`)

### `run(ctx)` — self-driven

Process lifetime equals run lifetime. bot.ts does not loop; it passes ctx. Signing, nonces and mempool self-reporting stay centralized in the runtime. Example: `liquidator`.

### `AgentContext`

```ts
type AgentContext = {
  agentId: string;
  address: Address;
  publicClient / walletClient;      // viem clients
  config: SimConfig;                // rebuilt from the same YAML
  latestObservation(): AgentObservation | null;
  onObservation(cb): () => void;    // returns an unsubscribe
  submit(action): void;             // validate → sign → mempool (a rejection is logged)
  log(entry: AgentLogEntry): void;  // appends to runs/<id>/agents/<id>.jsonl
};
```

`submit` is **fail-closed**: an action that fails validation leaves a `rejected` entry in the mempool log and never reaches the chain.

## 5.3 The observation

Built by `observationFor` (`sdk/src/observation.ts`). The point is that **the environment's scorer and the agent's observation go through the same function**.

### Structure (`sdk/src/types.ts:634`)

| Field | Contents |
|---|---|
| `runId` / `round` / `blockNumber` / `agentAddress` | Identity. `round` is **the absolute chain block number** |
| `fairPriceUsdcPerWeth` / `oraclePrices` | The fair price (one block late) |
| `fairPricesUsd` / `baseBalances` / `baseDecimals` / `markets` | Multi-asset. In a WETH-only run these agree with the legacy fields |
| `blocksRemaining` | Blocks left, **counted from the first block this agent observed**. Undefined when the run has no block limit |
| `enabledProtocols` | The venues this run turned on |
| `balances` | `ethWei` / `wethWei` / `usdcUnits` / `stables{}` |
| `inventory` | `valueUsdc` and friends. **This is the valuation**; `balances` is a budget |
| `history` | The last 20 rounds of pool and fair price |
| `limits` | Every cap (§5.5) |
| `protocols` | Per-venue observations (`ProtocolObservations`) |
| `competition` | Recent bidding state (for `economicGas`; ADR 0011) |

### How to read it

- **`usdcUnits` is native USDC only** (issue #27). It is a *budget*, not a valuation. It used to be every active stable summed, which **could not be spent anywhere** — USDT is not accepted in a USDC pool. What the wallet is worth is `inventory.valueUsdc`
- **`balances.stables[sym].marketQuoted: false` means "no market answered, so par was assumed".** Do not read `priceUsdc: 1` as "the peg is holding"
- **`blocksRemaining` carries a block or two of error.** An agent starts observing right around the first competition block, not before it. This value is what makes the LST withdrawal queue a decision rather than a formality (an exit that cannot finish inside the run is not an exit)
- Check `marketQuoted` before acting on the LST's `discountBps` (no quote means 0, not "a 100% discount")
- When Liquity's `trove.positionKnown` is false, `positionFromRiskiest` and `redeemedAheadEusdWei` are meaningless

## 5.4 Actions

### The vocabulary (25 leaves plus 4 control forms)

`ACTION_TYPES_BY_PROTOCOL` (`sdk/src/action.ts:42`) is **the single source of what a run offers**.

| Protocol | Actions |
|---|---|
| `uniswap` | `swap` / `mintLiquidity` / `removeLiquidity` / `collectFees` |
| `balancer` | `balancerSwap` |
| `curve` | `curveSwap` / `stableSwap` |
| `gmx` | `gmxIncrease` / `gmxDecrease` |
| `aave` | `aaveSupply` / `aaveWithdraw` / `aaveBorrow` / `aaveRepay` |
| `lst` | `lstDeposit` / `lstSwap` / `lstRequestWithdraw` / `lstClaimWithdraw` |
| `liquity` | `liquityOpenTrove` / `liquityAdjustTrove` / `liquityCloseTrove` / `liquityRedeem` / `liquityProvideToSP` / `liquityWithdrawFromSP` / `liquityLiquidate` / `liquitySwapEusd` |

Control forms:

| type | Contents |
|---|---|
| `noop` | Do nothing (with an optional `reason`) |
| `bundle` | Several leaves executed atomically as one transaction. **GMX cannot be included** (it needs keeper execution) |
| `rawTx` / `rawBundle` | Raw calldata: `to` / `data` / `value` |

`test/actionVocabulary.test.ts` catches renames and removals.

### Units

| Quantity | Unit |
|---|---|
| Base amounts | wei at that token's decimals (WETH=18, WBTC=8) |
| Stable amounts | that token's units (USDC=6, DAI/eUSD=18) |
| GMX `sizeDeltaUsd` | USD at 1e30 scale |
| GMX `acceptablePrice` | 1e(30−decimals) scale |
| Fees | wei per gas |
| Slippage | bps |

**`stableSwap`'s per-round cap is denominated in USDC's 6 decimals**, so an 18-decimal stable needs conversion. Measured: forgetting it rejects every sell while buys go through, leaving "unrealized profit on a position that cannot be closed" (42 rejections against 6 accepted).

### Validation (`validateAction`)

`sdk/src/action.ts:190`, in order:

1. `noop` passes unconditionally
2. A `bundle` must be non-empty and within `limits.maxBundleActions`
3. Each leaf's priority fee must be within `limits.maxPriorityFeePerGasWei`
4. The adapter's `validate(action, obs, work)` must pass
5. `mintLiquidity` must not exceed `limits.maxOpenPositions`
6. **Balances accumulate across the bundle**

The cumulative check matters: each leaf is validated against "the balance minus what earlier leaves consumed", and **the estimated swap output is credited back**. Without that credit, a two-leg arbitrage (buy USDC→WETH, sell WETH→USDC) is judged to hold zero WETH on the sell leg and rejected — which breaks the premise of measuring pure alpha under USDC-only funding.

## 5.5 Limits

Assembled from config into the observation by `observationFor` (`sdk/src/observation.ts:94`).

| limits field | Config key | Meaning |
|---|---|---|
| `maxWethInWei` / `maxUsdcInUnits` | `limits.agentWethWei` / `agentUsdcUnits` | Per-round swap input cap |
| `baseLimits[sym]` | `limits.agentBase` / `lpBase` / `aaveSupplyBase` | Per-base caps (`"0"` = uncapped, bounded by balance) |
| `maxLpWethWei` / `maxLpUsdcUnits` | `limits.lpWethWei` / `lpUsdcUnits` | Liquidity provision |
| `maxBundleActions` | `limits.bundleActions` | Bundle size |
| `maxOpenPositions` | `limits.openPositions` | LP positions |
| `maxGmxSizeUsd` | `limits.gmxSizeUsd` | Perp size |
| `maxAaveSupplyWethWei` / `maxAaveBorrowUsdcUnits` | `limits.aaveSupplyWethWei` / `aaveBorrowUsdcUnits` | Aave |
| `maxLstDepositWethWei` | `lst.maxDepositWethWei` | Per-stake cap (`"0"` = balance-bound) |
| `defaultPriorityFeePerGasWei` / `maxPriorityFeePerGasWei` | `limits.priorityFeeWei` / `maxPriorityFeeWei` | Fees |
| `defaultSlippageBps` | (fixed at 50) | Default slippage |

**Under `economicGas: true` the presented `maxPriorityFeePerGasWei` becomes effectively unlimited (10¹⁸ wei/gas)** (`observation.ts:103`). Once cap enforcement is retired, not raising the presented value would make high bids fail silently. The real bound is the EIP-1559 balance constraint.

## 5.6 Sending (`runtime/send.ts`)

1. `parseAction` → on failure, `bad_action`
2. `validateAction` → on failure, `rejected`
3. The adapter's `buildTxs` assembles the transaction
4. Sign and send (**managing its own nonce**)
5. Self-report to the mempool log (`kind: "mempool"`, `event: submitted` / `submit_failed` / `rejected`)

**Why the self-report exists**: with direct sending, the coordinator cannot count transactions that were submitted but never included. That gap is what the log closes (ADR 0006 §5).

Under `economicGas`, a **gas manager** runs (`maybeRefillGas`): when the ETH balance drops below a threshold it queues a refill, then waits three blocks (for the transaction to land and the balance to reflect it).

## 5.7 Self-improvement (ADR 0018)

**The LLM is not in the trade path.** The strategy trades every block by itself, and the LLM periodically **rewrites the strategy's code**.

> Per-decision LLM calls (prompt mode) were removed in ADR 0018: measured at 8–28 blocks per decision and 1/64 the actions of the same strategy in rule mode, it could not compete (ADR 0017 §5 B1).

### `prompt.md`

```yaml
---
kind: improve            # required; fails fast without it
name: <name>             # required
description: <text>      # required
reviseEveryBlocks: 60    # optional (default 60)
model: <model>           # optional (wins over the roster's ERIS_LLM_MODEL)
---
The body: the improvement policy (when, on what evidence, and how to change it)
```

### The revision cycle

| Stage | Contents |
|---|---|
| Trigger | `obs.round − lastRevisionBlock >= reviseEvery`. **The first observation only seeds the baseline** — `obs.round` is an absolute block number, so starting from 0 made the first observation instantly overdue |
| Ceiling | **12 per run** (`MAX_REVISIONS_PER_RUN`). A declaration shorter than `runBlocks/12` is clamped, **and the clamp is recorded** (a co-located run shares one LLM budget) |
| Input | The current source, the version history, the value at each install, the last 32 decisions, the latest observation, and **the action vocabulary this run offers** |
| Output | `{notes, executorTs}` or `{notes, revertTo: <version>}`. `executorTs: null` means "keep the current strategy" |

**Why the vocabulary is passed**: without it the model's only evidence is the current strategy, so **a strategy that has never swapped has no way to learn that `swap` exists**. Measured: under USDC-only funding, `lp-provider` sat out 18 of 18 scenarios for want of one (`improve.ts:328-334`).

### Three gates (`compileExecutor`)

```
1. Cheatcode static check   any hit from findCheatcodeUsage rejects it
2. Compilation              vm.Script. The sandbox holds only Math/JSON/Number/String/Boolean/
                            Array/Object/BigInt/Map/Set/isFinite/isNaN/parseFloat/parseInt
                            (no require, no process, no fs, no fetch)
3. Wall-clock bound         one call is cut off at 2,000ms
```

**The vm is not a sandbox** (`improve.ts:228-237`). Because `ctx` is passed in, generated code can trade exactly as freely as the hand-written strategy it replaces. What the vm removes is *ambient capability*; what addresses intent is the cheatcode check.

The return value is brought back into the host realm with `structuredClone` (an object built inside the vm is not `instanceof Object` outside it, and that difference surfaces far from its cause — in validation or logging).

### There is no automatic rollback

No threshold is defensible. The previous implementation's rollback fired zero times in 18 runs, and the obvious opposite ("any loss at all") reverts every revision in a regime where everyone is losing. **Reverting is the model's call**, made with the version history through `revertTo`. A revert **re-installs as a new version** rather than rewinding the list (rewinding would erase the fact that the reverted version ever ran).

### The frozen control

`env: { ERIS_AGENT_FROZEN: "1" }` in the roster ignores prompt.md and runs the strategy unchanged. It is how the **control every roster needs — "did revising help?"** (ADR 0018 §5) — is built without duplicating the agent directory.

### With no LLM backend

The run completes. Revisions are recorded as failed and the strategy keeps trading unchanged. The backend is chosen with `ERIS_LLM_MODEL` (with no API key, `codex[:<m>]` or `claude-cli[:<m>]` spawns the logged-in CLI). `ERIS_IMPROVE_LOG_CALLS: "1"` records the raw exchange to `agents/<id>.llm.jsonl` (off by default — it holds every generated strategy in full).

## 5.8 The cheatcode static check

`sdk/src/strategyStaticCheck.ts`. Used both as the **submission gate** (`npm run check:strategy`) and **before installing LLM-generated code**.

| Rule | Detects |
|---|---|
| anvil cheatcode RPC | `anvil_*` |
| evm cheatcode RPC | `evm_*` |
| hardhat cheatcode RPC | `hardhat_*` |
| Environment-only helpers | `setEthBalance` / `dealErc20` / `impersonate` / `stopImpersonate` / `sendAsImpersonated` / `setIntervalMining` / `setAutomine` / `resetFork` |

It is a regex scan over source and **is not complete**; it is paired with post-hoc auditing ([11](11-invariants.md)). It lives in the sdk because both core and example need it, which is a consequence of the dependency direction (`example → sdk ← core`).

## 5.9 External participants (self-hosted)

ADR 0021 §2. A registered entry the environment never starts.

- The roster carries `external: true` plus `address` (the participant holds the key) or `wallet` (the operator issues one)
- **`command` / `args` / `dir` / `env` are refused rather than ignored** — silently dropping them produces a roster that reads as if the operator were running the agent
- Funding, transaction attribution, scoring and rule checks are **all address-based**, so a key is only needed to *start* something — which an external entry is not
- **The decision log lives on the participant's machine.** The dashboard hides the decision-log tab for external agents and says so; an empty panel is a different claim ("this agent thought nothing")
- `bot.ts` can read the RPC URL and PriceFeed address from `ERIS_MANIFEST` (the two things the environment cannot inject). **If the manifest is unreadable it refuses to start** — falling back to env would point the agent at whatever chain happened to be in the shell, trading on a node nobody is scoring
- A self-hosted agent **grants its own venue approvals** (`ensureVenueApprovals`), skipping any that are already in place so restarts do not eat the endowment

## 5.10 Submission

`npm run bundle:agent <id>` produces the submission zip (runtime + sdk + lib + the agent; ADR 0015 §7). **The agent directory is the unit of copying and submission**, and a strategy built from one of the bundled agents is the participant's ([README](../../../README.md), License).
