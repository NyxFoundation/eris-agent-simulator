/**
 * send.ts: signing, sending, nonce management, and mempool self-reporting (ADR 0015 runtime; the send side of the old directShim).
 *
 * - parse/validate the action -> adapter.buildTxs -> sign with your own private key and send directly (self-managed nonce)
 * - self-report mempool activity (submitted / submit_failed / rejected) to runs/<id>/agents/<id>.jsonl
 *   (ADR 0006 §5; closes the gap where the coordinator can't count submitted)
 * - competition signal (ADR 0011): self-derive your recent tx's ordering/outcome and the highest competitor bid in the latest block
 * - gas manager (ADR 0011 §4; economicGas only): when the ETH balance drops below the threshold, auto-refill via WETH unwrap /
 *   USDC->WETH swap
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

// Self-report log of mempool activity (runs/<id>/agents/<id>.jsonl; appended to the same file as the action log).
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

// ETH headroom to maintain (in tx count). Tune alongside the endowment during calibration (ERIS_GAS_REFILL_TX_HEADROOM).
const GAS_REFILL_TX_HEADROOM = BigInt(
  process.env.ERIS_GAS_REFILL_TX_HEADROOM ?? "24",
);
const GAS_LIMIT_ESTIMATE = 1_500_000n; // gas cap estimate for one tx
const GAS_REFILL_COOLDOWN_BLOCKS = 3; // wait for the refill tx to be mined and reflected in the balance

export class Sender {
  private readonly ctx: SimContext;
  private readonly adapters: ProtocolAdapter[];
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  readonly address: Address;
  private readonly logMempool: MempoolLog;

  // ---- self-managed nonce + serialized sending ----
  private nextNonce: number | null = null;
  private sendQueue: Promise<void> = Promise.resolve();

  // ---- competition signal (ADR 0011): your recent txs (ring buffer) ----
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
        // give headroom to tolerate baseFee fluctuation (the effective tip stays maxPriorityFeePerGas)
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
      if (/nonce/i.test(message)) this.nextNonce = null; // resync from pending next time
      this.logMempool({ event: "submit_failed", error: message, ...meta });
    }
  }

  // Validate the action and send it to the mempool (same validation as the old relay handleAgentAction -> direct send).
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
            // ADR 0013: record in the log which market (e.g. WBTC) was traded (WETH is undefined and omitted).
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

  // ---- gas manager (ADR 0011 §4; economicGas profile only) ----
  // A tight endowment makes naive strategies silently run out of gas. When the ETH balance drops below
  // "at least N txs' worth", auto-refill via WETH->ETH unwrap (zero slippage), and when WETH is also
  // exhausted, bridge with a USDC->WETH swap (uniswap; slippage = the real-world treasury management
  // cost). The WETH obtained is converted to ETH by next block's unwrap.
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
      // WETH->ETH unwrap (1:1, zero slippage). Up to the deficit (capped by the inventory).
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
      // USDC->WETH swap (uniswap). The WETH obtained is converted to ETH by the next unwrap.
      const adapter = this.adapters.find((a) => a.id === "uniswap");
      if (!adapter) return;
      // approximate the USDC equivalent to the deficit (ETH wei) + a 1.3x slippage buffer (USDC has 6 decimals).
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

  // ---- derive the competition signal from the latest block (ADR 0011) ----
  // Not an env privilege; the agent self-derives it from the public chain (the same way a real MEV
  // searcher looks at the latest block).
  async computeCompetition(
    bn: number,
  ): Promise<NonNullable<AgentObservation["competition"]>> {
    const { publicClient } = this.ctx;
    // 1. Resolve the receipts of your recent txs (txIndex + status). Skip unmined ones.
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
            // not yet mined
          }
        }),
    );
    // Measure revert rate / ordering using trading txs only (exclude gas-refill unwrap/swap from the competition analysis).
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
    // 2. The highest competitor bid in the latest block (the highest maxPriorityFeePerGas other than your own).
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
      // if fetching the block fails, continue without the signal
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
