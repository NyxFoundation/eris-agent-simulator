/**
 * send.ts: 署名・送信・nonce 管理・mempool 自己申告（ADR 0015 runtime。旧 directShim の送信側）。
 *
 * - action を parse/validate → adapter.buildTxs → 自分の秘密鍵で署名し直接送信（nonce 自己管理）
 * - mempool 活動（submitted / submit_failed / rejected）を runs/<id>/agents/<id>.jsonl に
 *   自己申告で記録する（ADR 0006 §5。coordinator が submitted を数えられない穴を塞ぐ）
 * - 競争シグナル（ADR 0011）: 自分の直近 tx の着順/成否と、直近ブロックの競合最高入札を自己導出
 * - gas マネージャ（ADR 0011 §4。economicGas のみ）: ETH 残が閾値を割ったら WETH unwrap /
 *   USDC→WETH swap で自動補充する
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wethAbi } from "@eris/sdk/abis.js";
import { parseAction, validateAction } from "@eris/sdk/action.js";
import { TOKENS } from "@eris/sdk/constants.js";
import { createJsonlAppender } from "./agentLog.js";
import type { ProtocolAdapter, SimContext } from "@eris/sdk/protocols/types.js";
import type {
  AgentAction,
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
} from "@eris/sdk/types.js";

export type MempoolLog = (entry: Record<string, unknown>) => void;

// mempool 活動の自己申告ログ（runs/<id>/agents/<id>.jsonl。行動ログと同じファイルへ追記）。
export function createMempoolLog(
  runDir: string | undefined,
  agentId: string,
): MempoolLog {
  const append = createJsonlAppender(runDir, agentId);
  return (entry) => append({ kind: "mempool", ...entry });
}

type OwnTx = {
  hash: Hex;
  actionType?: string;
  status?: "success" | "reverted";
  txIndex?: number;
};

// 維持する ETH 余力（tx 本数換算）。較正で endowment と併せて調整する（ERIS_GAS_REFILL_TX_HEADROOM）。
const GAS_REFILL_TX_HEADROOM = BigInt(
  process.env.ERIS_GAS_REFILL_TX_HEADROOM ?? "24",
);
const GAS_LIMIT_ESTIMATE = 1_500_000n; // 1 tx の gas 上限見積り
const GAS_REFILL_COOLDOWN_BLOCKS = 3; // 補充 tx が mine され残高へ反映されるまでの待ち

export class Sender {
  private readonly ctx: SimContext;
  private readonly adapters: ProtocolAdapter[];
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly address: Address;
  private readonly logMempool: MempoolLog;

  // ---- nonce 自己管理 + 送信の直列化 ----
  private nextNonce: number | null = null;
  private sendQueue: Promise<void> = Promise.resolve();

  // ---- 競争シグナル（ADR 0011）: 直近の自分の tx（ring buffer）----
  private readonly ownTxs: OwnTx[] = [];

  private lastGasRefillBlock = -GAS_REFILL_COOLDOWN_BLOCKS;

  constructor(opts: {
    ctx: SimContext;
    adapters: ProtocolAdapter[];
    privateKey: Hex;
    logMempool: MempoolLog;
  }) {
    this.ctx = opts.ctx;
    this.adapters = opts.adapters;
    this.account = privateKeyToAccount(opts.privateKey);
    this.address = this.account.address;
    this.logMempool = opts.logMempool;
  }

  private async allocNonce(): Promise<number> {
    if (this.nextNonce === null) {
      this.nextNonce = await this.ctx.publicClient.getTransactionCount({
        address: this.address,
        blockTag: "pending",
      });
    }
    return this.nextNonce++;
  }

  private enqueueSend(task: () => Promise<void>): void {
    this.sendQueue = this.sendQueue.then(task, task);
  }

  private pushOwnTx(hash: Hex, actionType?: string): void {
    this.ownTxs.push({ hash, actionType });
    if (this.ownTxs.length > 24) this.ownTxs.shift();
  }

  private async sendBuiltTx(
    tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint },
    priorityFeeWei: bigint,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const { publicClient, walletClient, chain } = this.ctx;
    try {
      const block = await publicClient.getBlock();
      const baseFee = block.baseFeePerGas ?? 0n;
      const nonce = await this.allocNonce();
      let gas = tx.gas;
      if (gas === undefined) {
        try {
          const estimated = await publicClient.estimateGas({
            account: this.address,
            to: tx.to,
            data: tx.data,
            value: tx.value ?? 0n,
            maxFeePerGas: baseFee * 2n + priorityFeeWei,
            maxPriorityFeePerGas: priorityFeeWei,
          });
          const bufferBps = BigInt(
            process.env.ERIS_DIRECT_GAS_BUFFER_BPS ?? "13000",
          );
          const buffered = (estimated * bufferBps + 9_999n) / 10_000n;
          gas = buffered > estimated + 50_000n ? buffered : estimated + 50_000n;
        } catch {
          // Let viem/anvil surface the original simulation failure below.
        }
      }
      const hash = await walletClient.sendTransaction({
        account: this.account,
        chain,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gas,
        nonce,
        // baseFee 揺らぎ耐性のため headroom を持たせる（実効 tip は maxPriorityFeePerGas のまま）
        maxFeePerGas: baseFee * 2n + priorityFeeWei,
        maxPriorityFeePerGas: priorityFeeWei,
      });
      this.pushOwnTx(hash, meta.actionType as string | undefined);
      this.logMempool({
        event: "submitted",
        hash,
        nonce,
        priorityFeeWei: priorityFeeWei.toString(),
        ...meta,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nonce/i.test(message)) this.nextNonce = null; // 次回 pending から再同期
      this.logMempool({ event: "submit_failed", error: message, ...meta });
    }
  }

  // action を検証して mempool へ送る（旧 relay handleAgentAction と同じ検証 → 直接送信）。
  submit(
    raw: AgentAction | Record<string, unknown>,
    observation: AgentObservation | null,
    balances: BalanceSnapshot | null,
    stateById: Map<ProtocolId, unknown>,
  ): void {
    let action: AgentAction;
    try {
      action = parseAction(raw);
    } catch (error) {
      this.logMempool({
        event: "bad_action",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (action.type === "noop") return;
    if (!observation || !balances) {
      this.logMempool({
        event: "rejected",
        reason: "no observation yet",
        action,
      });
      return;
    }
    const validated = validateAction(action, observation, balances);
    if (!validated.ok) {
      this.logMempool({ event: "rejected", reason: validated.reason, action });
      return;
    }
    const blockSeen = observation.round;
    for (const intent of validated.intents) {
      const adapter = this.adapters.find((a) => a.id === intent.protocol);
      if (!adapter) continue;
      this.enqueueSend(async () => {
        let txs;
        try {
          txs = await adapter.buildTxs(
            this.ctx,
            this.address,
            intent.action,
            stateById.get(intent.protocol),
          );
        } catch (error) {
          this.logMempool({
            event: "submit_failed",
            actionType: intent.action.type,
            protocol: intent.protocol,
            blockSeen,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        for (const tx of txs) {
          await this.sendBuiltTx(tx, intent.priorityFeeWei, {
            actionType: intent.action.type,
            protocol: intent.protocol,
            // ADR 0013: WBTC 等の market を取引したことをログに残す（WETH は undefined で省略）。
            base: (intent.action as { base?: string }).base,
            bundleId: intent.bundleId,
            bundleIndex: intent.bundleIndex,
            blockSeen,
          });
        }
      });
    }
    for (const rawIntent of validated.rawIntents) {
      this.enqueueSend(() =>
        this.sendBuiltTx(
          {
            to: rawIntent.tx.to as Address,
            data: rawIntent.tx.data as Hex,
            value: rawIntent.tx.value ? BigInt(rawIntent.tx.value) : undefined,
          },
          rawIntent.priorityFeeWei,
          { actionType: "rawTx", blockSeen },
        ),
      );
    }
  }

  // ---- gas マネージャ（ADR 0011 §4。economicGas プロファイルのみ）----
  // endowment を絞ると naive 戦略がサイレント gas 切れする。ETH 残が「最低 N tx 分」を割ったら
  // WETH→ETH unwrap（スリッページ 0）で自動補充し、WETH も尽きたら USDC→WETH swap（uniswap。
  // スリッページ = 現実の treasury 管理コスト）で繋ぐ。得た WETH は次ブロックの unwrap で ETH 化する。
  async maybeRefillGas(
    bn: number,
    balances: BalanceSnapshot,
    fairPrice: number,
    stateById: Map<ProtocolId, unknown>,
  ): Promise<void> {
    const config = this.ctx.config;
    if (!config.economicGas) return;
    if (bn - this.lastGasRefillBlock < GAS_REFILL_COOLDOWN_BLOCKS) return;
    let baseFee: bigint;
    try {
      baseFee = (await this.ctx.publicClient.getBlock()).baseFeePerGas ?? 0n;
    } catch {
      return;
    }
    const tip = config.defaultPriorityFeeWei;
    const perTxCost = GAS_LIMIT_ESTIMATE * (baseFee * 2n + tip);
    const target = perTxCost * GAS_REFILL_TX_HEADROOM;
    if (balances.ethWei >= target) return;
    const deficit = target - balances.ethWei;

    if (balances.wethWei > 0n) {
      // WETH→ETH unwrap（1:1、スリッページ 0）。不足分まで（在庫上限で頭打ち）。
      const amount = deficit < balances.wethWei ? deficit : balances.wethWei;
      this.lastGasRefillBlock = bn;
      this.enqueueSend(() =>
        this.sendBuiltTx(
          {
            to: TOKENS.WETH.address,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: "withdraw",
              args: [amount],
            }),
          },
          tip,
          { actionType: "gasRefillUnwrap", amountWei: amount.toString() },
        ),
      );
      return;
    }

    if (balances.usdcUnits > 0n && fairPrice > 0) {
      // USDC→WETH swap（uniswap）。得た WETH は次回 unwrap で ETH 化する。
      const adapter = this.adapters.find((a) => a.id === "uniswap");
      if (!adapter) return;
      // deficit(ETH wei) 相当の USDC を概算 + slippage バッファ 1.3x（USDC は 6 桁）。
      const deficitWeth = Number(deficit) / 1e18;
      const usdcNeeded = BigInt(Math.ceil(deficitWeth * fairPrice * 1.3 * 1e6));
      const amountIn =
        usdcNeeded < balances.usdcUnits ? usdcNeeded : balances.usdcUnits;
      if (amountIn <= 0n) return;
      this.lastGasRefillBlock = bn;
      this.enqueueSend(async () => {
        let txs;
        try {
          txs = await adapter.buildTxs(
            this.ctx,
            this.address,
            { type: "swap", tokenIn: "USDC", amountIn: amountIn.toString() },
            stateById.get("uniswap"),
          );
        } catch (error) {
          this.logMempool({
            event: "submit_failed",
            actionType: "gasRefillSwap",
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        for (const tx of txs) {
          await this.sendBuiltTx(tx, tip, { actionType: "gasRefillSwap" });
        }
      });
    }
  }

  // ---- 競争シグナルを直近ブロックから導出（ADR 0011）----
  // env 特権でなく agent が公開チェーンから自己導出する（現実の MEV searcher が直近ブロックを
  // 見るのと同じ）。
  async computeCompetition(
    bn: number,
  ): Promise<NonNullable<AgentObservation["competition"]>> {
    const { publicClient } = this.ctx;
    // 1. 自分の直近 tx の receipt を解決（txIndex + status）。未 mine はスキップ。
    await Promise.all(
      this.ownTxs
        .filter((t) => t.status === undefined)
        .map(async (t) => {
          try {
            const r = await publicClient.getTransactionReceipt({
              hash: t.hash,
            });
            t.status = r.status === "success" ? "success" : "reverted";
            t.txIndex = r.transactionIndex;
          } catch {
            // まだ mine されていない
          }
        }),
    );
    // 取引 tx のみで revert 率・着順を測る（gas 補充の unwrap/swap は競争分析から除外）。
    const resolved = this.ownTxs.filter(
      (t) =>
        t.status !== undefined &&
        !String(t.actionType ?? "").startsWith("gasRefill"),
    );
    const recentSampleSize = resolved.length;
    const reverts = resolved.filter((t) => t.status === "reverted").length;
    const recentRevertRate = recentSampleSize ? reverts / recentSampleSize : 0;
    const lastWithIdx = [...resolved]
      .reverse()
      .find((t) => t.txIndex !== undefined);
    const lastTxIndex = lastWithIdx?.txIndex ?? null;
    // 2. 直近ブロックの競合最高入札（自分以外の最高 maxPriorityFeePerGas）。
    let maxComp = 0n;
    let maxAll = 0n;
    try {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(bn),
        includeTransactions: true,
      });
      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;
        const fee = tx.maxPriorityFeePerGas ?? 0n;
        if (fee > maxAll) maxAll = fee;
        if (
          tx.from.toLowerCase() !== this.address.toLowerCase() &&
          fee > maxComp
        )
          maxComp = fee;
      }
    } catch {
      // block 取得失敗は signal 無しで継続
    }
    return {
      maxCompetitorPriorityFeeWei: maxComp.toString(),
      maxBlockPriorityFeeWei: maxAll.toString(),
      lastTxIndex,
      recentRevertRate,
      recentSampleSize,
    };
  }
}
