// Liquity V1 as the CDP stablecoin venue (issue #39), issuing eUSD.
//
// The core is forked essentially unmodified -- TroveManager / BorrowerOperations / StabilityPool /
// SortedTroves and the pools keep Recovery Mode, debt and collateral redistribution, the sorted
// list, and the dynamic borrowing and redemption fees. The interaction between those *is* the game
// the venue adds; simplifying any of it produces something materially different. The only
// source-level change is the token's name and symbol (see scripts/setup-vendors.sh).
//
// Two things are ours rather than Liquity's:
//   - the oracle, because Liquity's own testnet feed has an unpermissioned setter, which would let
//     any agent set the price it is being liquidated against (see LiquityPriceFeedAdapter.sol)
//   - the genesis Trove, because LUSDToken has no admin mint: every eUSD in existence has to come
//     out of somebody's Trove, including the supply that seeds the market and the Stability Pool
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accounts, deployerWallet, publicClient } from "../clients.js";
import { anvilChain } from "../config.js";
import { approve } from "../erc20.js";
import { getRegistry, setProtocol, token } from "../registry.js";
import { ROOT, assert, info, loadForgeArtifact, ok, waitTx } from "../util.js";

const dep = accounts.deployer;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// ---------------------------------------------------------------------------
// Calibration (issue #39)
// ---------------------------------------------------------------------------

/// Price the genesis Trove is opened against, matching what the other venues are seeded at.
/// The run's own oracle takes over from the first block; this only has to be right enough that the
/// starting Trove is not already near liquidation.
const GENESIS_PRICE_USD = 3000n;

/// The genesis Trove. Deliberately over-collateralized: it is not a participant, and it exists to
/// mint the eUSD that seeds the market. At 300% it is also the *last* Trove redemptions would
/// reach, so agent-opened Troves are what redemption arb actually competes over.
///
/// It mints more than the market and the Stability Pool need, and the surplus is the point: eUSD
/// only exists if it came out of a Trove, so the environment's own inventory -- what the `eusdDepeg`
/// stress event sells to push the peg off par (issue #39 phase 5) -- has to be minted here too.
const GENESIS_COLL_ETH = 250n;
const GENESIS_DEBT_EUSD = 250_000n; // 250 * 3000 / 250000 = 300% ICR

/// How the minted supply is placed. What is left stays with the deployer, which is where the
/// coordinator can draw from if a run needs to top anything up.
const POOL_EUSD = 100_000n; // eUSD/USDC curve pool, matched with USDC
const STABILITY_POOL_EUSD = 50_000n; // pre-seeded underwriting depth

/// Redemptions revert during Liquity's 14-day BOOTSTRAP_PERIOD, measured from a constructor-set
/// deployment timestamp. Warping past it costs nothing and keeps the fork diff at zero -- the
/// alternative would be patching a constant in TroveManager.
const BOOTSTRAP_SECONDS = 14n * 24n * 60n * 60n + 3600n;

/// Borrowing fee ceiling for the genesis open. baseRate starts at zero so the actual fee is the
/// 0.5% floor; this is only the slippage bound on it.
const MAX_BORROW_FEE = parseEther("0.05");

// Curve plain-pool parameters. Everything but the amplification matches the USDC/DAI pool the
// factory already hosts.
//
// A is 100 rather than that pool's 2000, and it is the one number here that had to be measured
// rather than copied. Redemption costs a 0.5% floor fee, so the venue's α exists only when eUSD
// trades more than 50bps below par -- and at A=2000 a 100k/100k pool moves 4.4bps when *half* its
// eUSD side is sold (measured on chain). No plausible flow could ever open the trade. At A=100 the
// same pool moves 22bps on a 10k sale and 114bps on 40k, which keeps the stableswap's peg-then-cliff
// shape -- eUSD is sticky near par and gives way when it is really pushed -- at a scale agents
// holding 25k of capital can actually interact with.
const A = 100n;
const FEE = 1_000_000n; // 0.01%
const OFFPEG = 20_000_000_000n;
const MA_EXP_TIME = 866n;

const LIQUITY_OUT = resolve(ROOT, "vendor/liquity-src/packages/contracts/out");

function liquityArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(
    readFileSync(resolve(LIQUITY_OUT, `${name}.sol/${name}.json`), "utf8"),
  );
  return {
    abi: j.abi as Abi,
    bytecode: (j.bytecode?.object ?? j.bytecode) as Hex,
  };
}

async function deployLiquity(
  label: string,
  name: string,
  args: unknown[] = [],
): Promise<Address> {
  const a = liquityArtifact(name);
  const hash = await deployerWallet.deployContract({
    abi: a.abi,
    bytecode: a.bytecode,
    args,
    account: dep,
    chain: anvilChain,
  });
  const rc = await waitTx(hash);
  const address = rc.contractAddress as Address;
  assert(Boolean(address), `${label} was not deployed`);
  ok(label, address);
  return address;
}

async function call(
  address: Address,
  abiName: string,
  functionName: string,
  args: unknown[],
  value?: bigint,
): Promise<void> {
  const hash = await deployerWallet.writeContract({
    address,
    abi: liquityArtifact(abiName).abi,
    functionName,
    args,
    account: dep,
    chain: anvilChain,
    ...(value === undefined ? {} : { value }),
  });
  await waitTx(hash);
}

/// The simulation's admin account, derived the same way sdk/src/config.ts derives it. It owns the
/// oracle adapter so a run can repoint it at the PriceFeed it just deployed, without holding the
/// deployer key (same arrangement as the LST vault, issue #38).
function envOperatorAddress(): Address {
  return privateKeyToAccount(keccak256(toBytes("eris-role:admin"))).address;
}

