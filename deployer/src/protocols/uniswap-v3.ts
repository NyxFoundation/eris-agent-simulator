import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pad, stringToHex, type Abi, type Address, type Hex } from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { ROOT, waitTx, ok, info, assert, encodeSqrtRatioX96 } from "../util.js";
import { setProtocol, token } from "../registry.js";
import { approve } from "../erc20.js";

const dep = accounts.deployer;

function art(pkgRelPath: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(
    readFileSync(resolve(ROOT, "node_modules", pkgRelPath), "utf8"),
  );
  return { abi: json.abi as Abi, bytecode: json.bytecode as Hex };
}

const A = {
  factory: () =>
    art(
      "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
    ),
  nftDescriptor: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json",
    ),
  posDescriptor: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json",
    ),
  posManager: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
    ),
  swapRouter: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
    ),
  quoterV2: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json",
    ),
  tickLens: () =>
    art(
      "@uniswap/v3-periphery/artifacts/contracts/lens/TickLens.sol/TickLens.json",
    ),
};

/** Fill the linkReferences placeholder __$..$__ with the deployed library address */
function linkLibrary(bytecode: Hex, libAddress: Address): Hex {
  const addr = libAddress.toLowerCase().replace("0x", "");
  return bytecode.replace(/__\$[0-9a-fA-F]+\$__/g, addr) as Hex;
}

async function deploy(
  label: string,
  abi: Abi,
  bytecode: Hex,
  args: unknown[],
): Promise<Address> {
  const hash = await deployerWallet.deployContract({
    abi,
    bytecode,
    args,
    account: dep,
    chain: anvilChain,
  });
  const rc = await waitTx(hash);
  const addr = rc.contractAddress as Address;
  ok(label, addr);
  return addr;
}

export async function deployUniswapV3({ seed }: { seed: boolean }) {
  info("Deploying Uniswap V3 core/periphery");
  const weth = token("WETH");

  const factory = await deploy(
    "UniswapV3Factory",
    A.factory().abi,
    A.factory().bytecode,
    [],
  );

  const nftDescriptorLib = await deploy(
    "NFTDescriptor (lib)",
    A.nftDescriptor().abi,
    A.nftDescriptor().bytecode,
    [],
  );

  const posDescArt = A.posDescriptor();
  // nativeCurrencyLabel "ETH" into bytes32 (right-padded)
  const labelBytes = pad(stringToHex("ETH"), { dir: "right", size: 32 });
  const posDescriptor = await deploy(
    "NonfungibleTokenPositionDescriptor",
    posDescArt.abi,
    linkLibrary(posDescArt.bytecode, nftDescriptorLib),
    [weth, labelBytes],
  );

  const posManager = await deploy(
    "NonfungiblePositionManager",
    A.posManager().abi,
    A.posManager().bytecode,
    [factory, weth, posDescriptor],
  );

  const swapRouter = await deploy(
    "SwapRouter",
    A.swapRouter().abi,
    A.swapRouter().bytecode,
    [factory, weth],
  );

  const quoterV2 = await deploy(
    "QuoterV2",
    A.quoterV2().abi,
    A.quoterV2().bytecode,
    [factory, weth],
  );

  const tickLens = await deploy(
    "TickLens",
    A.tickLens().abi,
    A.tickLens().bytecode,
    [],
  );

  setProtocol("uniswapV3", {
    factory,
    nftDescriptorLib,
    positionDescriptor: posDescriptor,
    positionManager: posManager,
    swapRouter,
    quoterV2,
    tickLens,
  });

  if (seed) {
    // WETH/USDC (existing. 1000 WETH / 3M USDC = $3000)
    await seedV3Pool({
      posManager,
      tokenAKey: "WETH",
      tokenBKey: "USDC",
      amountA: 1000n * 10n ** 18n,
      amountB: 3_000_000n * 10n ** 6n,
      registryKey: "wethUsdcPool",
      label: "1000 WETH / 3M USDC (full range, $3000)",
    });
    // WBTC/USDC (ADR 0013. 50 WBTC / 3M USDC = $60k anchor. WBTC has 8 decimals).
    // The POC quoter has no per-pair fee, so use fee=3000 to unify with WETH/USDC.
    await seedV3Pool({
      posManager,
      tokenAKey: "WBTC",
      tokenBKey: "USDC",
      amountA: 50n * 10n ** 8n,
      amountB: 3_000_000n * 10n ** 6n,
      registryKey: "wbtcUsdcPool",
      label: "50 WBTC / 3M USDC (full range, $60000)",
    });
  }
}

