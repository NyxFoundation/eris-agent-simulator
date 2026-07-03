// discovery-arb / discovery-arb-verify の共通コア（ADR 0014 §6）。
// 発見レイヤ（PoolDiscovery）は共通で、**検証ゲートの有無だけ**が違う（discrimination が「検証」に
// 帰着する）。naive は美味しい見積りに即飛びつき rigged で被弾する。careful は取引前に
// verifyContract（dry-run + codehash + 任意 LLM）で監査し、rigged を弾き安全な新規プールで利益化する。
//
// 直読み run(ctx) agent（liquidator と同型。ADR 0015 §3）: ctx.publicClient でチェーンを読み、
// factory ログから新規プールを発見して、action は ctx.submit で送る（署名・nonce・自己申告ログは
// runtime が担う）。新規プールは adapter registry に無いため rawBundle/rawTx で叩く。
import { encodeFunctionData, maxUint256 } from "viem";
import type { Address } from "viem";
import type { AgentContext } from "@eris/sdk";
import { baseTokens, tokenInfo } from "@eris/sdk/markets.js";
import { PoolDiscovery, type BaseInfo } from "./poolDiscovery.js";
import { verifyContract } from "./verifyContract.js";
import { erc20ApproveAbi, vulnAmmAbi } from "./vulnAbi.js";

type PoolState = "new" | "approving" | "traded" | "avoided";

// 1 ブロックで新規に送出する tx 数の上限（USDC 枯渇 / nonce 輻輳を避ける。残りは次ブロック以降）。
// tx を出さない判定（avoided）はこの予算を消費しない。
const MAX_NEW_ACTIONS_PER_BLOCK = 2;
// careful: approve 後に dry-run が revert し続ける（approval 未着でなく壊れた/罠 dry-run）相手で
// "approving" のまま無限に滞留するのを避ける retry 上限。超えたら安全側に倒して avoid する。
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
  // NaN だと poolDiscovery の `gapBps < threshold` が常に false になり全プールが「機会」化する
  // （fail-open）。不正値は既定 100bps にフォールバックする。
  const gapThresholdBps = Number.isFinite(gapEnv) ? gapEnv : 100;

  // 行動ログ + action 送信を旧 emit と同じ意味論で束ねる（createEmitter 相当）:
  // ログに action と reason を残しつつ ctx.submit で mempool へ流す。
  const emit = (
    action: Record<string, unknown>,
    meta: { round: number; signals: Record<string, number | undefined> },
  ): void => {
    ctx.log({ action, reason: reasonOf(action), ...meta });
    ctx.submit(action);
  };

  // vuln pool が無い run（factory 未配布）では発見対象なし → idle（runtime の block 購読が
  // プロセスを生かし続ける）。旧 stdin/stdout の毎行 noop 応答は run(ctx) では不要。
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
    if (busy) return; // 前ブロックの発見/検証が未完なら取りこぼしを避けて 1 回に絞る
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
            // naive: 即 approve+swap（minOut=0 で trust）。rigged なら skim で被弾する。
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

          // careful: 検証ゲート。approve → 次ブロックで dry-run 監査 → 安全なら swap / 危険なら回避。
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

          // st === "approving": allowance 着弾後の想定。dry-run 監査する。
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
            // approval 未着など。次ブロックで再試行（state は approving のまま）。ただし retry 上限を
            // 超えたら安全側に倒して avoid する（壊れた/罠 dry-run で永久滞留するのを防ぐ）。
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
            continue; // tx を出さないので予算(acted)は消費しない
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
            continue; // tx を出さないので予算(acted)は消費しない
          }
          // safe: honest 見積りに沿った保護的 minOut で約定（安全な新規プールで利益化）。
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

// action.reason を取り出す（旧 createEmitter の reasonOf と同じ意味論。ログの reason 欄に載せる）。
function reasonOf(action: unknown): string | undefined {
  return action && typeof action === "object" && "reason" in action
    ? String((action as { reason?: unknown }).reason ?? "")
    : undefined;
}

// approve(USDC→pool) + swap(USDC→base) を 1 bundle に。approve が nonce n、swap が n+1 で
// 同ブロックに載り、allowance 設定後に swap が実行される。
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
