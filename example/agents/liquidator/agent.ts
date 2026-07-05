// liquidator (GitHub #1): a bot that liquidates via Aave V3's liquidationCall.
// Since observations don't include victims by principle, it receives the addresses to watch via
// env (ERIS_LIQUIDATION_VICTIMS, comma-separated) and reads getUserAccountData directly over RPC.
// When it finds a victim with HF<1 it sends liquidationCall via rawTx (repay the debt in USDC and
// receive WETH collateral + bonus). It settles PnL by swapping the received WETH back to USDC via a
// semantic swap on the next observation.
//
// Because it hits RPC directly outside the observation and acts on its own timing, it uses the run(ctx)
// contract (ADR 0015 §3). Signing, sending, nonce, and logging use the runtime's (ctx.submit / ctx.log).
import { maxUint256, parseAbi } from "viem";
import type { AgentContext } from "@eris/sdk";
import { AAVE, TOKENS } from "@eris/sdk/constants.js";
import { VICTIM_ADDRESS } from "@eris/sdk/wellKnown.js";
import { buildLiquidationCall } from "../lib/aave-liquidation.js";

const poolAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);

const HF_ONE = 10n ** 18n;
// Lower bound for distinguishing WETH received from liquidation (enough not to be confused with the initial
// balance). Since it's hard to sell exactly "the increase" while sitting well above the initial 10 WETH, here
// we convert WETH above the threshold into USDC in fixed sizes.
const WETH_REALIZE_THRESHOLD_WEI = 10_500_000_000_000_000_000n; // 10.5 WETH

export async function run(ctx: AgentContext): Promise<void> {
  const victims = (process.env.ERIS_LIQUIDATION_VICTIMS ?? VICTIM_ADDRESS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let busy = false;
  ctx.onObservation((obs) => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const fee = obs.limits.defaultPriorityFeePerGasWei;

        // 1) If there is a victim with HF<1, liquidate (repay in USDC -> receive WETH collateral)
        for (const victim of victims) {
          const acc = (await ctx.publicClient.readContract({
            address: AAVE.Pool,
            abi: poolAbi,
            functionName: "getUserAccountData",
            args: [victim as `0x${string}`],
          })) as readonly bigint[];
          const totalDebt = acc[1];
          const hf = acc[5];
          if (totalDebt > 0n && hf < HF_ONE) {
            const tx = buildLiquidationCall(
              TOKENS.WETH.address,
              TOKENS.USDC.address,
              victim,
              maxUint256, // clamped by the close factor
              false,
            );
            const action = {
              type: "rawTx",
              tx,
              maxPriorityFeePerGasWei: fee,
            };
            ctx.log({
              round: obs.round,
              action,
              reason: `liquidate ${victim} (hf<1)`,
            });
            ctx.submit(action);
            return;
          }
        }

        // 2) Settle by swapping the WETH gained from liquidation back to USDC (sell roughly the amount above the initial WETH)
        const wethWei = BigInt(obs.balances.wethWei);
        if (wethWei > WETH_REALIZE_THRESHOLD_WEI) {
          const maxIn = BigInt(obs.limits.maxWethInWei);
          const excess = wethWei - 10_000_000_000_000_000_000n; // amount above the initial 10 WETH
          const amountIn = excess < maxIn ? excess : maxIn;
          if (amountIn > 0n) {
            const action = {
              type: "swap",
              tokenIn: "WETH",
              amountIn: amountIn.toString(),
              slippageBps: 100,
              maxPriorityFeePerGasWei: fee,
            };
            ctx.log({
              round: obs.round,
              action,
              reason: "realize seized WETH",
            });
            ctx.submit(action);
            return;
          }
        }
      } catch (error) {
        ctx.log({
          round: obs.round,
          reason: `liquidator error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        busy = false;
      }
    })();
  });
}