export async function deployLiquityVenue({ seed }: { seed: boolean }) {
  info("Deploying Liquity V1 (CDP stablecoin venue, eUSD)");

  // --- core, then the LQTY side it insists on being wired to ---------------
  // Everything here takes no constructor arguments; the wiring happens through setAddresses below,
  // after which each contract renounces ownership.
  const sortedTroves = await deployLiquity("SortedTroves", "SortedTroves");
  const troveManager = await deployLiquity("TroveManager", "TroveManager");
  const activePool = await deployLiquity("ActivePool", "ActivePool");
  const stabilityPool = await deployLiquity("StabilityPool", "StabilityPool");
  const gasPool = await deployLiquity("GasPool", "GasPool");
  const defaultPool = await deployLiquity("DefaultPool", "DefaultPool");
  const collSurplusPool = await deployLiquity(
    "CollSurplusPool",
    "CollSurplusPool",
  );
  const borrowerOperations = await deployLiquity(
    "BorrowerOperations",
    "BorrowerOperations",
  );
  const hintHelpers = await deployLiquity("HintHelpers", "HintHelpers");

  // LQTY exists only because core address-wiring requires it. It gets no market and no valuation:
  // CommunityIssuance pays out on a one-year half-life, so emission over a few hundred blocks is
  // indistinguishable from zero.
  const communityIssuance = await deployLiquity(
    "CommunityIssuance",
    "CommunityIssuance",
  );
  const lqtyStaking = await deployLiquity("LQTYStaking", "LQTYStaking");
  const lockupContractFactory = await deployLiquity(
    "LockupContractFactory",
    "LockupContractFactory",
  );
  const lqtyToken = await deployLiquity("LQTYToken", "LQTYToken", [
    communityIssuance,
    lqtyStaking,
    lockupContractFactory,
    dep.address, // bounty
    dep.address, // lp rewards
    dep.address, // multisig
  ]);

  const eusd = await deployLiquity("eUSD (LUSDToken)", "LUSDToken", [
    troveManager,
    stabilityPool,
    borrowerOperations,
  ]);

  // The oracle Liquity will hold forever. It starts on its constructor price and is repointed at
  // each run's PriceFeed by the coordinator.
  const priceFeedArtifact = loadForgeArtifact(
    "LiquityPriceFeedAdapter",
    "LiquityPriceFeedAdapter",
  );
  const priceFeedHash = await deployerWallet.deployContract({
    abi: priceFeedArtifact.abi,
    bytecode: priceFeedArtifact.bytecode,
    args: [envOperatorAddress(), parseEther(GENESIS_PRICE_USD.toString())],
    account: dep,
    chain: anvilChain,
  });
  const priceFeed = (await waitTx(priceFeedHash)).contractAddress as Address;
  ok("LiquityPriceFeedAdapter", priceFeed);

  // --- wiring (order and arguments follow Liquity's own deploymentHelpers) ---
  info("Liquity: wiring contracts");
  await call(sortedTroves, "SortedTroves", "setParams", [
    // Unbounded list: Liquity mainnet passes maxBytes32 for the same reason. A cap would make the
    // last agent to open a Trove fail for a reason that has nothing to do with their strategy.
    2n ** 256n - 1n,
    troveManager,
    borrowerOperations,
  ]);
  await call(troveManager, "TroveManager", "setAddresses", [
    borrowerOperations,
    activePool,
    defaultPool,
    stabilityPool,
    gasPool,
    collSurplusPool,
    priceFeed,
    eusd,
    sortedTroves,
    lqtyToken,
    lqtyStaking,
  ]);
  await call(borrowerOperations, "BorrowerOperations", "setAddresses", [
    troveManager,
    activePool,
    defaultPool,
    stabilityPool,
    gasPool,
    collSurplusPool,
    priceFeed,
    sortedTroves,
    eusd,
    lqtyStaking,
  ]);
  await call(stabilityPool, "StabilityPool", "setAddresses", [
    borrowerOperations,
    troveManager,
    activePool,
    eusd,
    sortedTroves,
    priceFeed,
    communityIssuance,
  ]);
  await call(activePool, "ActivePool", "setAddresses", [
    borrowerOperations,
    troveManager,
    stabilityPool,
    defaultPool,
  ]);
  await call(defaultPool, "DefaultPool", "setAddresses", [
    troveManager,
    activePool,
  ]);
  await call(collSurplusPool, "CollSurplusPool", "setAddresses", [
    borrowerOperations,
    troveManager,
    activePool,
  ]);
  await call(hintHelpers, "HintHelpers", "setAddresses", [
    sortedTroves,
    troveManager,
  ]);
  await call(
    lockupContractFactory,
    "LockupContractFactory",
    "setLQTYTokenAddress",
    [lqtyToken],
  );
  await call(lqtyStaking, "LQTYStaking", "setAddresses", [
    lqtyToken,
    eusd,
    troveManager,
    borrowerOperations,
    activePool,
  ]);
  await call(communityIssuance, "CommunityIssuance", "setAddresses", [
    lqtyToken,
    stabilityPool,
  ]);
  ok("wiring", "core + LQTY connected");

  // Periphery: computes a redemption's hints inside the transaction that uses them. Liquity checks
  // a partial redemption against a hint derived from the *execution* price, and this environment
  // moves the oracle every block, so hints computed off-chain are stale by construction and every
  // redemption reverts (measured on the venue's first live run). See the contract's own notes.
  const redemptionHelperArtifact = loadForgeArtifact(
    "LiquityRedemptionHelper",
    "LiquityRedemptionHelper",
  );
  const redemptionHelperHash = await deployerWallet.deployContract({
    abi: redemptionHelperArtifact.abi,
    bytecode: redemptionHelperArtifact.bytecode,
    args: [troveManager, hintHelpers, sortedTroves, priceFeed, eusd],
    account: dep,
    chain: anvilChain,
  });
  const redemptionHelper = (await waitTx(redemptionHelperHash))
    .contractAddress as Address;
  ok("LiquityRedemptionHelper", redemptionHelper);

  setProtocol("liquity", {
    troveManager,
    borrowerOperations,
    stabilityPool,
    sortedTroves,
    activePool,
    defaultPool,
    collSurplusPool,
    gasPool,
    hintHelpers,
    priceFeed,
    redemptionHelper,
    eusd,
    lqtyToken,
    lqtyStaking,
    communityIssuance,
  });

  if (!seed) return;
  await seedLiquity({
    borrowerOperations,
    stabilityPool,
    troveManager,
    hintHelpers,
    sortedTroves,
    eusd,
  });
}

