import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Address } from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain, RPC_URL } from "../config.js";
import { ROOT, waitTx, ok, info, assert } from "../util.js";
import { setProtocol, getRegistry } from "../registry.js";

const dep = accounts.deployer;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const AAVE_DIR = resolve(ROOT, "vendor", "aave");
const DEPLOYMENTS = resolve(AAVE_DIR, "deployments", "localhost");

function readDeployment(name: string): { address: Address; abi: Abi } {
  const j = JSON.parse(
    readFileSync(resolve(DEPLOYMENTS, `${name}.json`), "utf8"),
  );
  return { address: j.address as Address, abi: j.abi as Abi };
}

// Target tokens (Aave test token keys)
const TOKEN_KEYS = ["WETH", "USDC", "WBTC", "USDT", "DAI"] as const;

export async function deployAaveV3({ seed }: { seed: boolean }) {
  info("Deploying the full Aave V3 market via hardhat-deploy");

  // Remove the previous deployments to support a fresh anvil
  rmSync(DEPLOYMENTS, { recursive: true, force: true });

  const res = spawnSync(
    "npx",
    [
      "hardhat",
      "deploy",
      "--network",
      "localhost",
      "--tags",
      "market,periphery-post",
    ],
    {
      cwd: AAVE_DIR,
      env: { ...process.env, MARKET_NAME: "Aave", RPC_URL },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (res.status !== 0) {
    throw new Error(`aave hardhat deploy failed (exit ${res.status})`);
  }
  assert(
    existsSync(DEPLOYMENTS),
    "aave deployments/localhost was not generated",
  );

  // Import the addresses of the main contracts
  const core = {
    pool: readDeployment("Pool-Proxy-Aave").address,
    poolAddressesProvider: readDeployment("PoolAddressesProvider-Aave").address,
    poolConfigurator: readDeployment("PoolConfigurator-Proxy-Aave").address,
    aaveOracle: readDeployment("AaveOracle-Aave").address,
    poolDataProvider: readDeployment("PoolDataProvider-Aave").address,
    aclManager: readDeployment("ACLManager-Aave").address,
    faucet: readDeployment("Faucet-Aave").address,
  };

  // test token + aToken addresses
  const tokens: Record<string, Address> = {};
  const aTokens: Record<string, Address> = {};
  const files = readdirSync(DEPLOYMENTS);
  for (const key of TOKEN_KEYS) {
    const tFile = `${key}-TestnetMintableERC20-Aave`;
    const aFile = `${key}-AToken-Aave`;
    if (files.includes(`${tFile}.json`))
      tokens[key] = readDeployment(tFile).address;
    if (files.includes(`${aFile}.json`))
      aTokens[key] = readDeployment(aFile).address;
  }

  setProtocol("aaveV3", { ...core, tokens, aTokens });
  ok("Aave V3 deploy", `pool=${core.pool}`);
  ok("test tokens", Object.keys(tokens).join(", "));

  // Additionally register the shared mock tokens (WETH/USDC) as reserves.
  // Aave deploy-v3 creates reserves with its own test tokens, so post-deploy we
  // separately stand up reserves for the shared tokens usable across protocols.
  await registerSharedReserves();

  if (seed) {
    await seedSharedSupplyBorrow();
  }
}

// Tokens to add reserves for on the shared tokens (config cloned from Aave's own reserve).
// For WBTC, clone the config measured from Aave's own reserve (LTV=7000/LT=7500/aggregator $60k).
const SHARED_RESERVE_KEYS = ["WETH", "USDC", "WBTC"] as const;

/**
 * Retroactively register the deployer's shared mock tokens (WETH=WETH9 / USDC=MockERC20)
 * as Aave reserves. Measure and clone the interest rate strategy, LTV/LT, etc. from Aave's
 * own same-named reserve, and reuse Aave's already-deployed MockAggregator (updatable) as the
 * price source. The deployer is POOL_ADMIN, so it can call PoolConfigurator / AaveOracle directly.
 */
async function registerSharedReserves() {
  const reg = getRegistry();
  const configuratorAddr = readDeployment(
    "PoolConfigurator-Proxy-Aave",
  ).address;
  const configuratorAbi = readDeployment("PoolConfigurator-Implementation").abi;
  const oracle = readDeployment("AaveOracle-Aave");
  const poolAbi = poolImplAbi();
  const pdpAddr = readDeployment("PoolDataProvider-Aave").address;
  const pdpAbi = readDeployment("PoolDataProvider-Aave").abi;
  const { pool } = aave();

  const aTokenImpl = readDeployment("AToken-Aave").address;
  const stableDebtImpl = readDeployment("StableDebtToken-Aave").address;
  const variableDebtImpl = readDeployment("VariableDebtToken-Aave").address;
  const treasury = readDeployment("TreasuryProxy").address;
  const incentives = readDeployment("IncentivesProxy").address;

  const inputs: Record<string, unknown>[] = [];
  const sources: { asset: Address; src: Address }[] = [];
  const configs: {
    asset: Address;
    ltv: bigint;
    lt: bigint;
    bonus: bigint;
    factor: bigint;
  }[] = [];

  for (const key of SHARED_RESERVE_KEYS) {
    const shared = reg.tokens[key];
    const aaveOwn = aave().tokens?.[key];
    if (!shared || !aaveOwn) {
      info(`shared reserve ${key}: skipping (address unresolved)`);
      continue;
    }
    // Do nothing if it is already a reserve (idempotent on re-run)
    const existing = (await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "getReserveData",
      args: [shared],
    })) as { aTokenAddress: Address };
    if (existing.aTokenAddress && existing.aTokenAddress !== ZERO_ADDRESS) {
      ok(`shared reserve ${key}`, "skipping (already exists)");
      continue;
    }

    // Measure and clone the config from Aave's own reserve (avoids magic numbers)
    const rd = (await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "getReserveData",
      args: [aaveOwn],
    })) as { interestRateStrategyAddress: Address };
    const cfg = (await publicClient.readContract({
      address: pdpAddr,
      abi: pdpAbi,
      functionName: "getReserveConfigurationData",
      args: [aaveOwn],
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const decimals = Number(cfg[0]);

    const aggName = `${key}-TestnetPriceAggregator-Aave`;
    sources.push({ asset: shared, src: readDeployment(aggName).address });
    inputs.push({
      aTokenImpl,
      stableDebtTokenImpl: stableDebtImpl,
      variableDebtTokenImpl: variableDebtImpl,
      underlyingAssetDecimals: decimals,
      interestRateStrategyAddress: rd.interestRateStrategyAddress,
      underlyingAsset: shared,
      treasury,
      incentivesController: incentives,
      aTokenName: `Aave Shared ${key}`,
      aTokenSymbol: `aSh${key}`,
      variableDebtTokenName: `Aave Shared Variable Debt ${key}`,
      variableDebtTokenSymbol: `variableDebtSh${key}`,
      stableDebtTokenName: `Aave Shared Stable Debt ${key}`,
      stableDebtTokenSymbol: `stableDebtSh${key}`,
      params: "0x10",
    });
    configs.push({
      asset: shared,
      ltv: cfg[1],
      lt: cfg[2],
      bonus: cfg[3],
      factor: cfg[4],
    });
  }

  if (inputs.length === 0) return;
  info("Aave V3: registering reserves for the shared tokens");

  // 1. set the price source on AaveOracle (reuse the existing MockAggregator)
  let h = await deployerWallet.writeContract({
    address: oracle.address,
    abi: oracle.abi,
    functionName: "setAssetSources",
    args: [sources.map((s) => s.asset), sources.map((s) => s.src)],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);

  // 2. create the reserves via initReserves
  h = await deployerWallet.writeContract({
    address: configuratorAddr,
    abi: configuratorAbi,
    functionName: "initReserves",
    args: [inputs],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);

  // 3. enable as collateral + enable borrowing + set reserveFactor (same values as Aave's own reserve)
  const sharedATokens: Record<string, Address> = {};
  const sharedDebtTokens: Record<string, Address> = {};
  for (const c of configs) {
    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "configureReserveAsCollateral",
      args: [c.asset, c.ltv, c.lt, c.bonus],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "setReserveBorrowing",
      args: [c.asset, true],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "setReserveFactor",
      args: [c.asset, c.factor],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }

  // Record aToken / variableDebtToken addresses in the registry (for poc / test)
  for (const key of SHARED_RESERVE_KEYS) {
    const shared = reg.tokens[key];
    if (!shared) continue;
    const toks = (await publicClient.readContract({
      address: pdpAddr,
      abi: pdpAbi,
      functionName: "getReserveTokensAddresses",
      args: [shared],
    })) as readonly [Address, Address, Address];
    sharedATokens[key] = toks[0];
    sharedDebtTokens[key] = toks[2];
  }
  setProtocol("aaveV3", {
    sharedReserves: {
      tokens: Object.fromEntries(
        SHARED_RESERVE_KEYS.map((k) => [k, reg.tokens[k]]).filter(([, v]) => v),
      ),
      aTokens: sharedATokens,
      variableDebtTokens: sharedDebtTokens,
    },
  });
  ok(
    "shared reserve registration",
    SHARED_RESERVE_KEYS.filter((k) => reg.tokens[k]).join(", "),
  );
}

/** Mint test tokens to the deployer via the Faucet */
async function faucetMint(token: Address, amount: bigint) {
  const faucet = readDeployment("Faucet-Aave");
  const h = await deployerWallet.writeContract({
    address: faucet.address,
    abi: faucet.abi,
    functionName: "mint",
    args: [token, dep.address, amount],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
}

const ERC20_MIN = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

function poolImplAbi(): Abi {
  return readDeployment("Pool-Implementation").abi;
}

function aave(): { pool: Address; tokens: Record<string, Address> } {
  return getRegistry().protocols.aaveV3 as {
    pool: Address;
    tokens: Record<string, Address>;
  };
}

/** mint via faucet -> approve -> Pool.supply. token is an Aave test token. */
async function supplyAsset(token: Address, amount: bigint, label: string) {
  const { pool } = aave();
  const poolAbi = poolImplAbi();
  await faucetMint(token, amount);
  let h = await deployerWallet.writeContract({
    address: token,
    abi: ERC20_MIN,
    functionName: "approve",
    args: [pool, amount],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  h = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "supply",
    args: [token, amount, dep.address, 0],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("supply", label);
}

async function borrowAsset(token: Address, amount: bigint, label: string) {
  const { pool } = aave();
  const h = await deployerWallet.writeContract({
    address: pool,
    abi: poolImplAbi(),
    functionName: "borrow",
    args: [token, amount, 2n, 0, dep.address], // mode=2 (variable)
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("borrow", label);
}

async function accountData(): Promise<readonly bigint[]> {
  const { pool } = aave();
  return (await publicClient.readContract({
    address: pool,
    abi: poolImplAbi(),
    functionName: "getUserAccountData",
    args: [dep.address],
  })) as readonly bigint[];
}

/**
 * E2E: supply USDC (= borrowable liquidity) with WETH as collateral, then borrow USDC.
 * The borrowed asset needs liquidity beforehand (aToken backing). Keep within the faucet cap (10k).
 */
async function seedSupplyBorrow() {
  info("Aave V3: supply USDC/WETH -> borrow USDC");
  const { tokens } = aave();
  await supplyAsset(
    tokens.USDC,
    9000n * 10n ** 6n,
    "9000 USDC (liquidity+collateral)",
  );
  await supplyAsset(tokens.WETH, 10n * 10n ** 18n, "10 WETH (collateral)");
  await borrowAsset(tokens.USDC, 1000n * 10n ** 6n, "1000 USDC");

  const acct = await accountData(); // [collateralBase, debtBase, availableBorrowsBase, ...]
  assert(acct[0] > 0n, "collateral was not recorded");
  assert(acct[1] > 0n, "borrow was not recorded");
  ok("account data", `collateral=${acct[0]} debt=${acct[1]} (base units)`);
}

/** approve -> Pool.supply. No faucet needed since the deployer already holds the shared tokens. */
async function supplySharedAsset(
  token: Address,
  amount: bigint,
  label: string,
) {
  const { pool } = aave();
  let h = await deployerWallet.writeContract({
    address: token,
    abi: ERC20_MIN,
    functionName: "approve",
    args: [pool, amount],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  h = await deployerWallet.writeContract({
    address: pool,
    abi: poolImplAbi(),
    functionName: "supply",
    args: [token, amount, dep.address, 0],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("supply (shared)", label);
}

/**
 * Sanity-check the shared mock token (WETH/USDC) reserves with one supply -> borrow round trip.
 * No faucet needed: the deployer holds WETH (wrap) and USDC (mint) balances from deployTokens.
 */
async function seedSharedSupplyBorrow() {
  const reg = getRegistry();
  const weth = reg.tokens.WETH;
  const usdc = reg.tokens.USDC;
  if (!weth || !usdc) {
    info("shared seed: skipping (WETH/USDC not deployed)");
    return;
  }
  info("Aave V3: supply shared USDC/WETH -> borrow shared USDC");
  await supplySharedAsset(
    usdc,
    9000n * 10n ** 6n,
    "9000 USDC (liquidity+collateral)",
  );
  await supplySharedAsset(weth, 10n * 10n ** 18n, "10 WETH (collateral)");
  await borrowAsset(usdc, 1000n * 10n ** 6n, "1000 USDC");

  const acct = await accountData();
  assert(acct[0] > 0n, "shared collateral was not recorded");
  assert(acct[1] > 0n, "shared borrow was not recorded");
  ok("account data (shared)", `collateral=${acct[0]} debt=${acct[1]}`);
}
