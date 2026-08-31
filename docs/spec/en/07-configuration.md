[← Index](README.md) | [← 06 Scoring](06-scoring.md) | [08 Artifacts →](08-artifacts.md)

# 07. Configuration

Sources: `sdk/src/runConfig.ts` (the schema), `sdk/src/config.ts` (defaults and resolution), `core/src/runConfig.ts` (roster, CLI, environment-side extensions), `core/src/config.ts` (roster validation).

## 7.1 The principle

**Run settings and the agent roster live in one YAML file, `config/local.yaml`** (ADR 0013). Reading configuration from env is retired.

Only three categories remain in env (`sdk/src/runConfig.ts:9-13`):

| Category | Examples |
|---|---|
| **Secrets** | `ARB_RPC_URL` / `ANVIL_RPC_URL` / `*_PRIVATE_KEY` / `ANTHROPIC_API_KEY` / `OLLAMA_API_KEY` |
| **Agent IPC** | `ERIS_AGENT_*`, passed by the coordinator to child processes |
| **Which config file** | `ERIS_CONFIG` |

RPC URLs and the chain id sit on the secret side because **they belong to a deployment rather than to a regime**: a committed regime YAML must not name one operator's node.

**A retired config env variable that is still set produces a warning** (`core/src/runConfig.ts:110`). `ENABLED_PROTOCOLS`, `SEED`, `ERIS_RUN_BLOCKS`, `ERIS_PRICE_*`, `ERIS_AGENT_DIRECT_TX` and others **are not read**, so leaving one set is a silent no-op where the author intended a calibration.

## 7.2 Resolution order

```
--config <path>  >  ERIS_CONFIG  >  config/local.yaml  >  config/example.yaml
```

The first that exists wins. If none does, it is an error (there is no fallback to env). `config/example.yaml` is the committed template, and it is what makes zero-config work.

Layered on top:

```
secret env  <  YAML  <  CLI flags  <  programmatic overrides
```

`ERIS_CONFIG` propagates to child processes, so **an agent rebuilds its config from the same YAML** — the environment and the agent see the same configuration cross-section, which is why this loader lives in the sdk.

## 7.3 The schema

Keys are **nested lowercase**, mapped to internal env names by `SCHEMA` (`sdk/src/runConfig.ts:73`). The sections are `run` / `market` / `funding` / `limits` / `flow` / `stress` / `vuln` / `lst`, plus `agents`.

**Unknown keys warn and are ignored** (typo detection). Keys starting with an uppercase letter pass through as env names for backward compatibility.

### `run`

| Key | Default | Meaning |
|---|---|---|
| `seed` | 1 | The label for the market conditions; decides the price path and event windows |
| `blocks` | 0 | End after N blocks (0 = unbounded) |
| `seconds` | 20 | End after N seconds |
| `blockTimeSec` | 2 | Block interval |
| `protocols` | all | Which venues to enable |
| `economicGas` | false | Make gas an economic cost (ADR 0011) |
| `localDeploy` | false (**true** in the template) | Turn on the local-deploy address overlay |
| `chainMode` | `anvil` | `anvil` / `external` ([01 §1.5](01-architecture.md)) |
| `chainId` | constant | The external chain's id |
| `externalRoleEthWei` | 50 ETH | Target native balance for admin/keeper on external |
| `resetUnit` | `continuous` | World reset unit ([02 §2.4](02-runtime.md)) |
| `skipReset` | false | Diagnostic: keep the previous run's fork cache |
| `prewarmBlocks` | 0 | Warmup blocks before the competition |
| `scoreEvery` | 1 | Thin the equity curve (**score-neutral**) |
| `epochBlocks` | 12 | Blocks per epoch |
| `epochSeconds` | 0 | Seconds per epoch (setting both throws) |
| `segmentHours` | 0 | Hours per output segment (0 = one directory) |
| `segmentName` | "" | Display name for the whole period |
| `markMedianBlocks` | 5 | The G7 median window |
| `reportDir` | `./runs` | Output root |
| `flashArb` | false | Deploy the FlashArb contract |
| `localSnapshotFile` | `.local-snapshot` | Where the snapshot id lives |
| `agentTimeoutMs` | 5000 | How long to wait on an agent |
| `agentsConfig` | `config/example.yaml` | Roster file when there is no inline `agents:` |
| `agentsDir` | `example/agents` | Root of the directory convention |
| `readRpcUrl` | same as `rpcUrl` | Split reads to a replica (`ERIS_READ_RPC_URL`) |

### `market` (the fair-price OU)

| Key | Default | |
|---|---|---|
| `volatility` | 0.004 | Width of the per-block uniform shock |
| `kappa` | 0.02 | Strength of mean reversion |
| `drift` | 0 | Direction |
| `baseVolatility` / `baseKappa` / `baseDrift` | — | Per-base overrides, written `{WBTC: ...}` |

