import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  keccak256,
  parseUnits,
  toBytes,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { approve } from "../erc20.js";
import { getRegistry, setProtocol, token } from "../registry.js";
import { registerLstReserve } from "./aave-v3.js";
import { wrapWeth } from "../tokens.js";
import { ROOT, assert, info, loadForgeArtifact, ok, waitTx } from "../util.js";

const dep = accounts.deployer;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// ---------------------------------------------------------------------------
// Calibration (issue #38)
//
// The vault runs on a compressed *economic* clock rather than EVM time: one block stands for
// SIMULATED_SECONDS_PER_BLOCK seconds of staking. These are the deploy-time defaults baked into the
// state dump; a run can retune them through the lst section of its config (the simulation's admin
// key is registered as a second operator for exactly that).
//
// The APY is deliberately the same order as Aave's WETH supply rate. A 1000x-speed LST would make
// every other venue irrelevant -- the point of the venue is a yield/exit tradeoff, not free money.
// ---------------------------------------------------------------------------
const TARGET_APY_BPS = 300n; // 3%/yr, ~ Aave WETH supply
const SIMULATED_SECONDS_PER_BLOCK = 3600n; // one block == one hour of staking
const SECONDS_PER_YEAR = 31_536_000n;
const RAY = 10n ** 27n;

/// Floor on how long a withdrawal waits. On the economic clock above this is a day, against Lido's
/// real one-to-five days -- long enough that queueing is a real cost against selling into the pool,
/// short enough to complete inside a few-hundred-block run.
const WITHDRAWAL_DELAY_BLOCKS = 24n;

/// How much queued WETH the vault finalizes per block (issue #38 phase 2). With the per-round trade
/// cap around 1 WETH, this makes an ordinary exit cost a block or two on top of the floor while a
/// ten-WETH exit costs ten -- so size and congestion both show up in the wait instead of the queue
/// being a flat toll. 0 would disable the limit entirely.
const QUEUE_THROUGHPUT_WEI_PER_BLOCK = parseUnits("1", 18);

/// Secondary-market depth. Far smaller than the $3M spot venues on purpose: an LST book is thin,
/// and a book an agent cannot move is a book with no exit decision in it. Calibrated against the
/// per-round trade cap (~1 WETH): at 100 WETH a side that is 1% of the book, so ordinary trading
/// shifts the discount by single-digit bps and a large exit visibly costs more per unit. At the
/// 400 WETH first tried, dumping 12% of the book moved it 9bps — nothing an agent could work with.
const POOL_WETH = parseUnits("100", 18);
/// Rewards the environment pre-funds. Bounded by construction: a run can never accrue more than
/// this, so a misconfigured clock overpays a little rather than minting forever.
const REWARD_RESERVE = parseUnits("50", 18);

// Curve stableswap-ng plain-pool parameters. Modelled on the real wstETH/ETH ng pool: a low fee and
// a soft A, so the curve holds the peg over ordinary size and gives way (the cliff) on a large
// one-sided exit. Much lower than the USDC/DAI pool's 2000 because an LST is not a hard peg — at
// 500 the curve was so flat that no trade an agent is allowed to make registered at all.
const POOL_A = 100n;
const POOL_FEE = 4_000_000n; // 0.04%
const POOL_OFFPEG_FEE_MULTIPLIER = 20_000_000_000n;
const POOL_MA_EXP_TIME = 866n;

// The pool reads the redemption rate from the vault itself, exactly as the real wstETH/ETH ng pool
// reads stEthPerToken. Without this the pool would treat LST/WETH as 1:1, and a rising exchange
// rate would open a permanent risk-free arb for everyone -- a beta-style freebie that destroys
// discrimination (ADR 0007).
const RATE_ORACLE_SELECTOR = toFunctionSelector(
  "function stEthPerToken() view returns (uint256)",
);

const CURVE_VENDOR = resolve(ROOT, "vendor", "curve");

function curveArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(
    readFileSync(resolve(CURVE_VENDOR, `${name}.json`), "utf8"),
  );
  return {
    abi: json.abi as Abi,
    bytecode: (json.bytecode ?? json.blueprintBytecode) as Hex,
  };
}

