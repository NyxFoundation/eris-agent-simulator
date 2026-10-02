import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Address } from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain, MNEMONIC, RPC_URL } from "../config.js";
import { ROOT, waitTx, ok, info, assert } from "../util.js";
import { setProtocol, getRegistry } from "../registry.js";
import { vendorReserves } from "./aave-reserves.js";

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

function readArtifact(name: string): { abi: Abi; bytecode: `0x${string}` } {
  const j = JSON.parse(
    readFileSync(resolve(DEPLOYMENTS, `${name}.json`), "utf8"),
  );
  return { abi: j.abi as Abi, bytecode: j.bytecode as `0x${string}` };
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
      // MNEMONIC: vendor/aave/hardhat.config.js derives its accounts from it, so every Aave role
      // (deployer / aclAdmin / poolAdmin) lands on the same account this process signs with
      // (issue #74). Explicit rather than inherited, because this is the normalized form.
      // PERMISSIONED_FAUCET: @aave/deploy-v3 reads it in helpers/env.js and defaults to false, which
      // deploys a Faucet anyone can mint 10,000 of each test token from (issue #190). Explicit
      // here so the default is never what decides it; closeVendorTestMarket() checks the result.
      env: {
        ...process.env,
        MARKET_NAME: "Aave",
        RPC_URL,
        MNEMONIC,
        PERMISSIONED_FAUCET: "true",
      },
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

  // After the shared reserves have cloned their parameters from these, before anything is seeded.
  await closeVendorTestMarket();

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

// ---------------------------------------------------------------------------
// LST as a reserve (issue #38 phase 3)
// ---------------------------------------------------------------------------

// Aave's own reserves supply the risk parameters for the shared tokens above by cloning a
// same-named market. An LST has no such source, so its parameters are stated here instead. These
// sit a notch below Arbitrum's real wstETH market (LTV 78.5% / LT 81%): the vault can be slashed
// and the secondary market is thin, both of which argue for less leverage, and a conservative
// number makes the liquidation cascade a tail event rather than the default outcome.
const LST_LTV = 7000n; // 70%
const LST_LIQUIDATION_THRESHOLD = 7500n; // 75%
const LST_LIQUIDATION_BONUS = 10_750n; // 7.5% bonus (Aave encodes it as 100% + bonus)
const LST_RESERVE_FACTOR = 1500n; // 15%

/// Register the LST vault's share token as an Aave reserve: collateral only, no borrowing.
///
/// Collateral-only mirrors how liquid staking tokens are actually listed (nobody borrows wstETH
/// meaningfully; the point is borrowing ETH *against* it), and it keeps the leverage loop to the
/// one the venue is about — stake, post as collateral, borrow WETH, stake again.
///
/// The price source is a MockAggregator of its own rather than a borrowed one, because the LST is
/// not worth the same as WETH: it is worth WETH x the vault's redemption rate, and that rate rises
/// with yield and falls with a slash. The environment writes it every block, so the oracle lags
/// the vault by exactly one block — the same lag every other price in this simulation has, and the
/// thing that makes a slash reach health factors a block after it reaches the vault.
export async function registerLstReserve(
  lstToken: Address,
  redemptionRateWad: bigint,
): Promise<{
  aggregator: Address;
  aToken: Address;
  variableDebtToken: Address;
}> {
  info("Aave V3: registering the LST reserve (collateral only)");
  const configuratorAddr = readDeployment(
    "PoolConfigurator-Proxy-Aave",
  ).address;
  const configuratorAbi = readDeployment("PoolConfigurator-Implementation").abi;
  const oracle = readDeployment("AaveOracle-Aave");
  const poolAbi = poolImplAbi();
  const pdpAddr = readDeployment("PoolDataProvider-Aave").address;
  const pdpAbi = readDeployment("PoolDataProvider-Aave").abi;
  const { pool, tokens } = aave();

  // The opening price has to be WETH x the redemption rate *at Aave's own WETH price*, not at the
  // price the spot venues were seeded with. Those differ (Aave's testnet WETH aggregator says
  // $4000, the pools are seeded at $3000), and using the seed price listed the LST 25% below its
  // collateral value until the environment's first per-block write corrected it -- a window in
  // which health factors were wrong.
  const wethPriceUsd8 = (await publicClient.readContract({
    address: oracle.address,
    abi: oracle.abi,
    functionName: "getAssetPrice",
    args: [tokens.WETH],
  })) as bigint;
  const initialPriceUsd8 = (wethPriceUsd8 * redemptionRateWad) / 10n ** 18n;

  const existing = (await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "getReserveData",
    args: [lstToken],
  })) as { aTokenAddress: Address };
  const fresh =
    !existing.aTokenAddress || existing.aTokenAddress === ZERO_ADDRESS;

  // The aggregator is deployed only when it will actually be wired. Deploying it first meant a
  // re-run on an existing reserve returned a brand new contract that setAssetSources never pointed
  // at, which then went into deployments.json and constants as "the LST's price source" while
  // nothing read it -- and burned a CREATE, shifting every later address on a nominal no-op.
  let aggregator: Address;
  if (fresh) {
    // From Aave's own MockAggregator, so the storage layout matches what the environment writes to
    // (the answer in slot 0).
    const aggArtifact = readArtifact("WETH-TestnetPriceAggregator-Aave");
    const aggHash = await deployerWallet.deployContract({
      abi: aggArtifact.abi,
      bytecode: aggArtifact.bytecode,
      args: [initialPriceUsd8],
      account: dep,
      chain: anvilChain,
    });
    aggregator = (await waitTx(aggHash)).contractAddress as Address;
    ok("LST price aggregator", aggregator);
  } else {
    aggregator = (await publicClient.readContract({
      address: oracle.address,
      abi: oracle.abi,
      functionName: "getSourceOfAsset",
      args: [lstToken],
    })) as Address;
    ok("LST price aggregator", `${aggregator} (existing)`);
  }

  if (fresh) {
    // The interest rate strategy is cloned from WETH: nothing is borrowable here, so the curve only
    // ever prices supply, and WETH's is the closest thing to an ETH-denominated asset's.
    const wethReserve = (await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "getReserveData",
      args: [tokens.WETH],
    })) as { interestRateStrategyAddress: Address };

    let h = await deployerWallet.writeContract({
      address: oracle.address,
      abi: oracle.abi,
      functionName: "setAssetSources",
      args: [[lstToken], [aggregator]],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);

    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "initReserves",
      args: [
        [
          {
            aTokenImpl: readDeployment("AToken-Aave").address,
            stableDebtTokenImpl: readDeployment("StableDebtToken-Aave").address,
            variableDebtTokenImpl: readDeployment("VariableDebtToken-Aave")
              .address,
            underlyingAssetDecimals: 18,
            interestRateStrategyAddress:
              wethReserve.interestRateStrategyAddress,
            underlyingAsset: lstToken,
            treasury: readDeployment("TreasuryProxy").address,
            incentivesController: readDeployment("IncentivesProxy").address,
            aTokenName: "Aave Eris LST",
            aTokenSymbol: "aErLST",
            variableDebtTokenName: "Aave Variable Debt Eris LST",
            variableDebtTokenSymbol: "variableDebtErLST",
            stableDebtTokenName: "Aave Stable Debt Eris LST",
            stableDebtTokenSymbol: "stableDebtErLST",
            params: "0x10",
          },
        ],
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);

    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "configureReserveAsCollateral",
      args: [
        lstToken,
        LST_LTV,
        LST_LIQUIDATION_THRESHOLD,
        LST_LIQUIDATION_BONUS,
      ],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    h = await deployerWallet.writeContract({
      address: configuratorAddr,
      abi: configuratorAbi,
      functionName: "setReserveFactor",
      args: [lstToken, LST_RESERVE_FACTOR],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
    // Deliberately not calling setReserveBorrowing: the LST is collateral, not something to borrow.
  } else {
    ok("LST reserve", "already exists, reusing");
  }

  const toks = (await publicClient.readContract({
    address: pdpAddr,
    abi: pdpAbi,
    functionName: "getReserveTokensAddresses",
    args: [lstToken],
  })) as readonly [Address, Address, Address];
  ok(
    "LST reserve",
    `LTV ${Number(LST_LTV) / 100}% / LT ${Number(LST_LIQUIDATION_THRESHOLD) / 100}% / collateral only`,
  );
  return { aggregator, aToken: toks[0], variableDebtToken: toks[2] };
}

// ---------------------------------------------------------------------------
// Aave's own test market (issue #190)
// ---------------------------------------------------------------------------

// The test tokens @aave/deploy-v3 lists for MARKET_NAME=Aave, each minted by its Faucet. Read from
// the deployment files rather than from TOKEN_KEYS, which records only five of the eight: AAVE /
// LINK / EURS exist on chain and in vendor/aave/deployments, and nowhere else. Used only to name
// what the closer acts on; *which* reserves it acts on comes from the Pool (./aave-reserves.ts).
function vendorTestTokens(): { key: string; address: Address }[] {
  const suffix = "-TestnetMintableERC20-Aave.json";
  return readdirSync(DEPLOYMENTS)
    .filter((f) => f.endsWith(suffix))
    .map((f) => {
      const key = f.slice(0, -suffix.length);
      return { key, address: readDeployment(f.slice(0, -5)).address };
    });
}

const RESERVE_CONFIG_ABI = [
  {
    type: "function",
    name: "getReserveConfigurationData",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getReserveTokensAddresses",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
  },
] as const satisfies Abi;

const TOTAL_SUPPLY_ABI = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "RESERVE_TREASURY_ADDRESS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const satisfies Abi;

// PoolDataProvider.getReserveData: the second field is the treasury's share of interest that has
// accrued but not yet been minted to it as aTokens (scaled). PoolConfigurator._checkNoSuppliers
// requires it to be zero alongside the aToken supply before setReserveActive(false) will go through.
const RESERVE_DATA_ABI = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
  },
] as const satisfies Abi;