### `funding`

| Key | Default | |
|---|---|---|
| `ethWei` | 100 ETH (3 ETH under `economicGas`) | An agent's native balance (**no gas buffer**) |
| `wethWei` | 10 WETH | Opening WETH |
| `usdcUnits` | 25,000 USDC | Opening USDC |
| `base` | `{WETH: wethWei}` | Opening inventory for other bases |
| `flowEthWei` | 1,000 ETH | Flow wallets' native balance |
| `flowWethWei` | 0 | Flow wallets' WETH |
| `flowBase` | {} | Flow wallets' other bases |

**The official regimes hand out an ETH/BTC/USDC basket** (8 WETH + 0.4 WBTC + 25k USDC, issue #54). They began as USDC-only (`wethWei: "0"`) to remove opening β (ADR 0017 §4), until it turned out that **the LST vault and the Trove are WETH/ETH denominated, so under USDC-only the sell side of every strategy had no inventory behind it**. The β cancels out of M9 because the benchmark holds the same funding — what USDC-only was protecting was `netPnlUsdc`, a reporting figure.

The only regimes still USDC-only are the **`metric-*`** ones, for a different reason (ADR 0019 §6: an epoch series is a live mark, so handed-out inventory puts the market's volatility into every agent's `std_e`). `scripts/genMetricRegimes.ts` drops `funding.base` along with the WETH when it generates them from the official regimes.

The template (`config/example.yaml`) hands out WETH for the same reason — it is for exploring, not for measuring.

### `limits`

| Key | Default | |
|---|---|---|
| `agentWethWei` | 1 WETH | Per-round swap input cap |
| `agentUsdcUnits` | 5,000 USDC | Likewise |
| `agentBase` / `lpBase` / `aaveSupplyBase` | `{WETH: ...}` | Per-base caps |
| `lpWethWei` / `lpUsdcUnits` | 1 WETH / 5,000 USDC | Liquidity provision |
| `bundleActions` | constant | Bundle size |
| `openPositions` | 10 | LP positions |
| `gmxSizeUsd` | 50,000 USD | Perp size |
| `aaveSupplyWethWei` / `aaveBorrowUsdcUnits` | 5 WETH / 5,000 USDC | Aave |
| `priorityFeeWei` | 0.1 gwei | Default priority fee |
| `maxPriorityFeeWei` | 5 gwei | Cap (effectively unlimited under `economicGas`) |

### `flow`

| Key | Default | |
|---|---|---|
| `uninformedMaxWethWei` | 1 WETH | Per-order cap |
| `uninformedCount` | 1 | Fixed count when λ=0 |
| `uninformedPersistBlocks` | 1 | Direction persistence window |
| `uninformedTrendCorrelation` | 0 | Probability of following the market-wide direction |
| `informedMaxWethWei` | 2 WETH | Size basis for the informed side |
| `balancerMaxWethWei` / `curveMaxWethWei` | 1 WETH | Per venue |
| `gmxMaxSizeUsd` | 20,000 USD | |
| `gmxActivityProb` / `gmxMaxBurst` | 0.5 / 2 | Legacy mode |
| `aaveMaxWethWei` | 2 WETH | |
| `aaveActivityProb` / `aaveActorCount` | 0.5 / 4 | The actor pool |
| `informedArbFeeBps` | **30** | The arbitrage fee band (0 disables) |
| `uninformedArrivalRate` / `uninformedSizeSigma` | **0.9 / 1.0** | Poisson arrivals / lognormal sizes |
| `gmxArrivalRate` / `gmxSizeSigma` | **0.75 / 1.0** | Same for GMX |
| `aaveActorSizeSigma` | **1.0** | Spread of actor collateral |
| `baseMax` | `{WETH: 0}` | AMM flow cap for other bases (0 = no flow for that base) |
| `seed` | same as `run.seed` | The flow bot's Rng |
| `botCommand` / `botArgs` | `node --import tsx core/src/flow/market-maker.ts` | |

> Poisson and lognormal increase variance, so read run comparisons as aggregates over several seeds.

### `stress` / `vuln` / `lst`

| Key | Default | |
|---|---|---|
| `stress.events` | [] | The event list ([04](04-stress-events.md)) |
| `stress.victimCount` / `victimHf0` / `victimWethWei` | 0 / 1.10 / 5 WETH | Liquidation victims |
| `vuln.events` / `poolLiquidityUsdcUnits` / `poolFeeBps` / `llm` | [] / 2M USDC / 30 / "0" | Vulnerability events (ADR 0014) |
| `lst.simulatedSecondsPerBlock` | 3600 | The economic clock (one block = one hour) |
| `lst.apyBps` | 300 | 3%/yr |
| `lst.apyRangeBps` / `apyStepBlocks` | — / 10 | Varying APY |
| `lst.withdrawalDelayBlocks` | 0 | Floor on the queue wait |
| `lst.queueThroughputWeiPerBlock` | 0 (unlimited) | Queue throughput |
| `lst.maxDepositWethWei` | 5 WETH | Per-stake cap |

## 7.4 CLI flags

One-off overrides (`CLI_ALIAS`, `core/src/runConfig.ts:147`).

| Flag | Key |
|---|---|
| `--config <path>` | Which config file |
| `--seed <N>` | `run.seed` |
| `--blocks <N>` / `--seconds <N>` | `run.blocks` / `run.seconds` |
| `--protocols <csv>` | `run.protocols` |
| `--agents <path>` | `run.agentsConfig` |
| `--economic-gas` | `run.economicGas` |
| `--local-deploy` | `run.localDeploy` |
| `--score-every <N>` | `run.scoreEvery` |
| `--chain-mode <mode>` | `run.chainMode` |

Parsed as `--key value`, `--key=value`, or a bare `--flag` (which means `"1"`).

**backtest's `--agents` is written into the effective regime YAML and reaches the agent processes.** Applying it only to the coordinator kills the agents on observation.

## 7.5 The roster

Either inline under `agents:`, or from the file named by `run.agentsConfig`.

```yaml
agents:
  - id: arb-bot                # runtime/bot.ts drives example/agents/arb-bot/
    wallet: AGENT2_PRIVATE_KEY
  - id: clean-arb-wide         # several instances of one strategy point at it with dir
    dir: clean-arb
    wallet: AUTO
    env: { ERIS_ARB_SAFETY_BPS: "150" }   # strategy parameters for that agent's process
  - id: partner-1              # an external participant; the environment starts nothing
    external: true
    address: "0x...."
```

### `AgentSpec` fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique; also the directory name |
| `dir` | | Override the real directory (for several instances of one strategy) |
| `wallet` | one of | `AGENT0..6_PRIVATE_KEY` or `AUTO` |
| `address` | one of | An external participant's address (requires `external: true`) |
| `command` / `args` | | Override for a fully self-contained agent (`args` requires `command`) |
| `env` | | String map passed to the agent process |
| `description` | | Free text |
| `baseline` | | **Marks the benchmark** ([06 §6.4](06-scoring.md)) |
| `external` | | A registration the participant runs themselves |

### Validation (`validateAgentsFile`)

| Check | Throws when |
|---|---|
| id | Empty or duplicated |
| wallet | Unsupported name, or a named wallet reused (**use `AUTO` for further agents**) |
| address | Given without `external`, not a 20-byte hex address, combined with `wallet`, or duplicated |
| external | Carries `command` / `args` / `dir` / `env` (**refused, not ignored**) |
| env | Non-string keys or values |

`AUTO` derives a key deterministically as `keccak256("auto-wallet:<seed>:<agentId>")`.

**With no roster file present**, the default is `noop` / `random` / `simple-rule`.

## 7.6 What config does not decide

| Subject | Where it is decided |
|---|---|
| Venue addresses | `sdk/src/constants.ts` (fork) / `constants.local.ts` (local, generated by `npm run gen:local-constants`) |
| Where the chain is | `.env.local`: `ANVIL_RPC_URL` / `CHAIN_ID` / `TREASURY_PRIVATE_KEY` |
| Pool calibration (depth / A / fees) | `deployer/` |
| The action vocabulary | `sdk/src/action.ts` |

**Switching between a local node and a devnet is two axes in two different places**: the **chain** (`.env.local` plus `--chain-mode external`) and the **addresses** (`DEPLOYMENTS_JSON=<path> npm run gen:local-constants`). The config file itself is shared. **Only one address overlay exists at a time**, so moving deployments means regenerating. Moving only one axis used to surface, minutes into setup, as `Cannot decode zero data ("0x")` and a bare address — so the deployment is now **measured at startup and the run stops**, naming what is missing and the command that regenerates it (`deployment_check`).

## 7.7 The config files

| File | Purpose |
|---|---|
| `config/example.yaml` | The committed template (`run.localDeploy: true`) |
| `config/local.yaml` | The file actually used (gitignored) |
| `config/practice.yaml` | The practice devnet |
| `config/lst.yaml` | Single-venue verification with the calibration knobs spelled out |
| `config/liquity.yaml` | The same for Liquity. **Caught by `.gitignore`'s `config/*.yaml` and not in the repo** — a fresh clone does not have it |
| `config/vuln-test.yaml` | Vulnerability events |
| `config/regimes/<name>.yaml` | The official regimes (read by backtest) |
| `config/scenarios/<name>.yaml` | Scenario sets (the cartesian product of `{regimes, seeds}`) |
| `config/rosters/` | Replacement rosters |
