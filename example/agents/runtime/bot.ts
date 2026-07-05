/**
 * bot.ts: the single entry point for every agent type (ADR 0015 §2/§3/§4).
 *
 * The coordinator spawns every agent uniformly with
 * `node --import tsx example/agents/runtime/bot.ts` and passes the agent directory via
 * env ERIS_AGENT_DIR. bot.ts decides how to run from that directory's contents:
 *   - agent.ts exports run(ctx)   -> self-driven: pass ctx and delegate (no loop)
 *   - agent.ts exports decide()   -> rule strategy: drive a read->decide->send loop
 *   - prompt.md only              -> prompt type: have the LLM emit an action every decision
 *
 * An agent that ships both agent.ts and prompt.md provides both ways of running (ADR 0015 §2's
 * "agent.ts takes precedence when both are present" is the default). Switch it via the roster env:
 *   ERIS_AGENT_MODE=prompt          run via prompt.md (LLM-driven) even when agent.ts exists
 *   ERIS_PROMPT_REVISE_EVERY=<N>    in prompt mode, every N decision cycles the LLM self-revises
 *                                   the prompt body (default 0 = off; revised versions are saved to
 *                                   runs/<id>/agents/<agentId>.prompt.v<K>.md and used by later cycles)
 *   ERIS_PROMPT_REVISE_PERSIST=1    also write the revision back to the agent directory's prompt.md
 *   ERIS_PROMPT_LOG_CALLS=1         record the raw LLM conversation (system / sent messages /
 *                                   raw response / errors) to runs/<id>/agents/<agentId>.llm.jsonl
 *                                   (opt-in debug log for prompt tuning)
 *
 * Environment variables (passed by the environment; the ADR 0006 contract is unchanged):
 *   ERIS_AGENT_ID / ERIS_AGENT_DIR / ERIS_AGENT_PRIVATE_KEY / ERIS_RPC_URL /
 *   ERIS_PRICE_FEED_ADDRESS / ERIS_RUN_ID / ERIS_RUN_DIR / ERIS_CONFIG
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { createAgentLog, createJsonlAppender } from "./agentLog.js";
import { callLlm, type LlmMessage } from "./llm.js";
import {
  buildRevisionSystem,
  buildRevisionUser,
  buildSystemPrompt,
  buildUserMessage,
  DEFAULT_PROMPT_INTERVAL_MS,
  DEFAULT_PROMPT_MODEL,
  DEFAULT_PROMPT_REVISE_EVERY,
  loadPromptAgent,
  type RecentAction,
} from "./prompt.js";
import { createMempoolLog, Sender } from "./send.js";
import { Reader } from "./read.js";

const LLM_MAX_ATTEMPTS = 4; // retry cap on validation failure (append the error to the conversation; ADR 0015 §4)

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

  // ADR 0013: the coordinator passes the YAML config path via ERIS_CONFIG. Rebuild config from
  // the same YAML (single source of config). If absent, read from env (standalone launch).
  const config = process.env.ERIS_CONFIG
    ? loadYamlConfig(process.env.ERIS_CONFIG).config
    : loadConfig();
  const adapters = initProtocols(config.enabledProtocols);
  // ADR 0013: bases other than WETH (WBTC etc.). Empty under the fork default = fully legacy behavior.
  const extraBaseSymbols = baseTokens()
    .map((t) => t.symbol)
    .filter((s) => s !== "WETH");
  // batch=true: automatically aggregates the dozen-odd observation reads per block into Multicall3 / JSON-RPC batches.
  const { chain, publicClient, walletClient } = makeClients(
    rpcUrl,
    config.chainId,
    { batch: true },
  );
  const address = accountAddress(privateKey);

  // The adapter's readState/observe/buildTxs only use ctx's clients/config.
  // admin/keeper/flow are environment-only, so on the agent side ctx they are dummies (own key) / throw.
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

  // ---- resolve the agent module (1 agent = 1 directory) ----
  // Default is agent.ts precedence (ADR 0015 §2). A co-located agent can be switched to
  // LLM-driven (prompt.md) via ERIS_AGENT_MODE=prompt (both ways of running are always provided).
  const agentTsPath = join(agentDir, "agent.ts");
  const hasAgentTs = existsSync(agentTsPath);
  const hasPrompt = existsSync(join(agentDir, "prompt.md"));
  const forcedMode = process.env.ERIS_AGENT_MODE;
  if (
    forcedMode !== undefined &&
    forcedMode !== "agent" &&
    forcedMode !== "prompt"
  ) {
    process.stderr.write(
      `[bot] ERIS_AGENT_MODE must be "agent" or "prompt" (got: ${forcedMode})\n`,
    );
    process.exit(1);
    return;
  }
  let mode: "run" | "decide" | "prompt";
  let agentModule: AgentModule | null = null;
  if (forcedMode === "prompt" ? false : hasAgentTs) {
    agentModule = (await import(
      pathToFileURL(agentTsPath).href
    )) as AgentModule;
    if (typeof agentModule.run === "function") mode = "run";
    else if (typeof agentModule.decide === "function") mode = "decide";
    else {
      process.stderr.write(
        `[bot] ${agentTsPath} must export decide() or run(ctx)\n`,
      );
      process.exit(1);
      return;
    }
  } else if (hasPrompt) {
    mode = "prompt";
  } else {
    process.stderr.write(
      forcedMode === "prompt"
        ? `[bot] ERIS_AGENT_MODE=prompt but ${agentDir} has no prompt.md\n`
        : `[bot] ${agentDir} has neither agent.ts nor prompt.md (ADR 0015 §2)\n`,
    );
    process.exit(1);
    return;
  }
  if (forcedMode === "agent" && !hasAgentTs) {
    process.stderr.write(
      `[bot] ERIS_AGENT_MODE=agent but ${agentDir} has no agent.ts\n`,
    );
    process.exit(1);
    return;
  }

  // ---- latest state (updated by the read loop, referenced by decide/submit) ----
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

  // ---- driving decide (rule strategy) ----
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

  // ---- self-driven observation loop: reconstruct the observation from the chain each new block ----
  const intervalMs = agentModule?.config?.intervalMs;
  const offsetMs = agentModule?.config?.offsetMs ?? 0;
  let processing = false;
  let lastBlock = 0;
  const onBlock = async (bn: number): Promise<void> => {
    if (processing || bn <= lastBlock) return;
    processing = true;
    try {
      // Observation reconstruction and the competition signal (ADR 0011) are independent reads, so issue them in parallel (2-second block hot path).
      const [snap, competition] = await Promise.all([
        reader.snapshot(bn),
        sender.computeCompetition(bn),
      ]);
      snap.observation.competition = competition;
      latestObservation = snap.observation;
      latestBalances = snap.balances;
      latestStateById = snap.stateById;
      lastBlock = bn;
      // gas manager: after the observation is settled, check the ETH balance and if low enqueue a refill tx (economicGas only).
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
          // a subscriber failure must not affect the observation loop
        }
      }
      // A decide type without intervalMs runs "once per new block" (same cadence as the old shim + readline).
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

  // ---- drive per type ----
  if (mode === "run") {
    // Self-driven: pass ctx and delegate (let it use runtime's read/send/log).
    await agentModule!.run!(ctx);
    return;
  }

  if (mode === "decide" && intervalMs !== undefined) {
    // Timer-driven (the old runRealtimeAgent's interval/phase). Decide against the latest observation.
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

  // ---- prompt type: LLM every decision (Hermes JSON mode + validation retry; ADR 0015 §4) ----
  // When ERIS_PROMPT_REVISE_EVERY > 0, every N decision cycles the LLM self-revises the prompt body
  // (self-improvement; revised versions are saved to runs/<id>/agents/<agentId>.prompt.v<K>.md and
  //  used by later cycles. ERIS_PROMPT_REVISE_PERSIST=1 also writes back to the agent directory's prompt.md).
  async function runPromptLoop(): Promise<void> {
    const promptAgent = loadPromptAgent(agentDir);
    const model =
      promptAgent.model ?? process.env.ERIS_LLM_MODEL ?? DEFAULT_PROMPT_MODEL;
    const schema = agentActionSchemaFor(config.enabledProtocols);
    const jsonSchema = actionJsonSchema(config.enabledProtocols);
    let body = promptAgent.body;
    const rebuildSystem = (): string =>
      buildSystemPrompt(
        { ...promptAgent, body },
        config.enabledProtocols,
        jsonSchema,
      );
    let system = rebuildSystem();
    const reviseEveryRaw = Number(
      process.env.ERIS_PROMPT_REVISE_EVERY ?? DEFAULT_PROMPT_REVISE_EVERY,
    );
    const reviseEvery =
      Number.isFinite(reviseEveryRaw) && reviseEveryRaw > 0
        ? Math.floor(reviseEveryRaw)
        : 0;
    const revisePersist = process.env.ERIS_PROMPT_REVISE_PERSIST === "1";
    const recent: RecentAction[] = [];
    const interval = promptAgent.intervalMs ?? DEFAULT_PROMPT_INTERVAL_MS;
    let cycling = false;
    let lastDecidedRound = -1;
    let decidedCycles = 0;
    let revision = 0;
    let initialValueUsdc: number | null = null;

    // ---- LLM conversation log (opt-in via ERIS_PROMPT_LOG_CALLS=1; diagnostic aid for ADR 0015 §4) ----
    // So that "what part of the observation the LLM read and what it returned" can be traced after
    // the run, record the raw conversation to runs/<id>/agents/<agentId>.llm.jsonl. The system prompt
    // is large and identical across decisions, so write its full text only on the first call and right
    // after each self-revision as kind:"llm_system", and have each per-call kind:"llm_call" reference
    // it by revision number (the validation-retry exchanges are kept inside messages).
    const llmCallLog =
      process.env.ERIS_PROMPT_LOG_CALLS === "1"
        ? createJsonlAppender(runDir, agentId, ".llm")
        : null;
    const logSystem = (): void =>
      llmCallLog?.({ kind: "llm_system", revision, system });
    const loggedCallLlm = async (
      meta: Record<string, unknown>,
      req: Parameters<typeof callLlm>[0],
    ): Promise<string> => {
      if (!llmCallLog) return callLlm(req);
      try {
        const response = await callLlm(req);
        llmCallLog({
          kind: "llm_call",
          ...meta,
          revision,
          model: req.model,
          messages: req.messages,
          response,
        });
        return response;
      } catch (error) {
        llmCallLog({
          kind: "llm_call",
          ...meta,
          revision,
          model: req.model,
          messages: req.messages,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    logSystem();

    // Prompt revision (self-improvement). Run inside the same cycling lock as the decision cycle so it never races the decision.
    const revisePrompt = async (obs: AgentObservation): Promise<void> => {
      try {
        const reviseSystem = buildRevisionSystem(promptAgent);
        const text = await loggedCallLlm(
          // The revision system prompt differs from the decision one, so include it directly in the record.
          { purpose: "revise", round: obs.round, system: reviseSystem },
          {
            model,
            system: reviseSystem,
            messages: [
              {
                role: "user",
                content: buildRevisionUser(body, recent.slice(-16), {
                  cycles: decidedCycles,
                  initialValueUsdc,
                  currentValueUsdc: obs.inventory.valueUsdc,
                  recentRevertRate: obs.competition?.recentRevertRate,
                  recentSampleSize: obs.competition?.recentSampleSize,
                }),
              },
            ],
            json: false, // revision is free text (markdown body)
          },
        );
        const next = stripFences(text).trim();
        // Discard a broken revision (empty / extreme length) and keep the current prompt (fail-closed).
        if (next.length < 40 || next.length > 20_000)
          throw new Error(`revised body rejected (length=${next.length})`);
        revision++;
        body = next;
        system = rebuildSystem();
        logSystem(); // record the full revised system prompt in the conversation log too, versioned
        agentLog({
          round: obs.round,
          reason: `prompt revised v${revision}`,
          state: {
            kind: "prompt_revision",
            revision,
            cycles: decidedCycles,
            valueUsdc: obs.inventory.valueUsdc,
          },
        });
        // Keep the revision history in the run directory, versioned (primary source for post-run diagnostics/comparison).
        if (runDir) {
          const dir = join(runDir, "agents");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${agentId}.prompt.v${revision}.md`), body);
        }
        // Optional: write back to the agent directory's prompt.md (keep the frontmatter unchanged).
        if (revisePersist) {
          const path = join(agentDir, "prompt.md");
          const raw = readFileSync(path, "utf8");
          const m = raw.match(/^(---\n[\s\S]*?\n---\n)/);
          if (m) writeFileSync(path, `${m[1]}${body}\n`);
        }
      } catch (error) {
        agentLog({
          round: obs.round,
          reason: `prompt revision failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };

    const cycle = async (): Promise<void> => {
      const obs = latestObservation;
      if (cycling || !obs || obs.round === lastDecidedRound) return;
      cycling = true;
      lastDecidedRound = obs.round;
      initialValueUsdc ??= obs.inventory.valueUsdc;
      try {
        const messages: LlmMessage[] = [
          { role: "user", content: buildUserMessage(obs, recent.slice(-8)) },
        ];
        let lastError = "";
        let decided = false;
        for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
          let text: string;
          try {
            text = await loggedCallLlm(
              { purpose: "decision", round: obs.round, attempt },
              { model, system, messages, jsonSchema },
            );
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            break; // a failure of the call itself is not retried; skip this cycle
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
            // Append the error (what violated the schema) to the conversation and retry (Hermes pattern).
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
          decided = true;
          break;
        }
        if (!decided) {
          // fail-closed: exceeding the cap records this cycle as skipped (noop). An invalid action never reaches the chain.
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
        }
        // ---- self-improvement: revise the prompt body every N decision cycles (within the same lock = serial with the decision) ----
        decidedCycles++;
        if (reviseEvery > 0 && decidedCycles % reviseEvery === 0)
          await revisePrompt(obs);
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
