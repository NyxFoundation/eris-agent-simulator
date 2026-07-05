# eris-app-deployer

A TypeScript/viem orchestrator that deploys the major DeFi protocols from scratch onto an empty (non-fork) **anvil** chain, and provisions pools/markets down to initial liquidity.

| Protocol | Status | Deployment method |
|---|---|---|
| Uniswap V3 | ✅ | Deploy the official `@uniswap/v3-core` / `v3-periphery` artifacts directly with viem |
| Balancer V2 | ✅ | Deploy the `@balancer-labs/v2-deployments` bytecode sequentially with viem |
| Aave V3 | ✅ | Run `@aave/deploy-v3` (hardhat-deploy) via `vendor/aave` |
| Curve | ✅ | Deploy prebuilt bytecode of `stableswap-ng` built with Vyper 0.3.10, using viem |
| GMX V2 | ✅ | Run `vendor/gmx-src` (gmx-synthetics, hardhat-deploy), patched for localhost support |

## Prerequisites

- Node.js 18+ (verified on 23.x)
- Foundry (`anvil`, `forge`) installed

## Setup

```bash
npm install
forge build                 # compile shared mock tokens (WETH9 / MockERC20)
cp .env.example .env
./scripts/setup-vendors.sh  # clone+patch external repos (GMX), install Aave deps
```

> **Vendor layout**
> - Clones of external repositories (`vendor/gmx-src`, `vendor/curve-src`) are **not tracked by git**.
>   `scripts/setup-vendors.sh` clones them at pinned commits and applies
>   `vendor/gmx-localhost.patch` to GMX. The patch = changes needed to get
>   hardhat-deploy through on `localhost` (anvil): `hardhat`/`localhost` detection, `chainId`,
>   `localhost` keys in each config, making `setBalance` anvil-compatible, etc. (see `docs/adr` for details).
> - `vendor/curve` **commits** the `{abi, bytecode/blueprintBytecode}` JSON built from
>   `curvefi/stableswap-ng` with Vyper 0.3.10 (Docker). Vyper is not needed at runtime.
>   Only to rebuild, clone `vendor/curve-src` and use
>   `docker run --rm -v $PWD:/code vyperlang/vyper:0.3.10 -f <fmt> <file>`.
> - `vendor/aave` is a minimal hardhat project (config only, committed) that loads `@aave/deploy-v3`.

## Usage

The deployer starts and maintains anvil itself (`MANAGE_ANVIL=true`).

```bash
# Deploy all protocols onto an empty anvil (anvil is kept running)
npm run deploy -- --keep-fresh
```

Main flags:

- `--only uniswap,balancer` — limit to the target protocols (e.g. `--only gmx`)
- `--no-seed` — skip pool creation / liquidity provisioning (core contracts only)
- `--keep-fresh` — reset `deployments/deployments.json` before starting
- `--exit` — stop anvil and exit after completion (for CI)

### E2E verification (vitest)

Against a running anvil + a deployed `deployments.json`, verify each protocol with vitest for
quantitative checks, round-trip/lifecycle, negative tests, and deployment health.
For GMX V2, it registers `MockOracleProvider` (`contracts/`) with the DataStore, and verifies the full E2E
where a trader creates a deposit/order → a keeper executes it with an oracle price (GM liquidity provisioning → openPosition).
Since this is a separate process from deployment, run it against an external anvil connection (`MANAGE_ANVIL=false`):

```bash
npm run anvil &                            # start anvil (--balance etc. are set in the npm script)
MANAGE_ANVIL=false npm run deploy -- --keep-fresh
MANAGE_ANVIL=false npm run test:e2e        # run test/*.test.ts
```

CI (the `deploy` job in `.github/workflows/ci.yml`) also verifies all protocols in this order.

> GMX V2 deploys 150+ contracts via hardhat-deploy, so the first run takes a few minutes
> (Solidity compilation is cached). Individual runs are also possible with `--only gmx`.

If anvil is already running in another terminal, set `MANAGE_ANVIL=false` in `.env`.
Start anvil with `--code-size-limit 50000` to support large contracts
(`npm run anvil` starts with this setting).

## Output

All addresses are aggregated into `deployments/deployments.json`:

```jsonc
{
  "chainId": 31337,
  "tokens": { "WETH": "0x..", "USDC": "0x..", ... },  // shared mock tokens
  "protocols": {
    "uniswapV3": { "factory": "0x..", "swapRouter": "0x..", "wethUsdcPool": "0x.." },
    "balancerV2": { "vault": "0x..", "wethUsdcPoolId": "0x.." },
    "aaveV3": { "pool": "0x..", "aaveOracle": "0x..", "tokens": {..}, "aTokens": {..} }
  }
}
```

> Aave uses a separate system from the shared mock tokens, because `@aave/deploy-v3` generates
> its own test tokens (USDC/WETH/WBTC/DAI...). For Aave addresses, refer to
> `protocols.aaveV3.tokens`.

## Architecture

```
src/
├── index.ts           orchestrator (CLI)
├── anvil.ts           anvil process start/wait
├── clients.ts         viem clients + accounts
├── config.ts          chain / token definitions
├── tokens.ts          deployment of shared mock tokens
├── registry.ts        deployments.json aggregation
├── erc20.ts           generic ERC20 helpers
├── verify.ts          E2E smoke check
└── protocols/
    ├── uniswap-v3.ts
    ├── balancer-v2.ts
    ├── aave-v3.ts
    ├── curve.ts
    └── gmx-v2.ts
contracts/             shared mock tokens (WETH9.sol, MockERC20.sol)
vendor/aave/           minimal hardhat project that runs @aave/deploy-v3
vendor/curve/          Curve bytecode prebuilt with Vyper (JSON)
vendor/gmx-src/        gmx-synthetics clone (patched for localhost support)
```