export type VendorReserveOutcome = {
  key: string;
  asset: Address;
  // "deactivated" = setReserveActive(false) went through: no aTokens, no debt, nothing accrued to
  //                 the treasury (Aave's own precondition, PoolConfigurator._checkNoSuppliers).
  // "frozen-treasury-only" = only the treasury's share of past interest is left (accrued, or minted
  //                 to it as aTokens), which Aave will not let a reserve be deactivated over and
  //                 nobody but the treasury can ever clear. No participant holds anything and
  //                 freezing stops new supply and borrow, so this is a closed reserve.
  // "frozen" = a participant still supplies or borrows here. New supply and borrow are stopped,
  //            but what they hold keeps counting in getUserAccountData. Needs a decision.
  // "failed" = the freeze/deactivate transaction itself reverted (reason in `error`).
  // "already-inactive" = nothing to do.
  status:
    | "deactivated"
    | "frozen-treasury-only"
    | "frozen"
    | "failed"
    | "already-inactive";
  participantSupply?: string;
  treasurySupply?: string;
  accruedToTreasuryScaled?: string;
  debt?: string;
  error?: string;
};

/**
 * Take Aave's own test market out of the competition (issue #190).
 *
 * @aave/deploy-v3 lists eight reserves on test tokens (fixed-price MockAggregators: WETH $4,000,
 * WBTC $60,000, ...) and deploys a Faucet that, unpermissioned, gives anyone 10,000 of each per
 * call. The environment never uses those reserves -- every agent, flow actor and victim works on
 * the shared reserves registered above -- but they sit in the same Pool, and that is enough:
 * getUserAccountData sums every reserve, so supplying faucet tokens is score (the Aave adapter
 * marks collateral minus debt) and collateral to borrow the real shared USDC/WETH against.
 *
 * Two layers, because each closes a different half:
 *   - Faucet.setPermissioned(true): only the owner (the deployer) can mint. The deployer's own
 *     faucetMint keeps working.
 *   - setReserveActive(false) on each vendor reserve: closes the Pool to those tokens however they
 *     were obtained, including any minted before the Faucet was closed. Aave allows it only while
 *     the reserve has no aTokens *and* nothing accrued to the treasury -- a reserve that was ever
 *     borrowed from keeps the treasury's cut of the interest after everyone has repaid and left.
 *     Anything else is frozen instead: harmless when the residue is the treasury's alone, reported
 *     when a participant still holds something, because that keeps counting and deciding it is not
 *     this function's call.
 *
 * Idempotent, so it also serves a chain that is already running (`npm run close:aave-vendor`).
 */
