/**
 * bot.ts: 全 agent 型の唯一のエントリポイント（ADR 0015 §2/§3/§4）。
 *
 * coordinator は agent を一律 `node --import tsx example/agents/runtime/bot.ts` で spawn し、
 * agent ディレクトリを env ERIS_AGENT_DIR で渡す。bot.ts はその中身で動き方を決める:
 *   - agent.ts が run(ctx) を export     → 自走型: ctx を渡して委譲（ループしない）
 *   - agent.ts が decide() を export     → ルール戦略: read→decide→send のループで駆動
 *   - prompt.md のみ                     → プロンプト型: 毎判断 LLM に action を出させる
 *
 * 環境変数（環境が渡す。ADR 0006 の契約は不変）:
 *   ERIS_AGENT_ID / ERIS_AGENT_DIR / ERIS_AGENT_PRIVATE_KEY / ERIS_RPC_URL /
 *   ERIS_PRICE_FEED_ADDRESS / ERIS_RUN_ID / ERIS_RUN_DIR / ERIS_CONFIG
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Address, Hex } from "viem";
import type { AgentContext, AgentModule } from "@eris/sdk/agent.js";
import {
  actionJsonSchema,
  agentActionSchemaFor,
} from "@eris/sdk/actionSchema.js";
import { accountAddress, makeClients } from "@eris/sdk/chain.js";
import { loadConfig } from "@eris/sdk/config.js";
import { GMX_MARKETS } from "@eris/sdk/constants.js";
import { baseTokens, gmxMarketAddresses } from "@eris/sdk/markets.js";
import type { FlowWallet, SimContext } from "@eris/sdk/protocols/types.js";
import { initProtocols } from "@eris/sdk/protocols/registry.js";
import { loadYamlConfig } from "@eris/sdk/runConfig.js";
import { Rng } from "@eris/sdk/rng.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
} from "@eris/sdk/types.js";
import { createAgentLog } from "./agentLog.js";
import { callLlm, type LlmMessage } from "./llm.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  DEFAULT_PROMPT_INTERVAL_MS,
  DEFAULT_PROMPT_MODEL,
  loadPromptAgent,
  type RecentAction,
} from "./prompt.js";
import { createMempoolLog, Sender } from "./send.js";
import { Reader } from "./read.js";

const LLM_MAX_ATTEMPTS = 4; // validate 失敗時の再試行上限（エラー内容を会話に追記。ADR 0015 §4）

async function main(): Promise<void> {
  const privateKey = process.env.ERIS_AGENT_PRIVATE_KEY as Hex | undefined;
  const rpcUrl = process.env.ERIS_RPC_URL;
  const priceFeed = process.env.ERIS_PRICE_FEED_ADDRESS as Address | undefined;
  const agentDirEnv = process.env.ERIS_AGENT_DIR;
  const agentId = process.env.ERIS_AGENT_ID ?? "unknown";
  const runDir = process.env.ERIS_RUN_DIR;
  if (!privateKey || !rpcUrl || !priceFeed || !agentDirEnv) {
    process.stderr.write(
      "[bot] missing env (ERIS_AGENT_PRIVATE_KEY / ERIS_RPC_URL / ERIS_PRICE_FEED_ADDRESS / ERIS_AGENT_DIR)\n",
    );
    process.exit(1);
  }
  const agentDir = resolve(agentDirEnv);
  const runId =
    process.env.ERIS_RUN_ID ?? (runDir ? runDir.split("/").at(-1)! : "direct");

  // ADR 0013: coordinator が YAML 設定パスを ERIS_CONFIG で渡す。同じ YAML から config を
  // 再構築する（設定の単一ソース）。無ければ env から読む（スタンドアロン起動）。
  const config = process.env.ERIS_CONFIG
    ? loadYamlConfig(process.env.ERIS_CONFIG).config
    : loadConfig();
  const adapters = initProtocols(config.enabledProtocols);
  // ADR 0013: WETH 以外の base（WBTC 等）。fork 既定では空 = 完全に従来挙動。
  const extraBaseSymbols = baseTokens()
    .map((t) => t.symbol)
    .filter((s) => s !== "WETH");
  // batch=true: 毎ブロック十数本の観測読取を Multicall3 / JSON-RPC batch に自動集約する。
  const { chain, publicClient, walletClient } = makeClients(
    rpcUrl,
    config.chainId,
    { batch: true },
  );
  const address = accountAddress(privateKey);

  // adapter の readState/observe/buildTxs は ctx の clients/config しか使わない。
  // admin/keeper/flow は環境専用のため、agent 側 ctx ではダミー（自鍵）/例外にする。
  const simCtx: SimContext = {
    publicClient,
    walletClient,
    chain,
    config,
    rng: new Rng(config.seed),
    adminPk: privateKey,
    keeperPk: privateKey,
    oracle: { aaveAggregators: {} },
    gmx: { market: GMX_MARKETS.ETH_USD, markets: gmxMarketAddresses() },
    pendingGmxOrders: [],
    flowWallet(): FlowWallet {
      throw new Error("flow wallet is environment-only");
    },
    flowWalletByKey(): FlowWallet {
      throw new Error("flow wallet is environment-only");
    },
  };

  const logMempool = createMempoolLog(runDir, agentId);
  const agentLog = createAgentLog();
  const sender = new Sender({ ctx: simCtx, adapters, privateKey, logMempool });
  const reader = new Reader({
    ctx: simCtx,
    adapters,
    priceFeed,
    address,
    runId,
    extraBaseSymbols,
  });

  // ---- agent モジュールの解決（1 agent = 1 ディレクトリ。agent.ts 優先、無ければ prompt.md）----
  const agentTsPath = join(agentDir, "agent.ts");
  let mode: "run" | "decide" | "prompt";
  let agentModule: AgentModule | null = null;
  if (existsSync(agentTsPath)) {
    agentModule = (await import(
      pathToFileURL(agentTsPath).href
    )) as AgentModule;
    if (typeof agentModule.run === "function") mode = "run";
    else if (typeof agentModule.decide === "function") mode = "decide";
    else {
      process.stderr.write(
        `[bot] ${agentTsPath} は decide() か run(ctx) を export する必要があります\n`,
      );
      process.exit(1);
      return;
    }
  } else if (existsSync(join(agentDir, "prompt.md"))) {
    mode = "prompt";
  } else {
    process.stderr.write(
      `[bot] ${agentDir} に agent.ts も prompt.md もありません（ADR 0015 §2）\n`,
    );
    process.exit(1);
    return;
  }

  // ---- 最新状態（read ループが更新し、decide/submit が参照する）----
  let latestObservation: AgentObservation | null = null;
  let latestBalances: BalanceSnapshot | null = null;
  let latestStateById = new Map<ProtocolId, unknown>();
  const subscribers = new Set<(obs: AgentObservation) => void>();

  const ctx: AgentContext = {
    agentId,
    address,
    publicClient,
    walletClient,
    config,
    latestObservation: () => latestObservation,
    onObservation(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    submit(action) {
      sender.submit(action, latestObservation, latestBalances, latestStateById);
    },
    log: agentLog,
  };

  // ---- decide の駆動（ルール戦略）----
  let deciding = false;
  const invokeDecide = async (obs: AgentObservation): Promise<void> => {
    if (!agentModule?.decide || deciding) return;
    deciding = true;
    try {
      const action = await agentModule.decide(obs, ctx);
      if (action) ctx.submit(action);
    } catch (error) {
      agentLog({
        round: obs.round,
        reason: `decide error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      deciding = false;
    }
  };

  // ---- 自走の観測ループ: 新ブロックごとにチェーンから observation を再構成する ----
  const intervalMs = agentModule?.config?.intervalMs;
  const offsetMs = agentModule?.config?.offsetMs ?? 0;
  let processing = false;
  let lastBlock = 0;
  const onBlock = async (bn: number): Promise<void> => {
    if (processing || bn <= lastBlock) return;
    processing = true;
    try {
      // 観測再構成と競争シグナル（ADR 0011）は独立した読取なので並列に発行する（2 秒ブロックの hot path）。
      const [snap, competition] = await Promise.all([
        reader.snapshot(bn),
        sender.computeCompetition(bn),
      ]);
      snap.observation.competition = competition;
      latestObservation = snap.observation;
      latestBalances = snap.balances;
      latestStateById = snap.stateById;
      lastBlock = bn;
      // gas マネージャ: 観測確定後に ETH 残を点検し、低ければ補充 tx を enqueue（economicGas のみ）。
      void sender.maybeRefillGas(
        bn,
        snap.balances,
        snap.fairPrice,
        snap.stateById,
      );
      for (const cb of subscribers) {
        try {
          cb(snap.observation);
        } catch {
          // subscriber の失敗は観測ループに影響させない
        }
      }
      // intervalMs 未指定の decide 型は「新ブロックごとに 1 回」（旧 shim + readline と同じ頻度）。
      if (mode === "decide" && intervalMs === undefined)
        void invokeDecide(snap.observation);
    } catch (error) {
      process.stderr.write(
        `[bot] block ${bn} read failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      processing = false;
    }
  };

  publicClient.watchBlockNumber({
    emitOnBegin: true,
    pollingInterval: Math.max(
      100,
      Math.floor((config.blockTimeSec * 1000) / 4),
    ),
    onBlockNumber: (bn) => void onBlock(Number(bn)),
  });

  logMempool({ event: "runtime_start", mode, address, agentDir, rpcUrl });

  // ---- 型別の駆動 ----
  if (mode === "run") {
    // 自走型: ctx を渡して委譲（read/send/log は runtime のものを使わせる）。
    await agentModule!.run!(ctx);
    return;
  }

  if (mode === "decide" && intervalMs !== undefined) {
    // タイマー駆動（旧 runRealtimeAgent の間隔/位相）。最新 observation に対して decide する。
    setTimeout(() => {
      const tick = (): void => {
        if (latestObservation) void invokeDecide(latestObservation);
      };
      tick();
      setInterval(tick, intervalMs);
    }, offsetMs);
    return;
  }

  if (mode === "prompt") {
    await runPromptLoop();
  }

  // ---- プロンプト型: 毎判断 LLM（Hermes JSON mode + validate 再試行。ADR 0015 §4）----
  async function runPromptLoop(): Promise<void> {
    const promptAgent = loadPromptAgent(agentDir);
    const model =
      promptAgent.model ?? process.env.ERIS_LLM_MODEL ?? DEFAULT_PROMPT_MODEL;
    const schema = agentActionSchemaFor(config.enabledProtocols);
    const jsonSchema = actionJsonSchema(config.enabledProtocols);
    const system = buildSystemPrompt(
      promptAgent,
      config.enabledProtocols,
      jsonSchema,
    );
    const recent: RecentAction[] = [];
    const interval = promptAgent.intervalMs ?? DEFAULT_PROMPT_INTERVAL_MS;
    let cycling = false;
    let lastDecidedRound = -1;

    const cycle = async (): Promise<void> => {
      const obs = latestObservation;
      if (cycling || !obs || obs.round === lastDecidedRound) return;
      cycling = true;
      lastDecidedRound = obs.round;
      try {
        const messages: LlmMessage[] = [
          { role: "user", content: buildUserMessage(obs, recent.slice(-8)) },
        ];
        let lastError = "";
        for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
          let text: string;
          try {
            text = await callLlm({ model, system, messages, jsonSchema });
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            break; // 呼び出し自体の失敗は再試行せずこのサイクルを見送る
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(stripFences(text));
          } catch {
            lastError = "response was not valid JSON";
            messages.push({ role: "assistant", content: text });
            messages.push({
              role: "user",
              content: `Your response was not valid JSON. Respond with exactly one JSON object matching the <schema>. Error: ${lastError}`,
            });
            continue;
          }
          const check = schema.safeParse(parsed);
          if (!check.success) {
            // エラー内容（何がスキーマ違反か）を会話に追記して再試行（Hermes パターン）。
            lastError = check.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ");
            messages.push({ role: "assistant", content: text });
            messages.push({
              role: "user",
              content: `Your action failed schema validation: ${lastError}. Fix it and respond with exactly one JSON object matching the <schema>.`,
            });
            continue;
          }
          const action = parsed as Record<string, unknown>;
          agentLog({ round: obs.round, action, reason: "llm decision" });
          recent.push({ round: obs.round, action });
          if (recent.length > 16) recent.shift();
          ctx.submit(action);
          return;
        }
        // fail-closed: 上限超過はこのサイクルを見送り（noop）として記録。不正 action はチェーンに出ない。
        agentLog({
          round: obs.round,
          action: { type: "noop" },
          reason: `llm cycle skipped: ${lastError}`,
        });
        recent.push({
          round: obs.round,
          action: { type: "noop" },
          note: `skipped (${lastError.slice(0, 120)})`,
        });
        if (recent.length > 16) recent.shift();
      } finally {
        cycling = false;
      }
    };
    setInterval(() => void cycle(), interval);
  }
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\n([\s\S]*?)\n```$/);
  return m ? m[1] : t;
}

main().catch((error) => {
  process.stderr.write(
    `[bot] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
