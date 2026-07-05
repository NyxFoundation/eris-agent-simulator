import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { ROOT, waitTx, ok, info, assert } from "../util.js";
import { approve } from "../erc20.js";
import { setProtocol, token } from "../registry.js";

const dep = accounts.deployer;
const BAL = "node_modules/@balancer-labs/v2-deployments/dist/tasks";

/** Combined artifacts like authorizer / vault (_format hardhat) */
function combined(task: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "artifact", `${name}.json`), "utf8"),
  );
  return { abi: j.abi as Abi, bytecode: j.bytecode as Hex };
}

/** Tasks like weighted-pool where abi/ and bytecode/ are split */
function split(task: string, name: string): { abi: Abi; bytecode: Hex } {
  const abi = JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "abi", `${name}.json`), "utf8"),
  ) as Abi;
  const bc = JSON.parse(
    readFileSync(resolve(ROOT, BAL, task, "bytecode", `${name}.json`), "utf8"),
  );
  return { abi, bytecode: bc.creationCode as Hex };
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
  ok(label, rc.contractAddress as string);
  return rc.contractAddress as Address;
}

const SWAP_FEE = 3_000_000_000_000_000n; // 0.3%
// Build WETH/USDC 50/50. As the primary venue for WETH<->USDC arbitrage, place deep liquidity on
// both sides and align the price with the poc fair price (~$3000) (with 80/20 the USDC side is
// shallow and swaps fall below the limit).
const W50 = 500_000_000_000_000_000n;

export async function deployBalancerV2({ seed }: { seed: boolean }) {
  info("Deploying Balancer V2 (Authorizer / Vault / WeightedPoolFactory)");
  const weth = token("WETH");

  const authorizerArt = combined("20210418-authorizer", "Authorizer");
  const authorizer = await deploy(
    "Authorizer",
    authorizerArt.abi,
    authorizerArt.bytecode,
    [dep.address],
  );

  // pauseWindow / bufferPeriod can be 0 (for testing)
  const vaultArt = combined("20210418-vault", "Vault");
  const vault = await deploy("Vault", vaultArt.abi, vaultArt.bytecode, [
    authorizer,
    weth,
    0n,
    0n,
  ]);

  const factoryArt = split("20210418-weighted-pool", "WeightedPoolFactory");
  const weightedPoolFactory = await deploy(
    "WeightedPoolFactory",
    factoryArt.abi,
    factoryArt.bytecode,
    [vault],
  );

  // BalancerQueries: the poc balancer adapter uses it for quotes via queryBatchSwap.
  const queriesArt = combined("20220721-balancer-queries", "BalancerQueries");
  const queries = await deploy(
    "BalancerQueries",
    queriesArt.abi,
    queriesArt.bytecode,
    [vault],
  );

  setProtocol("balancerV2", {
    authorizer,
    vault,
    weightedPoolFactory,
    queries,
  });

  if (seed) {
    // WETH/USDC (existing; keep args and amounts as before for byte compatibility).
    await seedWeightedPool({
      vault,
      weightedPoolFactory,
      tokenAKey: "WETH",
      tokenBKey: "USDC",
      // 1000 WETH / 3,000,000 USDC = $3000/WETH (50/50, deep).
      amountA: 1000n * 10n ** 18n,
      amountB: 3_000_000n * 10n ** 6n,
      name: "Eris WETH/USDC 50/50",
      symbol: "ERIS-50WETH-50USDC",
      poolKey: "wethUsdcPool",
      poolIdKey: "wethUsdcPoolId",
      summary: "1000 WETH / 3M USDC (50/50, $3000)",
    });
    // WBTC/USDC (ADR 0013 multi-asset). WBTC has 8 decimals.
    await seedWeightedPool({
      vault,
      weightedPoolFactory,
      tokenAKey: "WBTC",
      tokenBKey: "USDC",
      // 50 WBTC / 3,000,000 USDC = $60k/WBTC (50/50, deep).
      amountA: 50n * 10n ** 8n,
      amountB: 3_000_000n * 10n ** 6n,
      name: "Eris WBTC/USDC 50/50",
      symbol: "ERIS-50WBTC-50USDC",
      poolKey: "wbtcUsdcPool",
      poolIdKey: "wbtcUsdcPoolId",
      summary: "50 WBTC / 3M USDC (50/50, $60000)",
    });
  }
}

