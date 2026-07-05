import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseUnits, type Abi, type Address, type Hex } from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { ROOT, waitTx, ok, info, assert } from "../util.js";
import { approve } from "../erc20.js";
import { setProtocol, token } from "../registry.js";

const dep = accounts.deployer;
const CURVE = resolve(ROOT, "vendor", "curve");

// Artifacts prebuilt with vyper -f abi / -f bytecode|blueprint_bytecode
function art(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(CURVE, `${name}.json`), "utf8"));
  return {
    abi: j.abi as Abi,
    bytecode: (j.bytecode ?? j.blueprintBytecode) as Hex,
  };
}

async function deploy(
  label: string,
  name: string,
  args: unknown[],
): Promise<Address> {
  const a = art(name);
  const hash = await deployerWallet.deployContract({
    abi: a.abi,
    bytecode: a.bytecode,
    args,
    account: dep,
    chain: anvilChain,
  });
  const rc = await waitTx(hash);
  ok(label, rc.contractAddress as string);
  return rc.contractAddress as Address;
}

// Safe parameters for deploy_plain_pool (per the repo's tests/fixtures/pools.py)
const A = 2000n;
const FEE = 1_000_000n; // 0.01%
const OFFPEG = 20_000_000_000n;
const MA_EXP_TIME = 866n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export async function deployCurve({ seed }: { seed: boolean }) {
  info("Deploying Curve Stableswap-NG (factory + implementations)");

  // Implementation contracts
  const math = await deploy("Math impl", "CurveStableSwapNGMath", []);
  const views = await deploy("Views impl", "CurveStableSwapNGViews", []);
  const poolBlueprint = await deploy("Pool blueprint", "CurveStableSwapNG", []);

  // factory(__init__: fee_receiver, owner)
  const factory = await deploy(
    "StableSwapFactoryNG",
    "CurveStableSwapFactoryNG",
    [dep.address, dep.address],
  );
  const factoryAbi = art("CurveStableSwapFactoryNG").abi;

  // Wire the implementations into the factory
  for (const [fn, arg] of [
    ["set_math_implementation", math],
    ["set_views_implementation", views],
  ] as const) {
    const h = await deployerWallet.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: fn,
      args: [arg],
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }
  const h = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "set_pool_implementations",
    args: [0n, poolBlueprint],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h);
  ok("implementation wiring", "math / views / pool[0]");

  setProtocol("curve", { factory, math, views, poolBlueprint });

  if (seed) {
    await seedPool(factory);
  }

  // The poc Curve venue assumes a WETH<->stable crypto pool (uint256 index get_dy/exchange).
  // Separately from stableswap (USDC/DAI), stand up a twocrypto-ng WETH/USDC crypto pool.
  await deployTwocrypto({ seed });
}

// twocrypto-ng (lite-0.3.10) standard parameters (per tests/profiling/conftest.py)
const TC = {
  A: 400000n,
  gamma: 145000000000000n,
  midFee: 26000000n,
  outFee: 45000000n,
  feeGamma: 230000000000000n,
  allowedExtraProfit: 2000000000000n,
  adjustmentStep: 146000000000000n,
  maExpTime: 866n,
} as const;

/** Deploy twocrypto-ng (WETH/USDC crypto pool) and seed via add_liquidity */
async function deployTwocrypto({ seed }: { seed: boolean }) {
  info("Deploying Curve Twocrypto-NG (crypto factory + implementations)");
  const math = await deploy("Twocrypto Math", "CurveTwocryptoMath", []);
  const views = await deploy("Twocrypto Views", "CurveTwocryptoViews", []);
  const amm = await deploy("Twocrypto AMM blueprint", "CurveTwocrypto", []);
  const factory = await deploy("TwocryptoFactory", "CurveTwocryptoFactory", []);
  const factoryAbi = art("CurveTwocryptoFactory").abi;

  // __init__ only records the deployer (tx.origin). Initialize ownership.
  for (const [fn, args] of [
    ["initialise_ownership", [dep.address, dep.address]],
    ["set_math_implementation", [math]],
    ["set_views_implementation", [views]],
    ["set_pool_implementation", [amm, 0n]],
  ] as const) {
    const h = await deployerWallet.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: fn,
      args: args as never,
      account: dep,
      chain: anvilChain,
    });
    await waitTx(h);
  }
  ok("twocrypto wiring", "ownership / math / views / pool[0]");

  setProtocol("curve", {
    twocryptoFactory: factory,
    twocryptoMath: math,
    twocryptoViews: views,
    twocryptoAmm: amm,
  });

  if (seed) {
    await seedTwocrypto(factory);
    await seedTwocryptoWbtc(factory);
  }
}

