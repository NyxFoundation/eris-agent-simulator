// Liquity venue: the environment's side of the CDP stablecoin (issue #39).
//
// Two jobs, and they are the two things about this venue that cannot live in the adapter.
//
// *The oracle.* Liquity renounces ownership once wired, so the price feed address baked into
// TroveManager is permanent -- while this environment deploys a fresh PriceFeed every run. The
// LiquityPriceFeedAdapter sits between them and each run points it at its own feed. Until that
// happens the venue marks collateral at the price it was deployed with, which would silently make
// every ratio in the observation fiction, so the setup below refuses to start without it.
//
// *The peg.* eUSD trades against USDC on the stableswap pool the deploy seeded at par, and at par
// there is nothing to trade: redemption arb only exists when the market has moved away from the $1
// the protocol will always redeem at. `eusdDepeg` is the stress event that puts it there -- the
// environment sells eUSD into the pool for the length of a window and buys it back afterwards, the
// same reconcile-to-a-target shape as the liquidity pull (issue #52) and for the same reason: the
// coordinator drops block notifications while it is busy, so a state that is re-derived every block
// costs a block of lag where a one-shot would strand the pool.
import { encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import {
  curveStableSwapNgAbi,
  erc20Abi,
  troveManagerAbi,
} from "@eris/sdk/abis.js";
import { accountAddress, sendAndMine, sendNoMine } from "@eris/sdk/chain.js";
import { liquityPriceFeedAdapterAbi } from "@eris/sdk/abis.js";
import { LIQUITY, requireEusdMarket } from "@eris/sdk/constants.js";
import {
  getLiquityState,
  type LiquityState,
} from "@eris/sdk/protocols/liquity.js";
import type { SimContext } from "@eris/sdk/protocols/types.js";
import type { RunLogger } from "../logger.js";
import type { EventSchedule } from "./events.js";
import {
  setupStableDepeg,
  type StableDepegRuntime,
} from "./stableDepeg.js";

// How far the oracle the venue serves may sit from the run's fair price before the run refuses to
// start. This is not calibration noise: either the adapter points at this run's PriceFeed or it does
// not, and if it does not, every Trove is marked against a price from another run entirely.
const ORACLE_TOLERANCE_BPS = 100;

// The eUSD market is seeded at par by the deploy, so a gap this large at startup means the pool is
// not the one the deployment thinks it is (or the run inherited a chain a previous run left
// depegged). Either way the redemption arb would open as a freebie for whoever looks first.
export const LIQUITY_STARTUP_WARN_BPS = 25;
export const LIQUITY_STARTUP_FAIL_BPS = 200;

// Swaps against a stableswap pool are a fixed shape; pinning the gas skips an eth_estimateGas (a
// whole extra EVM execution) on a transaction the environment may send every block of a window.
const DEPEG_GAS = 600_000n;

// Slippage bound on the environment's own depeg trades. It is not being protected from a bad price
// -- moving the price is the point -- only from a pathological fill.
const DEPEG_SLIPPAGE_BPS = 500n;

// Deltas below this fraction of the pool's seeded eUSD depth are rounding, not schedule. Closing the
// window is exempt: leaving the peg broken would hand the rest of the run a different venue.
const MIN_DELTA_BPS = 50n;

// Blocks to wait for a submitted swap before treating it as lost. Under interval mining a
// transaction lands on the next block, so this is slack for a busy block rather than a normal path.
const PENDING_TIMEOUT_BLOCKS = 3;

export type LiquityRuntime = {
  troveManager: Address;
  priceFeedAdapter: Address;
  // Whether the environment's admin key could repoint the oracle. False means the run is marking
  // against whatever the adapter already served, which the setup refuses -- kept for the log.
  oracleRepointed: boolean;
};

/// Point Liquity's permanent oracle at this run's PriceFeed, then refuse to start on a venue that
/// would trade against the wrong price or a peg that is already broken.
export async function setupLiquity(
  ctx: SimContext,
  opts: { priceFeed: Address; fairPrice: number },
  logger: RunLogger,
): Promise<LiquityRuntime> {
  if (!LIQUITY) {
    throw new Error(
      "the liquity protocol is enabled but no Liquity deployment is available: the venue exists " +
        "only under local deploy (issue #39). Enable run.localDeploy with a state dump that " +
        "includes liquity, or drop liquity from run.protocols.",
    );
  }
  const admin = accountAddress(ctx.adminPk);
  const operator = (await ctx.publicClient.readContract({
    address: LIQUITY.priceFeed,
    abi: liquityPriceFeedAdapterAbi,
    functionName: "operator",
  })) as Address;
  if (operator.toLowerCase() !== admin.toLowerCase()) {
    // Without the operator key the oracle keeps serving whatever it last served. Liquity would still
    // run -- it never reverts on a stale price, by design -- and every ICR, TCR and liquidation in
    // the run would be computed against a price this run never set.
    throw new Error(
      `the Liquity oracle adapter (${LIQUITY.priceFeed}) is owned by ${operator}, but this run's ` +
        `admin key is ${admin}, so the venue cannot be pointed at this run's PriceFeed. It would ` +
        "mark every Trove against the price baked in at deploy time (deployer/contracts/LiquityPriceFeedAdapter.sol).",
    );
  }
  await sendAndMine(
    ctx.publicClient,
    ctx.walletClient,
    ctx.chain,
    ctx.adminPk,
    {
      to: LIQUITY.priceFeed,
      data: encodeFunctionData({
        abi: liquityPriceFeedAdapterAbi,
        functionName: "setSource",
        args: [opts.priceFeed],
      }),
    },
  );

  // What the venue would actually serve now. Simulated rather than read: `fetchPrice` caches, so
  // `lastGoodPrice` only tells us what some earlier transaction saw.
  const served = (
    await ctx.publicClient.simulateContract({
      account: admin,
      address: LIQUITY.priceFeed,
      abi: liquityPriceFeedAdapterAbi,
      functionName: "fetchPrice",
    })
  ).result as bigint;
  const servedUsd = Number(served) / 1e18;
  const driftBps =
    opts.fairPrice > 0
      ? Math.abs((servedUsd - opts.fairPrice) / opts.fairPrice) * 10_000
      : 10_000;
  if (driftBps > ORACLE_TOLERANCE_BPS) {
    throw new Error(
      `the Liquity oracle serves ${servedUsd.toFixed(2)} USD/ETH while this run's fair price is ` +
        `${opts.fairPrice.toFixed(2)} (${driftBps.toFixed(0)}bps apart, limit ${ORACLE_TOLERANCE_BPS}). ` +
        `The adapter was pointed at ${opts.priceFeed}; a gap here means it is not reading it.`,
    );
  }

  const state = await getLiquityState(ctx, opts.fairPrice);
  logger.event({
    type: "liquity_setup",
    troveManager: LIQUITY.troveManager,
    eusd: LIQUITY.eusd,
    market: LIQUITY.eusdUsdcPool ?? null,
    priceFeed: opts.priceFeed,
    oracleServedUsd: servedUsd,
    oracleDriftBps: Number(driftBps.toFixed(2)),
    tcr: state.tcr,
    recoveryMode: state.recoveryMode,
    troveCount: state.troveCount,
    totalDebtEusdWei: state.totalDebtEusdWei.toString(),
    borrowingRateBps: state.borrowingRateBps,
    redemptionRateBps: state.redemptionRateBps,
    stabilityPoolEusdWei: state.spTotalDepositsEusdWei.toString(),
    marketPriceUsdc: state.midPriceUsdc,
    marketQuoted: state.marketQuoted,
    discountBps: state.discountBps,
  });

  // Recovery Mode at block zero would make the whole run about the seeded Troves rather than about
  // the agents: borrowing is restricted and everything under CCR is liquidatable from the start.
  if (state.recoveryMode) {
    throw new Error(
      `the Liquity system opens in Recovery Mode (TCR ${state.tcr.toFixed(3)} < CCR ${state.ccr}). ` +
        "The genesis Trove is calibrated against the deploy-time price, so this usually means the " +
        "run's fair price is far below it (deployer/src/protocols/liquity.ts GENESIS_PRICE_USD).",
    );
  }
  if (state.market && !state.marketQuoted) {
    throw new Error(
      "the eUSD/USDC pool did not quote at startup: it reverted or has no liquidity at probe size. " +
        "Check that the deploy seeded it (deployer/src/protocols/liquity.ts seedEusdPool).",
    );
  }
  const absDiscount = Math.abs(state.discountBps);
  if (absDiscount > LIQUITY_STARTUP_FAIL_BPS) {
    throw new Error(
      `liquity no-arbitrage check failed at startup: eUSD trades ${state.discountBps.toFixed(1)}bps ` +
        `off par (limit ${LIQUITY_STARTUP_FAIL_BPS}bps). The pool is seeded at par, so this is a ` +
        "dirty chain or a mis-deploy, and it would open as a risk-free redemption for whoever looks first.",
    );
  }
  if (absDiscount > LIQUITY_STARTUP_WARN_BPS) {
    console.warn(
      `[liquity] eUSD opens ${state.discountBps.toFixed(1)}bps off par (warn above ${LIQUITY_STARTUP_WARN_BPS}bps)`,
    );
  }

  return {
    troveManager: LIQUITY.troveManager,
    priceFeedAdapter: LIQUITY.priceFeed,
    oracleRepointed: true,
  };
}

/// Per-block telemetry. Cheap (the coordinator already reads this state) and the primary post-run
/// source for whether the venue behaved: where the peg sat, how the fee curve moved, and whether the
/// system ever went into Recovery Mode.
export function liquityBlockEvent(
  state: LiquityState,
  blockNumber: number,
): Record<string, unknown> {
  return {
    type: "liquity_block",
    blockNumber,
    priceUsd: state.priceUsd,
    tcr: state.tcr,
    recoveryMode: state.recoveryMode,
    troveCount: state.troveCount,
    totalDebtEusdWei: state.totalDebtEusdWei.toString(),
    marketPriceUsdc: state.midPriceUsdc,
    discountBps: state.discountBps,
    redemptionRateBps: state.redemptionRateBps,
    borrowingRateBps: state.borrowingRateBps,
    stabilityPoolEusdWei: state.spTotalDepositsEusdWei.toString(),
    riskiestIcr: state.troves[0]?.icr ?? null,
  };
}

/// What the venue actually did in a range of blocks, from its own logs.
///
/// The block telemetry above can only say that a Trove disappeared; it cannot say whether it was
/// closed, redeemed away or liquidated. Issue #39's open question -- whether Liquity's ordering
/// sensitivity needs special handling in an environment that rewrites the oracle every block ahead
/// of every agent -- is a question about liquidations specifically, so it has to be counted rather
/// than inferred.
///
/// Scanned over a range because the coordinator drops block notifications while it is busy, the same
/// reason every other catch-up consumer here takes fromBlock..toBlock.
export async function watchLiquityEvents(
  ctx: SimContext,
  fromBlock: number,
  toBlock: number,
  logger: RunLogger,
): Promise<void> {
  if (!LIQUITY || fromBlock > toBlock) return;
  const range = {
    address: LIQUITY.troveManager,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  } as const;
  const [liquidated, redeemed] = await Promise.all([
    ctx.publicClient.getLogs({
      ...range,
      event: troveManagerAbi.find(
        (e) => e.type === "event" && e.name === "TroveLiquidated",
      ) as never,
      strict: false,
    }),
    ctx.publicClient.getLogs({
      ...range,
      event: troveManagerAbi.find(
        (e) => e.type === "event" && e.name === "Redemption",
      ) as never,
      strict: false,
    }),
  ]);
  for (const raw of liquidated) {
    const log = raw as unknown as {
      args?: Record<string, unknown>;
      blockNumber?: bigint;
      transactionHash?: string;
    };
    const args = log.args ?? {};
    logger.event({
      type: "liquity_liquidation",
      blockNumber: Number(log.blockNumber ?? 0n),
      borrower: String(args._borrower ?? ""),
      debtEusdWei: String(args._debt ?? ""),
      collWei: String(args._coll ?? ""),
      // Liquity's TroveManagerOperation: 0 = applyPendingRewards, 1 = liquidateInNormalMode,
      // 2 = liquidateInRecoveryMode, 3 = redeemCollateral. Which mode it was is the finding.
      operation: Number(args._operation ?? 0),
      txHash: log.transactionHash,
    });
  }
  for (const raw of redeemed) {
    const log = raw as unknown as {
      args?: Record<string, unknown>;
      blockNumber?: bigint;
      transactionHash?: string;
    };
    const args = log.args ?? {};
    logger.event({
      type: "liquity_redemption",
      blockNumber: Number(log.blockNumber ?? 0n),
      attemptedEusdWei: String(args._attemptedLUSDAmount ?? ""),
      actualEusdWei: String(args._actualLUSDAmount ?? ""),
      ethSentWei: String(args._ETHSent ?? ""),
      ethFeeWei: String(args._ETHFee ?? ""),
      txHash: log.transactionHash,
    });
  }
}
// ---------------------------------------------------------------------------
// eUSD depeg (the stress overlay's eusdDepeg, issue #39)
//
// The mechanism is stable-agnostic and lives in stableDepeg.ts, because issue #27 (c) needed the
// same thing for a second stable. What stays here is the part that is genuinely about this venue:
// which account holds the float, and what to tell an operator when it does not.
// ---------------------------------------------------------------------------

// #39 named these events before there was a second depeg. They keep their names so a run's
// diagnostics still line up with every measurement taken against them; other stables emit
// `stress_depeg` with the symbol in the payload.
export const EUSD_DEPEG_LABEL = "stress_eusd_depeg";

/// Stage the account that will move the peg.
///
/// The actor is the deployer, which is where the genesis Trove's eUSD ended up (issue #39 phase 1:
/// LUSDToken has no admin mint, so every eUSD in existence came out of that Trove). It is not a
/// participant and is excluded from scoring, the same arrangement as the ADR 0009 stress victims.
export async function setupEusdDepeg(
  ctx: SimContext,
  opts: { localDeploy: boolean; actorPk: Hex },
  logger: RunLogger,
): Promise<StableDepegRuntime> {
  if (!opts.localDeploy) {
    throw new Error(
      "stress event eusdDepeg requires run.localDeploy: the liquity venue and its eUSD market exist " +
        "only under local deploy (issue #39)",
    );
  }
  const market = requireEusdMarket();
  const l = LIQUITY!;
  return setupStableDepeg(
    ctx,
    {
      market: {
        symbol: "eUSD",
        stable: l.eusd,
        quote: market.stable,
        pool: market.pool,
        stableIndex: market.eusdIndex,
        quoteIndex: market.usdcIndex,
      },
      label: EUSD_DEPEG_LABEL,
      actorPk: opts.actorPk,
      emptyInventoryHint:
        "The deploy leaves the genesis Trove's surplus with the deployer account " +
        "(deployer/src/protocols/liquity.ts), so an empty balance means a different account deployed " +
        "the venue, or a previous run spent it.",
    },
    logger,
  );
}