/// Mint the venue's initial eUSD from a genesis Trove and place it: half into an eUSD/USDC market so
/// the peg has somewhere to trade, and a slice into the Stability Pool so the first liquidation has
/// something to absorb it. Both are the environment's, not a participant's -- the deployer account
/// is excluded from scoring the same way the ADR 0009 stress victims are.
async function seedLiquity(addrs: {
  borrowerOperations: Address;
  stabilityPool: Address;
  troveManager: Address;
  hintHelpers: Address;
  sortedTroves: Address;
  eusd: Address;
}) {
  info("Liquity: opening the genesis Trove");
  const coll = parseEther(GENESIS_COLL_ETH.toString());
  const debt = parseEther(GENESIS_DEBT_EUSD.toString());
  await call(
    addrs.borrowerOperations,
    "BorrowerOperations",
    "openTrove",
    // No hints: an empty sorted list has nowhere to insert but the head.
    [MAX_BORROW_FEE, debt, ZERO, ZERO],
    coll,
  );
  const icr = (GENESIS_COLL_ETH * GENESIS_PRICE_USD * 100n) / GENESIS_DEBT_EUSD;
  ok(
    "genesis Trove",
    `${GENESIS_COLL_ETH} ETH / ${GENESIS_DEBT_EUSD} eUSD (ICR ${icr}%)`,
  );

  const minted = (await publicClient.readContract({
    address: addrs.eusd,
    abi: liquityArtifact("LUSDToken").abi,
    functionName: "balanceOf",
    args: [dep.address],
  })) as bigint;
  assert(
    minted >= parseEther((POOL_EUSD + STABILITY_POOL_EUSD).toString()),
    `genesis Trove minted ${minted} eUSD, too little to seed the venue`,
  );

  await seedEusdPool();

  info("Liquity: seeding the Stability Pool");
  await call(addrs.stabilityPool, "StabilityPool", "provideToSP", [
    parseEther(STABILITY_POOL_EUSD.toString()),
    ZERO, // no front-end tag
  ]);
  ok("stability pool", `${STABILITY_POOL_EUSD} eUSD`);

  // Liquity refuses redemptions for 14 days after deployment. Warping past it here means the state
  // dump (ADR 0016) is baked with the period already served, so a run never has to think about it.
  await publicClient.request({
    method: "evm_increaseTime" as never,
    params: [Number(BOOTSTRAP_SECONDS)] as never,
  });
  await publicClient.request({
    method: "evm_mine" as never,
    params: [] as never,
  });
  ok("bootstrap period", "warped past");

  await verifyLiquity(addrs);
}

/// Prove the venue works before anything is baked into a state dump. Each check stands for a
/// specific way this deployment can come out looking fine and be useless:
///   - the rename is a `sed` in setup-vendors.sh, which silently does nothing against a source tree
///     that has already been renamed or has moved on
///   - a Trove that starts near liquidation, or a system already in Recovery Mode, would make every
///     run about the genesis position rather than about the agents
///   - redemptions are the whole point of the venue (issue #39's redemption arb), and they revert
///     for 14 days after deployment. If the warp above ever stops working, everything else here
///     still passes and the venue quietly loses its reason to exist.
async function verifyLiquity(addrs: {
  troveManager: Address;
  hintHelpers: Address;
  sortedTroves: Address;
  eusd: Address;
}) {
  const price = parseEther(GENESIS_PRICE_USD.toString());
  const symbol = (await publicClient.readContract({
    address: addrs.eusd,
    abi: liquityArtifact("LUSDToken").abi,
    functionName: "symbol",
  })) as string;
  assert(
    symbol === "eUSD",
    `the stablecoin is "${symbol}", not eUSD — the rename in setup-vendors.sh did not apply`,
  );

  const troveManagerAbi = liquityArtifact("TroveManager").abi;
  const troves = (await publicClient.readContract({
    address: addrs.troveManager,
    abi: troveManagerAbi,
    functionName: "getTroveOwnersCount",
  })) as bigint;
  assert(troves === 1n, `expected the genesis Trove alone, found ${troves}`);

  const tcr = (await publicClient.readContract({
    address: addrs.troveManager,
    abi: troveManagerAbi,
    functionName: "getTCR",
    args: [price],
  })) as bigint;
  // CCR is 150%: at or below it the system opens in Recovery Mode, where borrowing is restricted
  // and every Trove under 150% is liquidatable.
  assert(
    tcr > parseEther("1.5"),
    `the system opens in Recovery Mode (TCR ${tcr})`,
  );

  // A simulated redemption, not a real one: the dump has to be taken on a venue nobody has traded.
  const probe = parseEther("1000");
  const [firstHint, partialNICR] = (await publicClient.readContract({
    address: addrs.hintHelpers,
    abi: liquityArtifact("HintHelpers").abi,
    functionName: "getRedemptionHints",
    args: [probe, price, 0n],
  })) as [Address, bigint, bigint];
  const [upperHint, lowerHint] = (await publicClient.readContract({
    address: addrs.sortedTroves,
    abi: liquityArtifact("SortedTroves").abi,
    functionName: "findInsertPosition",
    args: [partialNICR, ZERO, ZERO],
  })) as [Address, Address];
  await publicClient.simulateContract({
    account: dep,
    address: addrs.troveManager,
    abi: troveManagerAbi,
    functionName: "redeemCollateral",
    args: [
      probe,
      firstHint,
      upperHint,
      lowerHint,
      partialNICR,
      0n,
      MAX_BORROW_FEE,
    ],
  });
  ok(
    "redemptions",
    `open (TCR ${(tcr * 100n) / 10n ** 18n}%, ${troves} trove)`,
  );
}