const FEE = 3000;
const TICK_SPACING = 60;
const MIN_TICK = -887220; // -887272 rounded to tickSpacing(60)
const MAX_TICK = 887220;

/**
 * Generic version that creates a base/quote pool and seeds full-range liquidity.
 * token0 < token1 ascending sort / encodeSqrtRatioX96 (raw amount ratio, decimals included) /
 * full-range mint / getPool verification are shared with WETH/USDC. Parameterize tokenAKey/amount
 * to seed WETH/USDC and WBTC/USDC through the same path (ADR 0013).
 */
async function seedV3Pool({
  posManager,
  tokenAKey,
  tokenBKey,
  amountA,
  amountB,
  registryKey,
  label,
}: {
  posManager: Address;
  tokenAKey: string;
  tokenBKey: string;
  amountA: bigint;
  amountB: bigint;
  registryKey: string;
  label: string;
}) {
  info(
    `Uniswap V3: creating ${tokenAKey}/${tokenBKey} pool and seeding liquidity`,
  );
  const tokenA = token(tokenAKey);
  const tokenB = token(tokenBKey);

  // token0 < token1 (ascending address order)
  const aIsToken0 = tokenA.toLowerCase() < tokenB.toLowerCase();
  const token0 = aIsToken0 ? tokenA : tokenB;
  const token1 = aIsToken0 ? tokenB : tokenA;
  const amount0Desired = aIsToken0 ? amountA : amountB;
  const amount1Desired = aIsToken0 ? amountB : amountA;

  // encodeSqrtRatioX96 uses a raw amount ratio, so decimals are included in the raw values and it is correct without changes.
  const sqrtPriceX96 = encodeSqrtRatioX96(amount1Desired, amount0Desired);

  const npmAbi = A.posManager().abi;

  // create + initialize the pool
  const h1 = await deployerWallet.writeContract({
    address: posManager,
    abi: npmAbi,
    functionName: "createAndInitializePoolIfNecessary",
    args: [token0, token1, FEE, sqrtPriceX96],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h1);
  ok("pool create+init", `${tokenAKey}/${tokenBKey} fee=${FEE}`);

  // approve
  await approve(tokenA, posManager, amountA);
  await approve(tokenB, posManager, amountB);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const h2 = await deployerWallet.writeContract({
    address: posManager,
    abi: npmAbi,
    functionName: "mint",
    args: [
      {
        token0,
        token1,
        fee: FEE,
        tickLower: MIN_TICK,
        tickUpper: MAX_TICK,
        amount0Desired,
        amount1Desired,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: dep.address,
        deadline,
      },
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(h2);
  ok("liquidity mint", label);

  // Sanity: is the pool registered in the factory
  const { factory } = (await import("../registry.js")).getRegistry().protocols
    .uniswapV3 as { factory: Address };
  const pool = (await publicClient.readContract({
    address: factory,
    abi: A.factory().abi,
    functionName: "getPool",
    args: [token0, token1, FEE],
  })) as Address;
  assert(
    pool !== "0x0000000000000000000000000000000000000000",
    `${tokenAKey}/${tokenBKey} pool was not created`,
  );
  setProtocol("uniswapV3", { [registryKey]: pool });
  ok("pool address", `${registryKey}=${pool}`);
}
