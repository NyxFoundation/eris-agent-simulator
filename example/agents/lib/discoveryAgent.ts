// discovery-arb / discovery-arb-verify の共通コア（ADR 0014 §6）。
// 発見レイヤ（PoolDiscovery）は共通で、**検証ゲートの有無だけ**が違う（discrimination が「検証」に
// 帰着する）。naive は美味しい見積りに即飛びつき rigged で被弾する。careful は取引前に
// verifyContract（dry-run + codehash + 任意 LLM）で監査し、rigged を弾き安全な新規プールで利益化する。
//
// 直読み agent（liquidator/raw-swap と同型）: 自前 publicClient でチェーンを読み、action は stdout に
// 書いて directShim に署名送信させる。新規プールは adapter registry に無いため rawBundle/rawTx で叩く。
import { createInterface } from "node:readline";
import { createPublicClient, encodeFunctionData, http, maxUint256 } from "viem";
import { mainnet } from "viem/chains";
import type { Address } from "viem";
import { baseTokens, tokenInfo } from "@eris/sdk/markets.js";
import { createAgentLog, createEmitter } from "./agentLog.js";
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

export async function runDiscoveryAgent(opts: {
  verify: boolean;
}): Promise<void> {
  const rpcUrl = process.env.ERIS_RPC_URL ?? "";
  const self = (process.env.ERIS_AGENT_ADDRESS ?? "") as Address;
  const factory = process.env.ERIS_VULN_FACTORY as Address | undefined;
  const runDir = process.env.ERIS_RUN_DIR;
  const llmMode = process.env.ERIS_VULN_LLM ?? "0";
  const gapEnv = Number(process.env.ERIS_DISCOVERY_GAP_BPS ?? "100");
  // NaN だと poolDiscovery の `gapBps < threshold` が常に false になり全プールが「機会」化する
  // （fail-open）。不正値は既定 100bps にフォールバックする。
  const gapThresholdBps = Number.isFinite(gapEnv) ? gapEnv : 100;
  if (!rpcUrl || !self) {
    process.stderr.write("ERIS_RPC_URL and ERIS_AGENT_ADDRESS are required\n");
    process.exit(1);
  }

  const emit = createEmitter();
  const log = createAgentLog();
  const rl = createInterface({ input: process.stdin });

  // vuln pool が無い run（factory 未配布）では発見対象なし → 毎ブロック noop で待機。
  if (!factory) {
    rl.on("line", () => {
      process.stdout.write(
        `${JSON.stringify({ type: "noop", reason: "no vuln factory" })}\n`,
      );
    });
    return;
  }

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
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

  rl.on("line", async (line) => {
    if (busy) return; // 前ブロックの発見/検証が未完なら取りこぼしを避けて 1 回に絞る
    busy = true;
    try {
      const obs = JSON.parse(line);
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
          log({
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
          log({
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
            log({
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
          log({
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
        log({
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

      if (acted === 0) {
        process.stdout.write(
          `${JSON.stringify({ type: "noop", reason: "no fresh opportunity" })}\n`,
        );
      }
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ type: "noop", reason: `error: ${error}` })}\n`,
      );
    } finally {
      busy = false;
    }
  });
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
): unknown {
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
