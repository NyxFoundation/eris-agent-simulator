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
import type { AgentContext, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  currentNonce,
  deployAction,
  findDeployedContracts,
} from "../lib/deployContract.js";
import { blocksLeft, bps } from "../lib/agentMarkets.js";

// Loan-to-value the market liquidates at, in WAD. 80% is the conservative end: it caps a borrower's
// leverage at 5x and, through the incentive formula, keeps the liquidation bonus near 3%.
const LLTV = process.env.ERIS_LAUNCHER_LLTV ?? "800000000000000000";
// Share of the USDC balance seeded into the market. Declared here because nothing hands a size
// down: the competition has no per-order cap, so a strategy that does not size itself has no size.
const SEED_BPS = Number(process.env.ERIS_LAUNCHER_SEED_BPS ?? "3000");
// Start withdrawing this many blocks before the end. A supply position still inside the venue at
// the epoch's final block is worth zero, and the withdrawal itself needs a block to land.
const EXIT_BLOCKS = Number(process.env.ERIS_LAUNCHER_EXIT_BLOCKS ?? "12");

// Withdraw as much as the market can actually pay right now.
//
// "max" is the right ask and the wrong plan: it withdraws the whole supply position, and a market
// whose loan tokens are out with a borrower cannot pay it, so the transaction reverts and the whole
// position stays inside. Under the round-trip rule the difference between "all or nothing" and "as
// much as is there" is the difference between zero and most of it. Measured in a live run: a
// borrower could not repay (a separate bug), the market stayed utilised, and an all-or-nothing exit
// left 7,500 USDC inside at the bell.
function withdrawAction(
  lending: NonNullable<AgentObservation["protocols"]["lending"]>,
  marketId: string,
  fee: string | undefined,
): Record<string, unknown> {
  const market = lending.markets.find((m) => m.marketId === marketId);
  const supplied = BigInt(market?.supplyAssets ?? "0");
  const idle =
    BigInt(market?.totalSupplyAssets ?? "0") -
    BigInt(market?.totalBorrowAssets ?? "0");
  const available = idle < supplied ? idle : supplied;
  return available > 0n && available < supplied
    ? {
        type: "lendingWithdraw",
        marketId,
        amount: available.toString(),
        maxPriorityFeePerGasWei: fee,
      }
    : {
        type: "lendingWithdraw",
        marketId,
        amount: "max",
        maxPriorityFeePerGasWei: fee,
      };
}

type Phase =
  | "deploy-oracle"
  | "await-oracle"
  | "create-market"
  | "await-market"
  | "supplied"
  | "exiting"
  | "done";

export async function run(ctx: AgentContext): Promise<void> {
  const self = ctx.address;
  let phase: Phase = "deploy-oracle";
  let oracle: Address | undefined;
  let marketId: string | undefined;
  let nonceBeforeDeploy = 0;
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
        phase = "supplied";
        return;
      }
      case "supplied": {
        if (blocksLeft(obs) > EXIT_BLOCKS) return;
        if (!marketId) {
          phase = "done";
          return;
        }
        ctx.submit(withdrawAction(lending, marketId, fee));
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
        // Utilisation is the supplier's risk, not an accounting error: if a borrower has the loan
        // tokens, there is nothing to hand back and the withdrawal reverts. Retry every block --
        // a repayment or a liquidation may free the liquidity before the bell.
        if (mine && BigInt(mine.supplyAssets) > 0n && blocksLeft(obs) > 1) {
          ctx.submit(withdrawAction(lending, marketId as string, fee));
          return;
        }
        ctx.log({
          round: obs.round,
          reason: "exited",
          state: { kind: "market_launcher_done", marketId },
        });
        phase = "done";
        return;
      }
    }
  }
}