/** Create a WETH/USDC crypto pool and add_liquidity ($3000/WETH, balanced) */
async function seedTwocrypto(factory: Address) {
  info("Curve: creating WETH/USDC crypto pool and seeding liquidity");
  const factoryAbi = art("CurveTwocryptoFactory").abi;
  const usdc = token("USDC");
  const weth = token("WETH");
  // coin0 = USDC (numeraire), coin1 = WETH. initial_price = WETH price in USDC (1e18 normalized).
  const coins = [usdc, weth] as [Address, Address];
  const initialPrice = 3000n * 10n ** 18n;

  const deployHash = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deploy_pool",
    args: [
      "Eris WETH/USDC crypto",
      "ERISWETHUSDC",
      coins,
      0n, // implementation_id
      TC.A,
      TC.gamma,
      TC.midFee,
      TC.outFee,
      TC.feeGamma,
      TC.allowedExtraProfit,
      TC.adjustmentStep,
      TC.maExpTime,
      initialPrice,
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(deployHash);

  const count = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_count",
    args: [],
  })) as bigint;
  const pool = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_list",
    args: [count - 1n],
  })) as Address;
  assert(pool !== ZERO, "crypto pool was not created");
  ok("crypto pool created", pool);

  const poolAbi = art("CurveTwocrypto").abi;
  // Balanced initial liquidity: 3M USDC + 1000 WETH (=$3M each @ $3000). Same depth as Uniswap/Balancer.
  // Crypto pools have nonlinear, large price impact; when shallow, a flow swap (up to 1 WETH) can
  // fall below min_dy (1% slippage) due to price movement between the get_dy quote and execution,
  // reverting. Make it deep to suppress this.
  const usdcAmt = parseUnits("3000000", 6);
  const wethAmt = parseUnits("1000", 18);
  await approve(usdc, pool, usdcAmt);
  await approve(weth, pool, wethAmt);
  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "add_liquidity",
    args: [[usdcAmt, wethAmt], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", "3M USDC / 1000 WETH ($3000)");

  // poc indices: coin0=USDC(stable)=0, coin1=WETH=1
  setProtocol("curve", {
    wethUsdcCryptoPool: pool,
    cryptoWethIndex: 1,
    cryptoStableIndex: 0,
  });
}

/**
 * Create a WBTC/USDC crypto pool and add_liquidity ($60000/WBTC, balanced).
 * No factory redeploy needed (call deploy_pool once more on the same factory as seedTwocrypto).
 */
async function seedTwocryptoWbtc(factory: Address) {
  info("Curve: creating WBTC/USDC crypto pool and seeding liquidity");
  const factoryAbi = art("CurveTwocryptoFactory").abi;
  const usdc = token("USDC");
  const wbtc = token("WBTC");
  // coin0 = USDC (numeraire), coin1 = WBTC. initial_price = WBTC price in USDC (1e18 normalized).
  const coins = [usdc, wbtc] as [Address, Address];
  const initialPrice = 60000n * 10n ** 18n;

  const deployHash = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deploy_pool",
    args: [
      "Eris WBTC/USDC crypto",
      "ERISWBTCUSDC",
      coins,
      0n, // implementation_id
      TC.A,
      TC.gamma,
      TC.midFee,
      TC.outFee,
      TC.feeGamma,
      TC.allowedExtraProfit,
      TC.adjustmentStep,
      TC.maExpTime,
      initialPrice,
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(deployHash);

  const count = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_count",
    args: [],
  })) as bigint;
  const pool = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_list",
    args: [count - 1n],
  })) as Address;
  assert(pool !== ZERO, "WBTC crypto pool was not created");
  ok("WBTC crypto pool created", pool);

  const poolAbi = art("CurveTwocrypto").abi;
  // Balanced initial liquidity: 3M USDC + 50 WBTC (=$3M each @ $60000).
  // Make the normalized amount ratio 3,000,000 : 50 = 60000 match initial_price
  // (add_liquidity reverts if they diverge). WBTC has 8 decimals.
  const usdcAmt = parseUnits("3000000", 6);
  const wbtcAmt = parseUnits("50", 8);
  await approve(usdc, pool, usdcAmt);
  await approve(wbtc, pool, wbtcAmt);
  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "add_liquidity",
    args: [[usdcAmt, wbtcAmt], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", "3M USDC / 50 WBTC ($60000)");

  // poc indices: coin0=USDC(stable)=0, coin1=WBTC=1
  setProtocol("curve", {
    wbtcUsdcCryptoPool: pool,
    cryptoWbtcIndex: 1,
    cryptoWbtcStableIndex: 0,
  });
}

/** Create a USDC/DAI plain pool and verify add_liquidity -> exchange */
async function seedPool(factory: Address) {
  info("Curve: creating USDC/DAI plain pool and seeding liquidity");
  const factoryAbi = art("CurveStableSwapFactoryNG").abi;
  const usdc = token("USDC");
  const dai = token("DAI");
  const coins = [usdc, dai] as Address[];

  const deployHash = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deploy_plain_pool",
    args: [
      "Eris USDC/DAI", // _name: String[32]
      "USDCDAI", // _symbol: String[10]
      coins,
      A,
      FEE,
      OFFPEG,
      MA_EXP_TIME,
      0n, // implementation_idx
      [0, 0], // asset_types: Standard
      ["0x00000000", "0x00000000"], // method_ids
      [ZERO, ZERO], // oracles
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(deployHash);

  // Get the pool address from factory.pool_list(pool_count-1)
  const count = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_count",
    args: [],
  })) as bigint;
  const pool = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "pool_list",
    args: [count - 1n],
  })) as Address;
  assert(pool !== ZERO, "pool was not created");
  ok("plain pool created", pool);

  const poolAbi = art("CurveStableSwapNG").abi;

  // Initial liquidity: 100,000 each (decimals-adjusted)
  const usdcAmt = parseUnits("100000", 6);
  const daiAmt = parseUnits("100000", 18);
  await approve(usdc, pool, usdcAmt);
  await approve(dai, pool, daiAmt);

  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "add_liquidity",
    args: [[usdcAmt, daiAmt], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", "100k USDC / 100k DAI");

  setProtocol("curve", { usdcDaiPool: pool });
}
