[← Index](README.md) | [← 00 Overview](00-overview.md) | [02 Execution model →](02-runtime.md)

# 01. System architecture

## 1.1 Workspaces and the dependency direction

Four npm workspaces plus a bundled deployer that sits outside them.

| Workspace | Role | Participants touch it? |
|---|---|---|
| `sdk/` (`@eris/sdk`) | The contract layer: types / action / observation / protocols / chain / markets / stables / valuation / runConfig | Read (depend on it) |
| `core/` | Environment daemon and scoring: coordinator / anvil / flow / stress / vuln / backtest / scoring / cli | **No** |
| `example/` | The participant template. `example/agents/<id>/` is the unit of copying and submission | Write |
| `dashboard/` | The optional web UI (Vite + React). Reads run artifacts off disk | Optional |
| `deployer/` | A self-contained subpackage that deploys every venue to a bare anvil (its own `package.json` / `foundry.toml`) | Run it |

**The only allowed dependency direction is `example → sdk ← core`**, enforced by `npm run check:boundaries` (`scripts/checkImportBoundaries.ts`). The dashboard reads artifacts and JSON-RPC and depends on none of the three — with one deliberate exception, `core/src/scoring/aggregate.ts`, which it imports directly because **two implementations of one ranking are two answers to "who won" with no way to tell which is real** (→ [09](09-dashboard.md)).

```
example/  ──►  sdk/  ◄──  core/  ──►  runs/<id>/  ◄──  dashboard/
(strategies) (contract) (env+scoring) (artifacts)      (UI)
```

## 1.2 Processes

Four kinds of OS process run during a run.

| Process | What it is | Started by | Chain privileges |
|---|---|---|---|
| **coordinator** | `core/src/realtime/coordinator.ts` | A human, via the CLI | admin / keeper keys, cheatcodes (on anvil), treasury (external) |
| **agent × N** | `example/agents/runtime/bot.ts` (the strategy directory arrives in `ERIS_AGENT_DIR`) | Spawned by the coordinator | Its own key, nothing else |
| **flow bot** | `core/src/flow/market-maker.ts` | Spawned by the coordinator | None — **it never touches RPC**. It writes orders to stdout and the coordinator relays them |
| **chain** | anvil, or an external chain | Separately | — |

```
┌─ coordinator ─────────────────────────┐      ┌─ agent process × N ────────────┐
│ anvil lifecycle                        │      │ runtime/bot.ts drives all kinds │
│ fair price → PriceFeed / oracle txs    │      │ read.ts: observation per block  │
│ relays the flow bot's orders           │      │ agent.ts: decide / run          │
│ GMX keeper                             │      │ send.ts: signs and sends        │
│ injects stress events                  │      │  (manages its own nonce)        │
│ scores epoch boundaries / post-run     │      └────────────┬───────────────────┘
└───────────────┬────────────────────────┘                   │
                │  PriceFeed / flow / keeper txs              │ agent txs
                ▼                                             ▼
        ┌──────────────────────────────────────────────────────────┐
        │ chain — one mempool, in-block order by --order fees (desc) │
        └──────────────────────────────────────────────────────────┘
                │ finalized blocks (observations)  │ historical blocks (scoring)
                ▼                                   ▼
             agents                             coordinator
```

### What an agent process is handed

The contract is **env, on-chain state, and `runs/<id>/agents/<id>.jsonl` — nothing else** (`core/src/realtime/agentProcess.ts:13-18`). The stdin/stdout protocols (the old relay and directShim) are retired.

| env | Contents |
|---|---|
| `ERIS_AGENT_ID` / `ERIS_AGENT_DIR` | Its id and its strategy directory |
| `ERIS_RPC_URL` / `ERIS_AGENT_ADDRESS` / `ERIS_AGENT_PRIVATE_KEY` | Where the chain is and who it is |
| `ERIS_PRICE_FEED_ADDRESS` | Where the fair price is published |
| `ERIS_RUN_ID` / `ERIS_RUN_DIR` / `REPORT_DIR` | Where to log |
| `ERIS_RUN_BLOCKS` | The run's block budget as the environment resolved it (passed explicitly so a CLI override reaches the child) |
| The roster's `env:` and the environment's extraEnv | Strategy parameters, victim addresses, the vuln factory |

`CLAUDE_CODE_*`, `CLAUDECODE` and `AI_AGENT` are stripped from the child's environment (the parent session's nesting detection otherwise hangs it — `agentProcess.ts:42`).

## 1.3 The fairness boundary

What an agent is **not** given is the centre of the design.

| Withheld | Why |
|---|---|
| Other agents' private keys | Self-evident |
| Pending transactions / the txpool | Makes mempool front-running structurally impossible |
| Unfinalized state | Observations are of finalized state only |
| The stress schedule | Window positions are seed-derived and private (they are not in the manifest either — [10](10-operations.md)) |
| The environment's admin / keeper keys | They can rewrite the oracles |

Three things that *are* given, and are easy to misread:

- **Victim addresses** (`ERIS_LIQUIDATION_VICTIMS`) are distributed. They are public on-chain information, and handing them over preserves the premise of the detection skill — an agent still has to scan health factors every block (`coordinator.ts:987`).
- **The whale's wallet is endowed during setup**, so its capacity is readable from block-0 balances. The event is therefore **anticipatable, not merely reactable** — deliberately (`coordinator.ts:1871`).
- **Competitive bid state** (`obs.competition`) is given as information an agent could derive from the last block anyway, which is what a real MEV searcher does (`sdk/src/types.ts:726`).

## 1.4 The protocol adapter layer

One venue, one adapter (`sdk/src/protocols/types.ts:146`, `ProtocolAdapter`). The point is that **the environment's scorer and the agent's observation use the same adapter and the same `observationFor`**, so the two can never see different numbers.

