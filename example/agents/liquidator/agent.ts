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
  // The environment sets this whenever it staged a cohort (ADR 0009 §4). There used to be a fallback
  // to a fixed demo address, from the single-victim predecessor that has since been removed -- so an
  // unset variable now means "this run has no victims", and scanning anything would be scanning an
  // account nobody opened. Say so once instead.
  const victims = (process.env.ERIS_LIQUIDATION_VICTIMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (victims.length === 0) {
    ctx.log({
      reason:
        "no ERIS_LIQUIDATION_VICTIMS in this run: nothing to liquidate " +
        "(set stress.victimCount > 0 to stage a cohort)",
    });
    return;
  }

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
          // Sell the whole seized excess in one go. It used to be dribbled out a cap's worth per
          // round, which left the agent holding WETH it had already decided to be rid of -- pure
          // directional exposure, on a strategy whose edge is the liquidation bonus.
          const amountIn = wethWei - 10_000_000_000_000_000_000n; // above the initial 10 WETH
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
