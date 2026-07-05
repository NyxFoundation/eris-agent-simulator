[← README](../../README.md)

# Protocols and Actions

Each adapter (`sdk/src/protocols/<name>.ts`) implements parse/validate, calldata construction (buildTxs), observation (readState / observe), PnL valuation (valueUsdc), and a setup hook (orderflow generation is the environment's job in `core/src/flow/`). Active protocols are chosen per run via the config's `run.protocols` (YAML array) or the CLI flag `--protocols uniswap,balancer,curve,aave,gmx`. Agent JSON actions:

| Protocol | Actions | venue (fork = Arbitrum / local = deployer-deployed) |
|---|---|---|
| Uniswap V3 | `swap`, `mintLiquidity`, `removeLiquidity`, `collectFees` | fork: WETH/USDC 0.05% pool / local: WETH/USDC 0.3% pool |
| Balancer v2 | `balancerSwap` | fork: 33/33/34 WETH/USDC/USDT weighted (seeded at fork time) / local: 50/50 WETH/USDC |
| Curve | `curveSwap` | fork: tricrypto WETH↔USDT / local: twocrypto-ng WETH/USDC |
| Aave v3 | `aaveSupply`, `aaveWithdraw`, `aaveBorrow`, `aaveRepay` | native USDC / WETH reserves |
| GMX v2 | `gmxIncrease`, `gmxDecrease` | ETH/USD perp market |

The table shows the default WETH markets. If a WBTC leg (`MARKET_LEGS`) is deployed in the local deploy, add `base: "WBTC"` to the same actions to also trade the WBTC/USDC spot, GMX WBTC market, and Aave WBTC reserve (multi-asset; ADR 0013).

In addition there are the protocol-agnostic `noop` / `bundle` (multiple bundleable leaves in a single tx) / `rawTx` / `rawBundle`.

> Actions are expressed as JSON. `bundle` groups bundleable leaves into a single tx (GMX is async, so it can only be sent alone). `rawTx` / `rawBundle` also let you send raw calldata. The per-round trade size limits (config's `limits`: `agentWethWei` / `agentUsdcUnits` / `agentBase`) are applied as **pre-validation of semantic actions** — `rawTx` / `rawBundle` do not interpret calldata and so are exempt from the amount limits (only priority fee and bundle count are validated; fee violations are detected after the fact = recorded in `violations` by `postRunCheck`).

## Stablecoin Accounting

Arbitrum's deep WETH/stable liquidity lives in the USDC.e / USDT pools, so native USDC, USDC.e, and USDT are all summed into balances and PnL as **USDC-equivalent** at `$1` and 6 decimals (`setActiveStables` / `getBalances` in `sdk/src/chain.ts`). Uniswap / Aave / GMX use native USDC, Balancer uses native USDC (its pool is seeded at fork time), and Curve uses USDT on fork and USDC on local.

## Oracle Control (Aave v3 / GMX v2)

Mock oracles (`contracts/MockAggregator.sol` / `contracts/MockOracleProvider.sol`) are deployed in setup (in a local deploy they connect to the deployer's venues the same way). For Aave, the coordinator impersonates the ACL admin to point `AaveOracle` at the mock; for GMX, it impersonates `ROLE_ADMIN` to grant the keeper / controller roles and registers the mock provider in `DataStore`. Each round, `updateOracles` writes the fair price into both mocks, moving the health factors of loans and the mark price of perps. Runs that build stress victims in a local deploy calibrate the Aave oracle to the initial fair price before victim setup (see [Market Stress Events](stress-events.md)).

## GMX Async Execution

GMX is async (order creation → keeper execution). In realtime, each block advances via interval mining, and after each block (`afterMine`) the coordinator reads the `OrderCreated` logs of the latest block and executes each order as the keeper. Intra-block ordering is determined by anvil's `--order fees` (descending priority fee). GMX position changes become visible to agents about one block late. GMX actions can only be sent alone (no bundling).
