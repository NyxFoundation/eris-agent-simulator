// Shared core of discovery-arb / discovery-arb-verify (ADR 0014 §6).
// The discovery layer (PoolDiscovery) is shared, and *only the presence of the verification gate*
// differs (discrimination reduces to "verification"). naive jumps straight at a tasty quote and gets
// hit by a rigged pool. careful audits before trading with verifyContract (dry-run + codehash +
// optional LLM), rejects the rigged one, and profits from safe new pools.
//
// A direct-read run(ctx) agent (same shape as the liquidator; ADR 0015 §3): read the chain via
// ctx.publicClient, discover new pools from factory logs, and send actions via ctx.submit (signing,
// nonce, and self-report logging are handled by the runtime). New pools aren't in the adapter
// registry, so hit them with rawBundle/rawTx.
import { encodeFunctionData, maxUint256 } from "viem";
import type { Address } from "viem";
import type { AgentContext } from "@eris/sdk";
import { baseTokens, tokenInfo } from "@eris/sdk/markets.js";
import { PoolDiscovery, type BaseInfo } from "./poolDiscovery.js";
import { verifyContract } from "./verifyContract.js";
import { erc20ApproveAbi, vulnAmmAbi } from "./vulnAbi.js";

type PoolState = "new" | "approving" | "traded" | "avoided";

// Cap on the number of new txs emitted per block (avoid USDC exhaustion / nonce congestion; the rest go to later blocks).
// A no-tx decision (avoided) does not consume this budget.
const MAX_NEW_ACTIONS_PER_BLOCK = 2;
// careful: retry cap to avoid getting stuck in "approving" forever against a pool whose dry-run keeps
// reverting after approve (not because the approval hasn't landed, but a broken/booby-trapped dry-run).
// Once exceeded, fall to the safe side and avoid.
const MAX_VERIFY_RETRIES = 4;

