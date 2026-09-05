// market-launcher (issue #40 T7): the honest creator.
//
// It builds a venue the environment does not provide — a lending market with an **immutable** oracle
// — seeds it, runs it, and withdraws before the epoch ends. It is the counterpart to trap-launcher:
// the two create the same kind of thing, and everything that separates them is readable on chain
// before anybody commits money to either.
//
// Honest here means something specific and checkable:
//
//   * the oracle is a `PriceFeedOracle`: no setter, and `owner()` answers with the zero address. It
//     answers deliberately — "has no owner() function" and "has an owner of nobody" are different
//     facts to a caller, and only the second is checkable. A verifier that reads silence as
//     "possibly movable" is being correct, so an honest creator has to say it out loud.
//   * the LLTV is conservative (80%), which under Morpho's formula also means the liquidation
//     incentive is small. A creator advertising safety is advertising a thin bonus.
//   * it exits its own position before the bell, because under the round-trip rule a supplier who
//     cannot get out is worth nothing — including this one.
//
// Self-driven (`run(ctx)`, ADR 0015 §3) rather than `decide`, because creation is a sequence with
// state: deploy, wait for the address, create the market, supply, hold, withdraw.
import type { Address } from "viem";
import { encodeFunctionData } from "viem";
import type { AgentContext, AgentObservation } from "@eris/sdk";
import {
  nonfungiblePositionManagerAbi,
  poolAbi,
  uniswapV3FactoryAbi,
} from "@eris/sdk/abis.js";
import { TOKENS, UNISWAP } from "@eris/sdk/constants.js";
import {
  poolPriceUsdcPerWethFromSqrtX96,
  sqrtPriceX96For,
  uniswapFactory,
} from "@eris/sdk/protocols/uniswap.js";
import {
  currentNonce,
  deployAction,
  findDeployedContracts,
} from "../lib/deployContract.js";
import {
  blocksLeft,
  bps,
  withdrawableNow,
  withdrawAction,
} from "../lib/agentMarkets.js";

// Loan-to-value the market liquidates at, in WAD. 80% is the conservative end: it caps a borrower's
// leverage at 5x and, through the incentive formula, keeps the liquidation bonus near 3%.
const LLTV = process.env.ERIS_LAUNCHER_LLTV ?? "800000000000000000";
// Share of the USDC balance seeded into the market. Declared here because nothing hands a size
// down: the competition has no per-order cap, so a strategy that does not size itself has no size.
const SEED_BPS = Number(process.env.ERIS_LAUNCHER_SEED_BPS ?? "3000");
// Start withdrawing this many blocks before the end. A supply position still inside the venue at
// the epoch's final block is worth zero, and the withdrawal itself needs a block to land.
const EXIT_BLOCKS = Number(process.env.ERIS_LAUNCHER_EXIT_BLOCKS ?? "12");
// The fee tier the second market is opened at. The environment's WETH/USDC pool is 3000, so 500 is
// a venue that did not exist -- which is the point: "where should liquidity live" is only a decision
// if a different answer is reachable.
const POOL_FEE = Number(process.env.ERIS_LAUNCHER_POOL_FEE ?? "500");
// Full range for tickSpacing 10 (fee 500). A concentrated range would earn more and is a real
// choice; full range is the one that needs no view about where the price goes, which keeps this
// agent about *creating* a market rather than about running one.
const FULL_RANGE_LOWER = -887270;
const FULL_RANGE_UPPER = 887270;
// Share of the WETH and USDC balances seeded into the pool.
const POOL_SEED_BPS = Number(process.env.ERIS_LAUNCHER_POOL_BPS ?? "1500");
// How far the pool's actual price may sit from fair before this agent refuses to fund it. Pool
// creation is idempotent, so "I created it" does not mean "I set its price".
const POOL_MAX_DRIFT = Number(process.env.ERIS_LAUNCHER_POOL_MAX_DRIFT ?? "0.02");
// ~year 2106. A deadline is a wall-clock value, and a wall-clock value in calldata makes the same
// decision produce a different transaction on replay. The sdk's LP path uses the same constant.
const DEADLINE_FAR_FUTURE = BigInt(2 ** 32 - 1);
// How many blocks the seeding attempt is retried before giving up. The mint can revert for reasons
// this agent cannot see -- `simulateContract` runs against the latest block, so a higher-fee
// price-mover already in the mempool is invisible to it -- and one revert must not be the end of
// the attempt, or the bound that protects the deposit becomes the thing that prevents it.
const POOL_SEED_ATTEMPTS = Number(process.env.ERIS_LAUNCHER_POOL_ATTEMPTS ?? "6");