| Method | Called from | Role |
|---|---|---|
| `parse` / `bundleable` / `validate` | Both sides (pure functions) | Interpreting and validating an action |
| `readState(ctx, fairPrice)` | Every block (coordinator and agent) | Reading venue state |
| `observe(ctx, state, agent, fairPrice)` | Building an observation | Its contribution to `obs.protocols[id]` |
| `buildTxs(ctx, owner, action, state)` | Sending | Intent → on-chain transaction |
| `afterMine(ctx, opts)` | Every block (keeper stage) | GMX order execution, etc. |
| `valueUsdc(ctx, agent, state, fairPrice)` | End of run | Contribution to final PnL |
| `valueAtBlock(ctx)` | Every scoring cross-section | **A staged generator** (below) |
| `accountedTokens(publicClient)` | Scoring | Declaring which tokens this adapter already values |
| `setupWallet` / `setupGlobal` | Setup | Approvals / mock deploys and oracle swaps |

### Why `valueAtBlock` is a staged generator

The obvious `valueAtBlock(agent, block)` costs **one round trip per agent per protocol**, which dissolves ADR 0006 §4's "one multicall per block cross-section": a 30-agent, 300-block run goes from ~1,500 multicalls to ~45,000 RPC calls (`sdk/src/protocols/types.ts:83-87`). So an adapter yields the reads it wants, and the scorer **merges every adapter's stage-N reads into a single multicall**. Round trips track the number of stages, not the number of agents.

### Two marks, not one

`AgentProtocolValue` returns `valueUsdc` (the face mark) and `liquidatableValueUsdc` (what an exit would actually realize) separately (`types.ts:128`). **Scoring sums the second** (issue #40 axiom 3 / ADR 0022 Amendment 1). The face mark is reported as `markedValueUsdc` only where the two disagree — an LST redemption whose queue outlives the run, a Trove under 100% ICR, a lending supply whose collateral is worthless.

## 1.5 The chain layer

`run.chainMode` takes two values (`sdk/src/config.ts:55`).

| | `anvil` (default) | `external` |
|---|---|---|
| Cheatcodes | Available (`setBalance` / `setStorageAt` / mining control) | **None**. A cheatcode reached for is refused at the call and names its replacement |
| Funding | **Assigns** a balance | Real transfers from a treasury EOA (**tops up a difference**) |
| Block production | The environment, via `setIntervalMining` | The sequencer. The environment measures the real cadence |
| Reset | `resetFork` / snapshot-revert | **None** — which on a practice devnet is the design |

Refusing matters because on a real chain an unknown RPC merely returns an error object, and many of the ~30 call sites swallow it. Without the refusal you get a run that **funds nobody, mines nothing, and writes a `summary.json` claiming a completed competition**. → the startup refusals are in [02](02-runtime.md).

## 1.6 External dependencies

| Dependency | Required? | Without it |
|---|---|---|
| anvil (Foundry) | Yes, in `chainMode: anvil` | Nothing runs |
| `deployer/` (plus its `vendor/` clones) | Yes, for local deploy | No venues; `deployment_check` stops the run |
| An Arbitrum RPC (`ARB_RPC_URL`) | Only in fork mode | Not needed for local deploy |
| An LLM backend (Ollama / Anthropic API / Claude Code CLI / Codex CLI) | Optional | The run completes; revisions are recorded as failed and strategies trade unchanged |
| Blockscout (`infra/blockscout/`) | Optional | The dashboard's deep links simply disappear |
| forge (contract build) | First time only | Without `out/` the PriceFeed cannot be deployed |

## 1.7 Directory map

```
sdk/src/
  types.ts            observation / action / AgentSpec types (the heart of the contract)
  action.ts           action validation + ACTION_TYPES_BY_PROTOCOL (the run's vocabulary)
  actionSchema.ts     zod schema (structural validation, including LLM output)
  observation.ts      observationFor — the single builder the environment and agents share
  protocols/          seven adapters + registry / oracles / marketHelpers / deploy
  chain.ts            clients, cheatcodes, resetFork, funding
  markets.ts          the token registry (bases, kinds, decimals)
  stables.ts          market-priced stables — the two-sided probe
  valuation.ts        how a holding becomes USDC
  runConfig.ts        the YAML schema (nested lowercase → internal keys)
  constants*.ts       venue addresses (fork: constants.ts / local: constants.local.ts, generated)
core/src/
  realtime/coordinator.ts   the environment daemon (the whole run lifecycle)
  realtime/liveScoring.ts   scoring at the epoch boundary as it goes past
  realtime/reconstruct.ts   post-run value-series reconstruction
  realtime/marketSeries.ts  market.json (reporting only)
  realtime/events.ts        the stress schedule (seed → windows)
  realtime/{liquidity,stableDepeg,whale,lst,liquity,vulnEvents,vulnPools}.ts  event execution
  realtime/noArb.ts         the no-arbitrage check (startup and per block)
  scoring/{epochScore,metrics,aggregate}.ts  the score / candidate metrics / cross-scenario aggregation
  flow/{logic,market-maker}.ts  orderflow (pure functions / independent process)
  backtest/{shared,standings}.ts  state-dump validation / matrix standings
  segments.ts               daily segments
  postRunCheck.ts           post-hoc rule checks
  manifest.ts               the environment manifest
example/agents/
  runtime/            bot / read / send / llm / improve / deploy / agentLog (reserved names)
  lib/                shared strategy helpers (reserved name)
  <id>/               the agent itself (agent.ts, optionally prompt.md)
contracts/            PriceFeed / mock oracles / FlashArb (Foundry)
config/               local.yaml (real) / example.yaml (template) / regimes/ / scenarios/ / rosters/
runs/                 run artifacts
```