export async function runDiscoveryAgent(
  ctx: AgentContext,
  opts: { verify: boolean },
): Promise<void> {
  const self = ctx.address;
  const factory = process.env.ERIS_VULN_FACTORY as Address | undefined;
  const runDir = process.env.ERIS_RUN_DIR;
  const llmMode = process.env.ERIS_VULN_LLM ?? "0";
  const gapEnv = Number(process.env.ERIS_DISCOVERY_GAP_BPS ?? "100");
  // With NaN, poolDiscovery's `gapBps < threshold` is always false, turning every pool into an
  // "opportunity" (fail-open). Fall back to the default 100bps on an invalid value.
  const gapThresholdBps = Number.isFinite(gapEnv) ? gapEnv : 100;

  // Bundle action logging + action submission with the same semantics as the old emit (equivalent to
  // createEmitter): record the action and reason in the log while streaming it to the mempool via ctx.submit.
  const emit = (
    action: Record<string, unknown>,
    meta: { round: number; signals: Record<string, number | undefined> },
  ): void => {
    ctx.log({ action, reason: reasonOf(action), ...meta });
    ctx.submit(action);
  };

  // In a run with no vuln pool (factory not distributed) there is nothing to discover -> idle (the
  // runtime's block subscription keeps the process alive). The old stdin/stdout per-line noop response is unnecessary in run(ctx).
  if (!factory) {
    ctx.log({ reason: "discovery idle: no vuln factory" });
    return;
  }

  const publicClient = ctx.publicClient;
  const usdc = tokenInfo("USDC");
  const bases: BaseInfo[] = baseTokens().map((t) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
  }));
  const discovery = new PoolDiscovery({
    publicClient,
    factory,
    fromBlock: BigInt(process.env.ERIS_VULN_FROM_BLOCK ?? "0"),
    usdcAddr: usdc.address,
    usdcDecimals: usdc.decimals,
    bases,
  });

  const state = new Map<string, PoolState>();
  const verifyRetries = new Map<string, number>();
  let busy = false;

  ctx.onObservation((obs) => {
    if (busy) return; // if the previous block's discovery/verification isn't done, limit to one to avoid drops
    busy = true;
    void (async () => {
      try {
        const bn = BigInt(obs.round ?? 0);
        const fee = obs.limits?.defaultPriorityFeePerGasWei;
        const amountIn = BigInt(obs.limits?.maxUsdcInUnits ?? "0");
        if (amountIn <= 0n) return;
        const fairByBase: Record<string, number> = {
          WETH: obs.fairPriceUsdcPerWeth,
          ...(obs.fairPricesUsd ?? {}),
        };

        await discovery.refresh(bn);
        const opportunities = await discovery.findOpportunities(
          fairByBase,
          amountIn,
          gapThresholdBps,
        );

        let acted = 0;
        for (const opp of opportunities) {
          if (acted >= MAX_NEW_ACTIONS_PER_BLOCK) break;
          const key = opp.pool.address.toLowerCase();
          const st = state.get(key) ?? "new";
          if (st === "traded" || st === "avoided") continue;

          const signals = {
            gapBps: opp.gapBps,
            fair: opp.fair,
            implied: opp.impliedPrice,
          };

          if (!opts.verify) {
            // naive: immediate approve+swap (trust with minOut=0). If rigged, it gets skimmed.
            ctx.log({
              round: Number(bn),
              reason: `opportunity_detected pool=${opp.pool.address} gapBps=${opp.gapBps.toFixed(0)}`,
              signals,
              state: { kind: "opportunity_detected", pool: opp.pool.address },
            });
            emit(
              buildSwapBundle(
                opp.pool.address,
                opp.usdcAddr,
                amountIn,
                0n,
                self,
                fee,
              ),
              { round: Number(bn), signals },
            );
            state.set(key, "traded");
            acted++;
            continue;
          }

          // careful: verification gate. approve -> dry-run audit next block -> swap if safe / avoid if dangerous.
          if (st === "new") {
            ctx.log({
              round: Number(bn),
              reason: `opportunity_detected pool=${opp.pool.address} gapBps=${opp.gapBps.toFixed(0)}`,
              signals,
              state: { kind: "opportunity_detected", pool: opp.pool.address },
            });
            emit(
              {
                type: "rawTx",
                tx: {
                  to: opp.usdcAddr,
                  data: encodeFunctionData({
                    abi: erc20ApproveAbi,
                    functionName: "approve",
                    args: [opp.pool.address, maxUint256],
                  }),
                },
                reason: "approve-before-verify",
                maxPriorityFeePerGasWei: fee,
              },
              { round: Number(bn), signals },
            );
            state.set(key, "approving");
            acted++;
            continue;
          }

          // st === "approving": assume the allowance has landed. Run the dry-run audit.
          const verdict = await verifyContract({
            publicClient,
            pool: opp.pool.address,
            tokenIn: opp.usdcAddr,
            amountIn,
            trader: self,
            runDir,
            llmMode,
          });
          if (verdict.status === "unknown") {
            // e.g. approval not yet landed. Retry next block (state stays approving). But once the retry
            // cap is exceeded, fall to the safe side and avoid (prevents forever-stuck on a broken/booby-trapped dry-run).
            const n = (verifyRetries.get(key) ?? 0) + 1;
            verifyRetries.set(key, n);
            if (n > MAX_VERIFY_RETRIES) {
              ctx.log({
                round: Number(bn),
                reason: `vulnerability_avoided pool=${opp.pool.address}: verify inconclusive after ${n} tries`,
                signals,
                state: {
                  kind: "vulnerability_avoided",
                  pool: opp.pool.address,
                  checks: verdict.checks,
                },
              });
              state.set(key, "avoided");
            }
            continue; // no tx emitted, so the budget (acted) is not consumed
          }
          if (verdict.status === "unsafe") {
            ctx.log({
              round: Number(bn),
              reason: `vulnerability_avoided pool=${opp.pool.address}: ${verdict.reason}`,
              signals,
              state: {
                kind: "vulnerability_avoided",
                pool: opp.pool.address,
                checks: verdict.checks,
              },
            });
            state.set(key, "avoided");
            continue; // no tx emitted, so the budget (acted) is not consumed
          }
          // safe: execute with a protective minOut aligned to the honest quote (profit from a safe new pool).
          const quoted = BigInt(verdict.checks.quotedOut ?? "0");
          const minOut = (quoted * 99n) / 100n;
          ctx.log({
            round: Number(bn),
            reason: `safe_pool_captured pool=${opp.pool.address} verified`,
            signals,
            state: {
              kind: "safe_pool_captured",
              pool: opp.pool.address,
              checks: verdict.checks,
            },
          });
          emit(
            {
              type: "rawTx",
              tx: {
                to: opp.pool.address,
                data: encodeFunctionData({
                  abi: vulnAmmAbi,
                  functionName: "swap",
                  args: [amountIn, minOut, opp.usdcAddr, self],
                }),
              },
              reason: "verified-safe-swap",
              maxPriorityFeePerGasWei: fee,
            },
            { round: Number(bn), signals },
          );
          state.set(key, "traded");
          acted++;
        }
      } catch (error) {
        ctx.log({
          round: obs.round,
          reason: `discovery error: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        busy = false;
      }
    })();
  });
}

// Extract action.reason (same semantics as the old createEmitter's reasonOf; goes in the log's reason field).
function reasonOf(action: unknown): string | undefined {
  return action && typeof action === "object" && "reason" in action
    ? String((action as { reason?: unknown }).reason ?? "")
    : undefined;
}

// approve(USDC->pool) + swap(USDC->base) in one bundle. approve is nonce n and swap is n+1, so they
// land in the same block and the swap executes after the allowance is set.
function buildSwapBundle(
  pool: Address,
  usdc: Address,
  amountIn: bigint,
  minOut: bigint,
  to: Address,
  fee: unknown,
): Record<string, unknown> {
  return {
    type: "rawBundle",
    txs: [
      {
        to: usdc,
        data: encodeFunctionData({
          abi: erc20ApproveAbi,
          functionName: "approve",
          args: [pool, amountIn],
        }),
      },
      {
        to: pool,
        data: encodeFunctionData({
          abi: vulnAmmAbi,
          functionName: "swap",
          args: [amountIn, minOut, usdc, to],
        }),
      },
    ],
    reason: "discovery-arb swap",
    maxPriorityFeePerGasWei: fee,
  };
}