/**
 * Generic seed that creates a 50/50 weighted pool and seeds initial liquidity.
 * The flow create -> extract PoolCreated log -> getPoolId -> joinPool INIT is shared.
 * The Vault normalizes to 18 decimals via a scaling factor, so passing raw amounts gives a correct spot.
 */
async function seedWeightedPool({
  vault,
  weightedPoolFactory,
  tokenAKey,
  tokenBKey,
  amountA,
  amountB,
  name,
  symbol,
  poolKey,
  poolIdKey,
  summary,
}: {
  vault: Address;
  weightedPoolFactory: Address;
  tokenAKey: string;
  tokenBKey: string;
  amountA: bigint;
  amountB: bigint;
  name: string;
  symbol: string;
  poolKey: string;
  poolIdKey: string;
  summary: string;
}) {
  info(
    `Balancer V2: creating 50/50 ${tokenAKey}/${tokenBKey} pool and seeding liquidity`,
  );
  const tokenA = token(tokenAKey);
  const tokenB = token(tokenBKey);

  // Balancer requires tokens to be registered in ascending order.
  const aFirst = tokenA.toLowerCase() < tokenB.toLowerCase();
  const tokens = (aFirst ? [tokenA, tokenB] : [tokenB, tokenA]) as Address[];
  const weights = [W50, W50]; // 50/50
  const amounts = aFirst ? [amountA, amountB] : [amountB, amountA];

  const factoryArt = split("20210418-weighted-pool", "WeightedPoolFactory");
  const createHash = await deployerWallet.writeContract({
    address: weightedPoolFactory,
    abi: factoryArt.abi,
    functionName: "create",
    args: [name, symbol, tokens, weights, SWAP_FEE, dep.address],
    account: dep,
    chain: anvilChain,
  });
  const createRc = await waitTx(createHash);

  // Get the pool address from the PoolCreated event
  let pool: Address | undefined;
  for (const log of createRc.logs) {
    try {
      const ev = decodeEventLog({ abi: factoryArt.abi, ...log });
      if (ev.eventName === "PoolCreated") {
        pool = (ev.args as unknown as { pool: Address }).pool;
        break;
      }
    } catch {
      /* log from another contract */
    }
  }
  assert(!!pool, "could not obtain PoolCreated");
  ok("WeightedPool created", pool!);

  // Get poolId
  const poolAbi = split("20210418-weighted-pool", "WeightedPool").abi;
  const poolId = (await publicClient.readContract({
    address: pool!,
    abi: poolAbi,
    functionName: "getPoolId",
    args: [],
  })) as Hex;
  ok("poolId", poolId);

  await approve(tokenA, vault, amountA);
  await approve(tokenB, vault, amountB);

  // WeightedPool INIT join: userData = abi.encode(uint256 kind=0, uint256[] amountsIn)
  const userData = encodeAbiParameters(
    parseAbiParameters("uint256, uint256[]"),
    [0n, amounts],
  );

  const vaultArt = combined("20210418-vault", "Vault");
  const joinHash = await deployerWallet.writeContract({
    address: vault,
    abi: vaultArt.abi,
    functionName: "joinPool",
    args: [
      poolId,
      dep.address,
      dep.address,
      {
        assets: tokens,
        maxAmountsIn: amounts,
        userData,
        fromInternalBalance: false,
      },
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(joinHash);
  ok("initial liquidity join", summary);

  setProtocol("balancerV2", { [poolKey]: pool, [poolIdKey]: poolId });
}
