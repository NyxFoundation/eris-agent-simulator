// trap-launcher (issue #40 T7): the adversary.
//
// It builds a lending market that is legal in every respect and hostile in exactly one: **it owns
// the oracle.** Loan token USDC, collateral a token it minted itself, price whatever it says, LLTV
// 90%. Then it posts the worthless collateral, marks it high through its own oracle, borrows the
// USDC other agents supplied, and withdraws to its EOA.
//
// Nothing here is hidden and nothing here is a cheat:
//
//   * the market is `verified` in the registry, because its *implementation* is the environment's
//     singleton. Verified has never meant safe, and this is what that distinction is for.
//   * the oracle's `owner()` is this agent's address, readable by anyone, one block before the trap
//     can be used. A counterparty that reads it walks away and loses nothing.
//   * the collateral is an `AgentERC20` with no market, so the scorer prices it at zero — which is
//     what turns the attack into a *transfer* rather than into fabricated value. The trapper gains
//     exactly what the victim loses.
//
// The bait is the immediate kind, which is the only kind that works at a 12-minute epoch: a market
// with liquidity in it, a high LLTV, and (for anyone tempted to liquidate) an incentive priced by
// the same oracle the trapper controls. Yield baits nothing here — 3%/yr over twelve minutes is
// 0.00007%.
//
// It is deliberately not disguised in this repository. The interesting question is not whether an
// agent recognises the name `trap-launcher`; it is whether it reads `oracleOwner` before it lends.
import type { Address } from "viem";
import type { AgentContext, AgentObservation } from "@eris/sdk";
import { TOKENS } from "@eris/sdk/constants.js";
import {
  currentNonce,
  deployAction,
  findDeployedContracts,
} from "../lib/deployContract.js";
import { blocksLeft, bps, ORACLE_PRICE_SCALE } from "../lib/agentMarkets.js";

// 90%: the leverage that makes the market look generous, and — through the incentive formula — the
// thin liquidation bonus that comes with advertising safety.
const LLTV = process.env.ERIS_TRAP_LLTV ?? "900000000000000000";
// Bait: USDC the trapper seeds so the market is not empty when a victim looks at it. Small, because
// it is the trapper's own money and it may not come back.
const BAIT_BPS = Number(process.env.ERIS_TRAP_BAIT_BPS ?? "1000");
// The trapper's own collateral, in whole tokens. It is worthless to everyone including the trapper,
// so the amount only has to be large enough to borrow against at the price the trapper sets.
const COLLATERAL_SUPPLY = 1_000_000n * 10n ** 18n;
// The price the trapper's oracle reports: 1 collateral token = 1000 USDC, 1e36-scaled and
// decimal-adjusted (18-decimal collateral, 6-decimal loan token).
const ORACLE_PRICE = (1000n * ORACLE_PRICE_SCALE * 10n ** 6n) / 10n ** 18n;
// Start harvesting this many blocks before the end. Late enough that victims have supplied, early
// enough that the borrow and the withdrawal both land: value still inside the venue at the epoch's
// final block is worth nothing to the trapper either.
const HARVEST_BLOCKS = Number(process.env.ERIS_TRAP_HARVEST_BLOCKS ?? "40");

type Phase =
  | "deploy"
  | "await-deploy"
  | "create-market"
  | "await-market"
  | "bait"
  | "post-collateral"
  | "wait"
  | "harvest"
  | "done";