// The pool's own price, or undefined when it does not exist yet. Read through the factory, because
// a pool this agent just made is by definition not in the registered market set.
async function poolPriceFor(
  ctx: AgentContext,
  fee: number,
): Promise<number | undefined> {
  const factory = await uniswapFactory(ctx.publicClient);
  if (!factory) return undefined;
  try {
    const pool = (await ctx.publicClient.readContract({
      address: factory,
      abi: uniswapV3FactoryAbi,
      functionName: "getPool",
      args: [TOKENS.WETH.address, TOKENS.USDC.address, fee],
    })) as Address;
    if (!pool || pool === "0x0000000000000000000000000000000000000000") return undefined;
    const slot0 = await ctx.publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "slot0",
    });
    const price = poolPriceUsdcPerWethFromSqrtX96(slot0[0]);
    return price > 0 ? price : undefined;
  } catch {
    return undefined;
  }
}

type Phase =
  | "deploy-oracle"
  | "await-oracle"
  | "create-market"
  | "await-market"
  | "create-pool"
  | "seed-pool"
  | "supplied"
  | "exit-pool"
  | "exiting"
  | "done";

export async function run(ctx: AgentContext): Promise<void> {
  const self = ctx.address;
  let phase: Phase = "deploy-oracle";
  let oracle: Address | undefined;
  let marketId: string | undefined;
  let nonceBeforeDeploy = 0;
  let seedAttempts = 0;
  let busy = false;

  ctx.onObservation((obs) => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        await step(obs);
      } catch (error) {
        ctx.log({
          round: obs.round,
          reason: `market-launcher error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        busy = false;
      }
    })();
  });

  async function step(obs: AgentObservation): Promise<void> {
    if (phase === "done") return;
    const lending = obs.protocols.lending;
    if (!lending?.singleton) {
      // A run without the venue is a run where this agent has nothing to build. Say so once rather
      // than looking like an agent that chose not to act.
      if (phase === "deploy-oracle") {
        ctx.log({
          round: obs.round,
          reason: "market-launcher idle: this run has no lending singleton",
        });
        phase = "done";
      }
      return;
    }
    const fee = obs.limits?.defaultPriorityFeePerGasWei;
    // The deadline outranks every phase, not just the one that watches for it. Whatever this agent
    // is in the middle of -- waiting for a deploy, retrying a mint, waiting for a market to appear
    // -- the exit needs the blocks it needs, and a build that is still in progress at the bell is
    // worth less than nothing under the round-trip rule. Anything not yet built is abandoned here.
    if (
      blocksLeft(obs) <= EXIT_BLOCKS &&
      phase !== "exit-pool" &&
      phase !== "exiting"
    ) {
      ctx.log({
        round: obs.round,
        reason: `exit deadline reached during "${phase}" — abandoning the rest of the build`,
        state: { kind: "market_launcher_deadline", abandoned: phase },
      });
      phase = "exit-pool";
    }
    const priceFeed = process.env.ERIS_PRICE_FEED_ADDRESS as Address | undefined;
    if (!priceFeed) {
      ctx.log({
        round: obs.round,
        reason: "market-launcher idle: no PriceFeed address to build an oracle on",
      });
      phase = "done";
      return;
    }

    switch (phase) {
      case "deploy-oracle": {
        nonceBeforeDeploy = await currentNonce(ctx.publicClient, self);
        // Collateral WETH priced against a loan token treated as one dollar: the PriceFeed carries
        // bases, not stables, and USDC is the numéraire by definition.
        ctx.submit(
          deployAction(
            "PriceFeedOracle",
            [
              priceFeed,
              TOKENS.WETH.address,
              TOKENS.WETH.address,
              "0x0000000000000000000000000000000000000000",
              18,
              TOKENS.USDC.decimals,
            ],
            { reason: "immutable oracle for an honest market", maxPriorityFeePerGasWei: fee },
          ),
        );
        ctx.log({
          round: obs.round,
          reason: "deploying an ownerless PriceFeedOracle",
          state: { kind: "market_launcher_deploy", nonce: nonceBeforeDeploy },
        });
        phase = "await-oracle";
        return;
      }
      case "await-oracle": {
        const found = await findDeployedContracts(ctx.publicClient, self, {
          fromNonce: nonceBeforeDeploy,
          toNonce: nonceBeforeDeploy + 2,
        });
        if (found.length === 0) return; // still in the mempool; try again next block
        oracle = found[0];
        phase = "create-market";
        ctx.log({
          round: obs.round,
          reason: `oracle deployed at ${oracle}`,
          state: { kind: "market_launcher_oracle", oracle },
        });
        return;
      }
      case "create-market": {
        if (!oracle) {
          phase = "await-oracle";
          return;
        }
        ctx.submit({
          type: "createLendingMarket",
          loanToken: TOKENS.USDC.address,
          collateralToken: TOKENS.WETH.address,
          oracle,
          // No interest. At a 12-minute epoch a rate is decoration, and an IRM is one more contract
          // a counterparty would have to read; leaving it out is the honest simplification.
          irm: "0x0000000000000000000000000000000000000000",
          lltv: LLTV,
          maxPriorityFeePerGasWei: fee,
        });
        ctx.log({
          round: obs.round,
          reason: "creating a WETH-collateral / USDC-loan market with a frozen oracle",
          state: { kind: "market_launcher_create", oracle, lltv: LLTV },
        });
        phase = "await-market";
        return;
      }
      case "await-market": {
        // The market appears in the observation the block after it is created -- through the
        // singleton's own state, not through the registry, which is a block behind that again.
        const mine = lending.markets.find(
          (m) =>
            m.oracle.toLowerCase() === oracle?.toLowerCase() &&
            m.loanToken.toLowerCase() === TOKENS.USDC.address.toLowerCase(),
        );
        if (!mine) return;
        marketId = mine.marketId;
        const amount = bps(BigInt(obs.balances.usdcUnits), SEED_BPS);
        if (amount <= 0n) {
          ctx.log({
            round: obs.round,
            reason: "market created but there is no USDC to seed it with",
          });
          phase = "supplied";
          return;
        }
        ctx.submit({
          type: "lendingSupply",
          marketId,
          amount: amount.toString(),
          maxPriorityFeePerGasWei: fee,
        });
        ctx.log({
          round: obs.round,
          reason: `seeding ${amount} USDC into ${marketId}`,
          state: { kind: "market_launcher_seed", marketId, amount: amount.toString() },
        });
        phase = "create-pool";
        return;
      }
      case "create-pool": {
        // A WETH/USDC pool at a fee tier the environment does not run. It is `verified` in the
        // registry because the implementation is the factory's -- which says nothing about the
        // price it is initialized at, and that is exactly the distinction `verified` carries.
        const [token0, token1] =
          TOKENS.WETH.address.toLowerCase() < TOKENS.USDC.address.toLowerCase()
            ? [TOKENS.WETH, TOKENS.USDC]
            : [TOKENS.USDC, TOKENS.WETH];
        const wethIsToken0 =
          token0.address.toLowerCase() === TOKENS.WETH.address.toLowerCase();
        ctx.submit({
          type: "createPool",
          tokenA: TOKENS.WETH.address,
          tokenB: TOKENS.USDC.address,
          fee: POOL_FEE,
          // Initialized at fair. Seeding away from fair is legal and is somebody else's strategy;
          // an honest creator opens a market where it belongs.
          sqrtPriceX96: sqrtPriceX96For({
            humanPrice: wethIsToken0
              ? obs.fairPriceUsdcPerWeth
              : 1 / obs.fairPriceUsdcPerWeth,
            token0Decimals: token0.decimals,
            token1Decimals: token1.decimals,
          }).toString(),
          maxPriorityFeePerGasWei: fee,
        });
        ctx.log({
          round: obs.round,
          reason: `creating a WETH/USDC pool at fee ${POOL_FEE}`,
          state: { kind: "market_launcher_pool", fee: POOL_FEE },
        });
        phase = "seed-pool";
        return;
      }
      case "seed-pool": {
        // Did the last attempt land? The position appearing is the only evidence that matters, and
        // it is why this phase does not advance on submission.
        const seeded = obs.protocols.uniswap?.positions.some(
          (p) => p.market?.includes(`#${POOL_FEE}`) && BigInt(p.liquidity) > 0n,
        );
        if (seeded) {
          ctx.log({
            round: obs.round,
            reason: "pool seeded",
            state: { kind: "market_launcher_pool_live" },
          });
          phase = "supplied";
          return;
        }
        if (seedAttempts >= POOL_SEED_ATTEMPTS) {
          ctx.log({
            round: obs.round,
            reason: `giving up on seeding the pool after ${seedAttempts} attempts`,
            state: { kind: "market_launcher_pool_abandoned" },
          });
          phase = "supplied";
          return;
        }
        // **Check the price before funding it.** `createAndInitializePoolIfNecessary` is idempotent:
        // if somebody initialized this pair and fee tier first, the create call above succeeded
        // against *their* pool at *their* price, and a full-range mint with zero minimums would
        // hand the difference to whoever arbitrages it back. That is a real attack on a creator and
        // it costs one read to refuse.
        const poolPrice = await poolPriceFor(ctx, POOL_FEE);
        if (poolPrice === undefined) return; // not initialized yet; the create is still in flight
        const drift =
          Math.abs(poolPrice - obs.fairPriceUsdcPerWeth) /
          Math.max(1e-9, obs.fairPriceUsdcPerWeth);
        if (drift > POOL_MAX_DRIFT) {
          ctx.log({
            round: obs.round,
            reason:
              `refusing to seed the pool: it is initialized at ${poolPrice.toFixed(2)} against a ` +
              `fair of ${obs.fairPriceUsdcPerWeth.toFixed(2)} — somebody opened it first, and ` +
              "liquidity added at their price is theirs to arbitrage",
            state: { kind: "market_launcher_pool_refused", poolPrice, drift },
          });
          phase = "supplied";
          return;
        }
        // A rawTx rather than `mintLiquidity`: that action resolves the pool from the registered
        // market set, so it can only mint into the environment's fee tier. Minting into a pool you
        // just made is by definition outside that set.
        const [token0, token1] =
          TOKENS.WETH.address.toLowerCase() < TOKENS.USDC.address.toLowerCase()
            ? [TOKENS.WETH, TOKENS.USDC]
            : [TOKENS.USDC, TOKENS.WETH];
        const wethIsToken0 =
          token0.address.toLowerCase() === TOKENS.WETH.address.toLowerCase();
        const weth = bps(BigInt(obs.balances.wethWei), POOL_SEED_BPS);
        const usdc = bps(BigInt(obs.balances.usdcUnits), POOL_SEED_BPS);
        if (weth <= 0n || usdc <= 0n) {
          ctx.log({
            round: obs.round,
            reason: "pool created but there is nothing to seed it with",
          });
          phase = "supplied";
          return;
        }
        const mintParams = (amount0Min: bigint, amount1Min: bigint) => ({
          token0: token0.address,
          token1: token1.address,
          fee: POOL_FEE,
          tickLower: FULL_RANGE_LOWER,
          tickUpper: FULL_RANGE_UPPER,
          amount0Desired: wethIsToken0 ? weth : usdc,
          amount1Desired: wethIsToken0 ? usdc : weth,
          amount0Min,
          amount1Min,
          recipient: self,
          // Far future, not "now plus an hour": a wall-clock value in calldata makes the same
          // decision produce a different transaction on replay, and a deterministic replay of the
          // strategy is what §2.4 and §7 of the rules rest on. The sdk's own LP path uses the same
          // constant for the same reason.
          deadline: DEADLINE_FAR_FUTURE,
        });
        // The price check above is a read; this is the constraint. Between the read and the mine an
        // opponent can outbid this transaction, add liquidity and swap the price away, and a mint
        // with zero minimums would then deposit at *their* ratio for them to unwind. Simulating for
        // the amounts and bounding them is the same thing `mintLiquidity` does for the registered
        // markets -- it makes a moved price a revert rather than a donation.
        let mins: [bigint, bigint];
        try {
          const simulated = await ctx.publicClient.simulateContract({
            account: self,
            address: UNISWAP.nonfungiblePositionManager,
            abi: nonfungiblePositionManagerAbi,
            functionName: "mint",
            args: [mintParams(0n, 0n)],
          });
          const [, , amount0, amount1] = simulated.result;
          mins = [(amount0 * 99n) / 100n, (amount1 * 99n) / 100n];
        } catch (error) {
          // The pool moved, or the mint would fail for some other reason. Retry next block rather
          // than sending something that will revert and cost a transaction out of the allowance.
          ctx.log({
            round: obs.round,
            reason: `pool mint would revert: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
          });
          return;
        }
        ctx.submit({
          type: "rawTx",
          tx: {
            to: UNISWAP.nonfungiblePositionManager,
            data: encodeFunctionData({
              abi: nonfungiblePositionManagerAbi,
              functionName: "mint",
              args: [mintParams(mins[0], mins[1])],
            }),
          },
          maxPriorityFeePerGasWei: fee,
        } as Record<string, unknown>);
        ctx.log({
          round: obs.round,
          reason: `seeding the pool with ${weth} wei and ${usdc} USDC (attempt ${seedAttempts + 1})`,
          state: { kind: "market_launcher_pool_seed", attempt: seedAttempts + 1 },
        });
        seedAttempts++;
        // Deliberately still in `seed-pool`. The mint is bounded, so it *can* revert -- a
        // price-mover that outbid it, a simulation against a block that has since moved -- and a
        // phase that advanced on submission would treat one revert as the end of the attempt. The
        // next block sees whether a position exists (the check at the top of this case) and either
        // moves on or tries again.
        return;
      }
      case "supplied":
        // The transition out of here is the deadline guard above, which every phase goes through.
        return;
      case "exit-pool": {
        // The LP first. Both legs are tokens the environment prices, so this position is real value
        // and the round-trip rule marks it at its share of the pool's reserves -- but only while it
        // is a position. Left as an unclaimed balance inside the pool it is worth nothing.
        const position = obs.protocols.uniswap?.positions.find(
          (p) => p.market?.includes(`#${POOL_FEE}`) && BigInt(p.liquidity) > 0n,
        );
        if (position) {
          ctx.submit({
            type: "removeLiquidity",
            tokenId: position.tokenId,
            liquidity: position.liquidity,
            maxPriorityFeePerGasWei: fee,
          });
          ctx.log({
            round: obs.round,
            reason: `pulling liquidity from the pool (tokenId ${position.tokenId})`,
            state: { kind: "market_launcher_pool_exit", tokenId: position.tokenId },
          });
          return;
        }
        // decreaseLiquidity only credits tokensOwed; the tokens do not leave the pool until collect.
        const owed = obs.protocols.uniswap?.positions.find(
          (p) =>
            p.market?.includes(`#${POOL_FEE}`) &&
            (BigInt(p.tokensOwedWethWei) > 0n ||
              BigInt(p.tokensOwedUsdcUnits) > 0n),
        );
        if (owed) {
          ctx.submit({
            type: "collectFees",
            tokenId: owed.tokenId,
            maxPriorityFeePerGasWei: fee,
          });
          return;
        }
        if (!marketId) {
          phase = "done";
          return;
        }
        const exit = withdrawAction(lending, marketId, fee);
        if (exit) ctx.submit(exit);
        ctx.log({
          round: obs.round,
          reason: `round-tripping out of ${marketId} with ${blocksLeft(obs)} blocks left`,
          state: { kind: "market_launcher_exit", marketId },
        });
        phase = "exiting";
        return;
      }
      case "exiting": {
        const mine = lending.markets.find((m) => m.marketId === marketId);
        const { supplied } = withdrawableNow(mine);
        // Utilisation is the supplier's risk, not an accounting error: if a borrower has the loan
        // tokens there is nothing to hand back. Retry every block for as long as there is anything
        // to take -- a repayment or a liquidation can free liquidity before the bell -- and take
        // whatever is there rather than asking for all of it.
        if (supplied > 0n && blocksLeft(obs) > 1) {
          const exit = withdrawAction(lending, marketId as string, fee);
          if (exit) ctx.submit(exit);
          return;
        }
        ctx.log({
          round: obs.round,
          // Never "exited" when it did not. A creator whose own market was still holding its money
          // at the bell scored zero on it, and that is the finding, not a footnote.
          reason:
            supplied > 0n
              ? `could not exit: ${supplied} loan-token units still inside at the bell`
              : "exited",
          state: {
            kind: "market_launcher_done",
            marketId,
            strandedAssets: supplied.toString(),
          },
        });
        phase = "done";
        return;
      }
    }
  }
}