/// Per-block reward rate as a ray fraction of the pooled WETH.
export function rewardRatePerBlockRay(
  apyBps: bigint,
  simulatedSecondsPerBlock: bigint,
): bigint {
  return (
    (apyBps * simulatedSecondsPerBlock * RAY) / (10_000n * SECONDS_PER_YEAR)
  );
}

/// The simulation's admin account, derived the same way sdk/src/config.ts derives it
/// (`keccak256("eris-role:admin")`). Registering it as an operator lets the environment retune the
/// economic clock per run without redeploying or holding the deployer key.
function envOperatorAddress(): Address {
  return privateKeyToAccount(keccak256(toBytes("eris-role:admin"))).address;
}

export async function deployLst({ seed }: { seed: boolean }) {
  info(
    "Deploying the LST venue (wstETH-style vault + LST/WETH secondary market)",
  );

  const weth = token("WETH");
  const vaultArtifact = loadForgeArtifact("MockLSTVault", "MockLSTVault");
  const ratePerBlockRay = rewardRatePerBlockRay(
    TARGET_APY_BPS,
    SIMULATED_SECONDS_PER_BLOCK,
  );

  const deployHash = await deployerWallet.deployContract({
    abi: vaultArtifact.abi,
    bytecode: vaultArtifact.bytecode,
    args: [
      weth,
      envOperatorAddress(),
      ratePerBlockRay,
      WITHDRAWAL_DELAY_BLOCKS,
    ],
    account: dep,
    chain: anvilChain,
  });
  const vault = (await waitTx(deployHash)).contractAddress as Address;
  ok("MockLSTVault", vault);

  const throughputHash = await deployerWallet.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: "setQueueThroughput",
    args: [QUEUE_THROUGHPUT_WEI_PER_BLOCK],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(throughputHash);
  ok("queue throughput", `${QUEUE_THROUGHPUT_WEI_PER_BLOCK} wei/block`);

  setProtocol("lst", {
    vault,
    lstToken: vault, // the vault is its own share token (wstETH model)
    asset: weth,
    rewardRatePerBlockRay: ratePerBlockRay.toString(),
    simulatedSecondsPerBlock: Number(SIMULATED_SECONDS_PER_BLOCK),
    targetApyBps: Number(TARGET_APY_BPS),
    withdrawalDelayBlocks: Number(WITHDRAWAL_DELAY_BLOCKS),
    queueThroughputWeiPerBlock: QUEUE_THROUGHPUT_WEI_PER_BLOCK.toString(),
  });

  if (!seed) return;

  // The deployer's WETH is already spread across the other venues by the time we get here, so top
  // it up from its (effectively unlimited) anvil ETH rather than assuming a balance.
  await wrapWeth(weth, POOL_WETH * 2n + REWARD_RESERVE + parseUnits("10", 18));

  // ---- stake, so the pool has LST to hold and the exchange rate is well-defined ----
  const stakeAssets = POOL_WETH;
  await approve(weth, vault, stakeAssets + REWARD_RESERVE);
  const stakeHash = await deployerWallet.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: "deposit",
    args: [stakeAssets, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(stakeHash);
  const lstBalance = (await publicClient.readContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: "balanceOf",
    args: [dep.address],
  })) as bigint;
  ok("staked", `${stakeAssets} WETH -> ${lstBalance} LST`);

  const fundHash = await deployerWallet.writeContract({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: "fundRewards",
    args: [REWARD_RESERVE],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(fundHash);
  ok("reward reserve funded", `${REWARD_RESERVE} WETH`);

  await seedSecondaryMarket(vault, weth, lstBalance);
}

/// Create the LST/WETH stableswap-ng plain pool on the factory Curve already deployed, wire the
/// rate oracle, and seed it balanced (at par, since the vault starts at a 1:1 rate).
async function seedSecondaryMarket(
  vault: Address,
  weth: Address,
  lstBalance: bigint,
) {
  const curve = getRegistry().protocols.curve as
    { factory?: string } | undefined;
  if (!curve?.factory) {
    throw new Error(
      "lst: the Curve stableswap-ng factory is not in deployments.json — deploy curve before lst",
    );
  }
  const factory = curve.factory as Address;
  const factoryAbi = curveArtifact("CurveStableSwapFactoryNG").abi;
  const poolAbi = curveArtifact("CurveStableSwapNG").abi;

  info("LST: creating the LST/WETH stableswap-ng pool and seeding liquidity");
  // coin0 = WETH (the numeraire), coin1 = LST. Asset type 1 = "has a rate oracle": the pool calls
  // stEthPerToken on the vault, so a rising redemption rate shifts the curve instead of leaving a
  // free arb behind.
  const coins = [weth, vault] as Address[];
  const deployHash = await deployerWallet.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "deploy_plain_pool",
    args: [
      "Eris LST/WETH",
      "ERLSTWETH",
      coins,
      POOL_A,
      POOL_FEE,
      POOL_OFFPEG_FEE_MULTIPLIER,
      POOL_MA_EXP_TIME,
      0n, // implementation_idx
      [0, 1], // asset_types: [Standard, Oracle]
      ["0x00000000", RATE_ORACLE_SELECTOR], // method_ids
      [ZERO, vault], // oracles
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
  assert(pool !== ZERO, "LST/WETH pool was not created");
  ok("LST/WETH pool created", pool);

  // Fail fast if the oracle did not take: with a 1:1 rate the two are indistinguishable today, but
  // the moment yield accrues an unwired pool prices LST at par and hands everyone free money.
  const storedRates = (await publicClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "stored_rates",
    args: [],
  })) as readonly bigint[];
  const vaultRate = (await publicClient.readContract({
    address: vault,
    abi: loadForgeArtifact("MockLSTVault", "MockLSTVault").abi,
    functionName: "stEthPerToken",
    args: [],
  })) as bigint;
  assert(
    storedRates.length === 2 && storedRates[1] === vaultRate,
    `LST rate oracle is not wired: stored_rates=${storedRates.join(",")} vault rate=${vaultRate}`,
  );
  ok("rate oracle wired", `stEthPerToken=${vaultRate}`);

  // Balanced at the current rate: equal *rate-adjusted* value on both legs, which at a 1:1 start
  // means equal amounts. Seeding it off-peg would hand the first agent to look a free carry.
  const lstAmount = lstBalance < POOL_WETH ? lstBalance : POOL_WETH;
  await approve(weth, pool, POOL_WETH);
  await approve(vault, pool, lstAmount);
  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: poolAbi,
    functionName: "add_liquidity",
    args: [[POOL_WETH, lstAmount], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", `${POOL_WETH} WETH / ${lstAmount} LST (at par)`);

  setProtocol("lst", {
    pool,
    poolWethIndex: 0,
    poolLstIndex: 1,
    poolFee: Number(POOL_FEE),
    poolA: Number(POOL_A),
  });

  await listAsAaveCollateral(vault);
}

/// Issue #38 phase 3: list the LST as Aave collateral so it can be levered.
///
/// Skipped when Aave is not in this deploy — the venue works without it, leverage is the layer on
/// top. Registered here rather than inside the Aave deploy because the vault does not exist yet at
/// that point (Aave runs before Curve, which the secondary market needs).
async function listAsAaveCollateral(vault: Address) {
  const aave = getRegistry().protocols.aaveV3 as
    { pool?: string; tokens?: Record<string, string> } | undefined;
  if (!aave?.pool) {
    info("LST: skipping the Aave listing (aave is not in this deploy)");
    return;
  }
  // Priced at Aave's own WETH price times the vault's rate; registerLstReserve reads the former.
  // The environment overwrites this every block, but it has to be right at block 0 too.
  const redemptionRateWad = (await publicClient.readContract({
    address: vault,
    abi: loadForgeArtifact("MockLSTVault", "MockLSTVault").abi,
    functionName: "stEthPerToken",
  })) as bigint;
  const { aggregator, aToken, variableDebtToken } = await registerLstReserve(
    vault,
    redemptionRateWad,
  );
  setProtocol("lst", {
    aaveAggregator: aggregator,
    aaveAToken: aToken,
    aaveVariableDebtToken: variableDebtToken,
  });
}