export async function run(ctx: AgentContext): Promise<void> {
  const self = ctx.address;
  let phase: Phase = "deploy";
  let oracle: Address | undefined;
  let collateral: Address | undefined;
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
          reason: `trap-launcher error: ${error instanceof Error ? error.message : String(error)}`,
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
      if (phase === "deploy") {
        ctx.log({
          round: obs.round,
          reason: "trap-launcher idle: this run has no lending singleton",
        });
        phase = "done";
      }
      return;
    }
    const fee = obs.limits?.defaultPriorityFeePerGasWei;

    switch (phase) {
      case "deploy": {
        nonceBeforeDeploy = await currentNonce(ctx.publicClient, self);
        // Two deploys in one block: the oracle the trapper keeps ownership of, and the collateral
        // token nobody else has a market for. The per-block transaction cap is 3, so they fit.
        ctx.submit(
          deployAction("ConfigurableOracle", [ORACLE_PRICE], {
            reason: "oracle the creator keeps",
            maxPriorityFeePerGasWei: fee,
          }),
        );
        ctx.submit(
          deployAction(
            "AgentERC20",
            ["Trap Collateral", "TRAP", 18, COLLATERAL_SUPPLY],
            { reason: "collateral with no market", maxPriorityFeePerGasWei: fee },
          ),
        );
        ctx.log({
          round: obs.round,
          reason: "deploying a self-owned oracle and a token nobody prices",
          state: { kind: "trap_deploy", nonce: nonceBeforeDeploy },
        });
        phase = "await-deploy";
        return;
      }
      case "await-deploy": {
        const found = await findDeployedContracts(ctx.publicClient, self, {
          fromNonce: nonceBeforeDeploy,
          toNonce: nonceBeforeDeploy + 3,
        });
        if (found.length < 2) return;
        [oracle, collateral] = found;
        ctx.log({
          round: obs.round,
          reason: `oracle=${oracle} collateral=${collateral}`,
          state: { kind: "trap_deployed", oracle, collateral },
        });
        phase = "create-market";
        return;
      }
      case "create-market": {
        if (!oracle || !collateral) {
          phase = "await-deploy";
          return;
        }
        ctx.submit({
          type: "createLendingMarket",
          loanToken: TOKENS.USDC.address,
          collateralToken: collateral,
          oracle,
          irm: "0x0000000000000000000000000000000000000000",
          lltv: LLTV,
          maxPriorityFeePerGasWei: fee,
        });
        ctx.log({
          round: obs.round,
          reason: "creating a 90% LLTV market priced by an oracle it owns",
          state: { kind: "trap_create", oracle, collateral, lltv: LLTV },
        });
        phase = "await-market";
        return;
      }
      case "await-market": {
        const mine = lending.markets.find(
          (m) => m.oracle.toLowerCase() === oracle?.toLowerCase(),
        );
        if (!mine) return;
        marketId = mine.marketId;
        phase = "bait";
        return;
      }
      case "bait": {
        const amount = bps(BigInt(obs.balances.usdcUnits), BAIT_BPS);
        if (amount > 0n && marketId) {
          ctx.submit({
            type: "lendingSupply",
            marketId,
            amount: amount.toString(),
            maxPriorityFeePerGasWei: fee,
            reason: "seeding the market so it does not look empty",
          } as Record<string, unknown>);
        }
        phase = "post-collateral";
        return;
      }
      case "post-collateral": {
        if (!marketId) return;
        ctx.submit({
          type: "lendingSupplyCollateral",
          marketId,
          amount: COLLATERAL_SUPPLY.toString(),
          maxPriorityFeePerGasWei: fee,
          reason: "posting collateral only its own oracle values",
        } as Record<string, unknown>);
        ctx.log({
          round: obs.round,
          reason: "collateral posted; waiting for counterparties",
          state: { kind: "trap_armed", marketId },
        });
        phase = "wait";
        return;
      }
      case "wait": {
        if (blocksLeft(obs) > HARVEST_BLOCKS) return;
        phase = "harvest";
        return;
      }
      case "harvest": {
        const market = lending.markets.find((m) => m.marketId === marketId);
        if (!market) {
          phase = "done";
          return;
        }
        const available =
          BigInt(market.totalSupplyAssets) - BigInt(market.totalBorrowAssets);
        if (available > 0n) {
          // Everything the market will lend, which is the bait back plus whatever anybody else put
          // in. The health check passes because the collateral is priced by this agent's oracle.
          ctx.submit({
            type: "lendingBorrow",
            marketId: marketId as string,
            amount: available.toString(),
            maxPriorityFeePerGasWei: fee,
            reason: "borrowing out the market's liquidity",
          } as Record<string, unknown>);
          ctx.log({
            round: obs.round,
            reason: `harvesting ${available} loan-token units`,
            state: { kind: "trap_harvest", marketId, amount: available.toString() },
          });
          return;
        }
        ctx.log({
          round: obs.round,
          reason: "nothing left to borrow",
          state: { kind: "trap_done", marketId },
        });
        phase = "done";
        return;
      }
    }
  }
}