/// eUSD/USDC on the stableswap factory that already hosts USDC/DAI. Real LUSD's dominant venue was
/// Curve, and its peg-then-cliff shape is what makes a depeg legible as a redemption opportunity
/// rather than as noise.
async function seedEusdPool() {
  const registry = getRegistry();
  const curve = registry.protocols.curve as { factory?: Address } | undefined;
  if (!curve?.factory) {
    info("Liquity: no curve factory in the registry, skipping the eUSD market");
    return;
  }
  info("Liquity: creating the eUSD/USDC pool");
  const factoryAbi = curveArtifact("CurveStableSwapFactoryNG").abi;
  const eusd = (getRegistry().protocols.liquity as { eusd: Address }).eusd;
  const usdc = token("USDC");
  const coins = [eusd, usdc] as Address[];

  const deployHash = await deployerWallet.writeContract({
    address: curve.factory,
    abi: factoryAbi,
    functionName: "deploy_plain_pool",
    args: [
      "Eris eUSD/USDC",
      "eUSDUSDC",
      coins,
      A,
      FEE,
      OFFPEG,
      MA_EXP_TIME,
      0n,
      [0, 0],
      ["0x00000000", "0x00000000"],
      [ZERO, ZERO],
    ],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(deployHash);

  const count = (await publicClient.readContract({
    address: curve.factory,
    abi: factoryAbi,
    functionName: "pool_count",
  })) as bigint;
  const pool = (await publicClient.readContract({
    address: curve.factory,
    abi: factoryAbi,
    functionName: "pool_list",
    args: [count - 1n],
  })) as Address;
  assert(pool !== ZERO, "the eUSD/USDC pool was not created");
  ok("eUSD/USDC pool", pool);

  const eusdAmt = parseEther(POOL_EUSD.toString());
  const usdcAmt = parseUnits(POOL_EUSD.toString(), 6);
  await approve(eusd, pool, eusdAmt);
  await approve(usdc, pool, usdcAmt);
  const addHash = await deployerWallet.writeContract({
    address: pool,
    abi: curveArtifact("CurveStableSwapNG").abi,
    functionName: "add_liquidity",
    args: [[eusdAmt, usdcAmt], 0n, dep.address],
    account: dep,
    chain: anvilChain,
  });
  await waitTx(addHash);
  ok("add_liquidity", `${POOL_EUSD} eUSD / ${POOL_EUSD} USDC (at par)`);

  setProtocol("liquity", { eusdUsdcPool: pool, eusdIndex: 0, usdcIndex: 1 });
}

function curveArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(
    readFileSync(resolve(ROOT, `vendor/curve/${name}.json`), "utf8"),
  );
  return {
    abi: j.abi as Abi,
    bytecode: (j.bytecode ?? j.blueprintBytecode) as Hex,
  };
}