export async function closeVendorTestMarket(): Promise<VendorReserveOutcome[]> {
  // Decided first: vendorReserves refuses a deployments.json that is not this chain's before the
  // Faucet or any reserve is touched.
  const listed = (await publicClient.readContract({
    address: aave().pool,
    abi: poolImplAbi(),
    functionName: "getReservesList",
  })) as readonly Address[];
  const vendorKeys = new Map(
    vendorTestTokens().map(({ key, address }) => [address.toLowerCase(), key]),
  );
  const targets = vendorReserves(listed, getRegistry(), SHARED_RESERVE_KEYS, vendorKeys);

  const faucet = readDeployment("Faucet-Aave");
  const permissioned = (await publicClient.readContract({
    address: faucet.address,
    abi: faucet.abi,
    functionName: "isPermissioned",
  })) as boolean;
  if (!permissioned) {
    const h = await deployerWallet.writeContract({
      address: faucet.address,
      abi: faucet.abi,
      functionName: "setPermissioned",
      args: [true],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }
  assert(
    (await publicClient.readContract({
      address: faucet.address,
      abi: faucet.abi,
      functionName: "isPermissioned",
    })) === true,
    "Aave Faucet is still permissionless after setPermissioned(true)",
  );
  ok("Aave Faucet", permissioned ? "already permissioned" : "permissioned");

  const configuratorAddr = readDeployment(
    "PoolConfigurator-Proxy-Aave",
  ).address;
  const configuratorAbi = readDeployment("PoolConfigurator-Implementation").abi;
  const pdpAddr = readDeployment("PoolDataProvider-Aave").address;
  const outcomes: VendorReserveOutcome[] = [];
  for (const { key, asset } of targets) {
    const cfg = await publicClient.readContract({
      address: pdpAddr,
      abi: RESERVE_CONFIG_ABI,
      functionName: "getReserveConfigurationData",
      args: [asset],
    });
    if (!cfg[8]) {
      outcomes.push({ key, asset, status: "already-inactive" });
      continue;
    }
    const [aToken, stableDebt, variableDebt] = await publicClient.readContract({
      address: pdpAddr,
      abi: RESERVE_CONFIG_ABI,
      functionName: "getReserveTokensAddresses",
      args: [asset],
    });
    const read = (address: Address, functionName: "totalSupply") =>
      publicClient.readContract({ address, abi: TOTAL_SUPPLY_ABI, functionName });
    const treasury = await publicClient.readContract({
      address: aToken,
      abi: TOTAL_SUPPLY_ABI,
      functionName: "RESERVE_TREASURY_ADDRESS",
    });
    const [supplied, treasurySupply, sDebt, vDebt, reserveData] = await Promise.all([
      read(aToken, "totalSupply"),
      publicClient.readContract({
        address: aToken,
        abi: TOTAL_SUPPLY_ABI,
        functionName: "balanceOf",
        args: [treasury],
      }),
      read(stableDebt, "totalSupply"),
      read(variableDebt, "totalSupply"),
      publicClient.readContract({
        address: pdpAddr,
        abi: RESERVE_DATA_ABI,
        functionName: "getReserveData",
        args: [asset],
      }),
    ]);
    const debt = sDebt + vDebt;
    const accrued = reserveData[1];
    const participantSupply = supplied - treasurySupply;
    // Aave's precondition for deactivation, exactly: no aTokens at all and nothing accrued to the
    // treasury. Debt implies aTokens, but it is checked too rather than relied on.
    const deactivatable = supplied === 0n && accrued === 0n && debt === 0n;
    const detail = {
      participantSupply: participantSupply.toString(),
      treasurySupply: treasurySupply.toString(),
      accruedToTreasuryScaled: accrued.toString(),
      debt: debt.toString(),
    };
    try {
      const h = await deployerWallet.writeContract({
        address: configuratorAddr,
        abi: configuratorAbi,
        functionName: deactivatable ? "setReserveActive" : "setReserveFreeze",
        args: [asset, !deactivatable],
        account: dep,
        chain: anvilChain,
      });
      await waitTx(h);
    } catch (e) {
      // One reserve that will not close must not leave the ones after it open.
      outcomes.push({
        key,
        asset,
        status: "failed",
        ...detail,
        error: (e instanceof Error ? e.message : String(e)).split("\n")[0],
      });
      continue;
    }
    outcomes.push(
      deactivatable
        ? { key, asset, status: "deactivated" }
        : {
            key,
            asset,
            status:
              participantSupply === 0n && debt === 0n ? "frozen-treasury-only" : "frozen",
            ...detail,
          },
    );
  }

  const by = (s: VendorReserveOutcome["status"]) =>
    outcomes.filter((o) => o.status === s).map((o) => o.key);
  ok(
    "Aave vendor reserves",
    `deactivated [${by("deactivated").join(", ")}] ` +
      `frozen, treasury residue only [${by("frozen-treasury-only").join(", ")}] ` +
      `already inactive [${by("already-inactive").join(", ")}]`,
  );
  const frozen = outcomes.filter((o) => o.status === "frozen");
  if (frozen.length > 0)
    console.warn(
      "[aave] WARNING: participants still supply or borrow on these vendor reserves, so they were " +
        "frozen rather than deactivated. What they hold still counts in getUserAccountData (and so " +
        "in the score), and the coordinator will refuse to start until it is gone; find who " +
        "supplied it (issue #190):\n" +
        frozen
          .map(
            (o) =>
              `  - ${o.key} ${o.asset}: participant aTokens ${o.participantSupply}, debt ${o.debt}`,
          )
          .join("\n"),
    );
  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0)
    console.error(
      "[aave] ERROR: could not freeze or deactivate these vendor reserves; they are still open:\n" +
        failed.map((o) => `  - ${o.key} ${o.asset}: ${o.error}`).join("\n"),
    );
  return outcomes;
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
 * Seed the shared mock token (WETH/USDC) reserves and sanity-check them with one borrow.
 * No faucet needed: the deployer holds WETH (wrap) and USDC (mint) balances from deployTokens.
 *
 * Issue #79: 5M USDC + 2,000 WETH supplied (was 9,000 USDC + 10 WETH, 0.005x the spot pool
 * against 20-50x on Base / Ethereum). Deliberately not the Base ratio: utilization and the rate
 * curve do nothing inside a 12-minute epoch (EVM time is not warped), so depth only has to make
 * agent-scale draws execute -- a 25k-100k USDC borrow, levered-long's supply loop -- instead of
 * hitting an empty reserve. The 1,000 USDC borrow stays as the sanity check.
 *
 * WETH budget: tokens.ts wraps 10,000 WETH at deploy. The venues take 1,000 each on uniswap /
 * balancer / curve, 1,500 on the GM pool (#79) and 2,010 here (#79) = 6,510; lst.ts wraps its own.
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
    5_000_000n * 10n ** 6n,
    "5,000,000 USDC (liquidity+collateral)",
  );
  await supplySharedAsset(
    weth,
    2_000n * 10n ** 18n,
    "2,000 WETH (liquidity+collateral)",
  );
  await borrowAsset(usdc, 1000n * 10n ** 6n, "1000 USDC");

  const acct = await accountData();
  assert(acct[0] > 0n, "shared collateral was not recorded");
  assert(acct[1] > 0n, "shared borrow was not recorded");
  ok("account data (shared)", `collateral=${acct[0]} debt=${acct[1]}`);
}
