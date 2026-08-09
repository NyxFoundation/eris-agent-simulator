/**
 * bot.ts: the single entry point for every agent type (ADR 0015 §2/§3/§4).
 *
 * The coordinator spawns every agent uniformly with
 * `node --import tsx example/agents/runtime/bot.ts` and passes the agent directory via
 * env ERIS_AGENT_DIR. bot.ts decides how to run from that directory's contents:
 *   - agent.ts exports run(ctx)   -> self-driven: pass ctx and delegate (no loop)
 *   - agent.ts exports decide()   -> rule strategy: drive a read->decide->send loop
 *   - agent.ts + improve.md       -> self-improving: the same loop, plus an LLM that periodically
 *                                   rewrites the strategy out of the trade path (ADR 0018)
 *
 * Prompt mode (an LLM producing an action every decision) was removed in ADR 0018: measured at
 * 8-28 blocks per decision and 1/64 the actions of the same strategy in rule mode, it could not
 * compete. The LLM now improves the strategy instead of driving it.
 *
 *   ERIS_AGENT_FROZEN=1             ignore improve.md and run the strategy unchanged. This is the
 *                                   frozen control every roster needs (ADR 0018 §5), without
 *                                   duplicating the agent directory
 *   ERIS_LLM_MODEL=<model>          backend for the revision call (improve.md frontmatter wins)
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
import { createAgentLog } from "./agentLog.js";
import { callLlm } from "./llm.js";
import {
  buildRevisionContext,
  buildRevisionSystem,
  compileExecutor,
  effectiveReviseInterval,
  loadImproveAgent,
  MAX_REVISIONS_PER_RUN,
  parseRevision,
  type RevisionOutcome,
} from "./improve.js";
import { createMempoolLog, Sender } from "./send.js";
import { Reader } from "./read.js";

// Backend for the revision call when neither improve.md nor the roster names one.
const DEFAULT_IMPROVE_MODEL = "gpt-oss:120b";

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
  // agent.ts is always the strategy (ADR 0015 §2). If improve.md sits beside it, the same strategy
  // runs at the same speed and an LLM is periodically offered the chance to rewrite it (ADR 0018).
  // The retired prompt mode put the LLM in the trade path instead, which cost 8-28 blocks per
  // decision -- 1/64 the actions of the same strategy in rule mode (ADR 0017 §5 B1).
  // A roster still asking for prompt mode would otherwise run as a plain rule agent and look fine,
  // which is the worst outcome: the participant thinks an LLM is involved and nothing says otherwise.
  const retired = [
    "ERIS_AGENT_MODE",
    "ERIS_PROMPT_REVISE_EVERY",
    "ERIS_PROMPT_REVISE_PERSIST",
    "ERIS_PROMPT_LOG_CALLS",
  ].filter((k) => process.env[k] !== undefined);
  if (retired.length > 0) {
    process.stderr.write(
      `[bot] ${retired.join(", ")} is retired (ADR 0018 removed prompt mode). An agent is agent.ts, ` +
        `optionally with improve.md beside it for LLM-driven self-improvement; ` +
        `use ERIS_AGENT_FROZEN=1 to run it without the improvement loop\n`,
    );
    process.exit(1);
    return;
  }
  const agentTsPath = join(agentDir, "agent.ts");
  const hasAgentTs = existsSync(agentTsPath);
  const hasImprove = existsSync(join(agentDir, "improve.md"));
  // Opt out of the improvement loop while keeping the same directory: the frozen control that
  // ADR 0018 §5 requires in every roster is this flag, not a second copy of the agent.
  const frozen = process.env.ERIS_AGENT_FROZEN === "1";
  if (!hasAgentTs) {
    process.stderr.write(
      existsSync(join(agentDir, "prompt.md"))
        ? `[bot] ${agentDir} has prompt.md but no agent.ts. Prompt mode was removed (ADR 0018): ` +
            `an agent is agent.ts, optionally with improve.md beside it\n`
        : `[bot] ${agentDir} has no agent.ts (ADR 0015 §2 / ADR 0018 §1)\n`,
    );
    process.exit(1);
    return;
  }
  const agentModule = (await import(
    pathToFileURL(agentTsPath).href
  )) as AgentModule;
  let mode: "run" | "decide" | "improve";
  if (typeof agentModule.run === "function") mode = "run";
  else if (typeof agentModule.decide === "function")
    mode = hasImprove && !frozen ? "improve" : "decide";
  else {
    process.stderr.write(
      `[bot] ${agentTsPath} must export decide() or run(ctx)\n`,
    );
    process.exit(1);
    return;
  }
  if (hasImprove && typeof agentModule.run === "function") {
    // run(ctx) owns its own loop, so there is no decide to swap out.
    process.stderr.write(
      `[bot] ${agentDir} has improve.md but exports run(ctx); self-improvement applies to ` +
        `decide() strategies only (ADR 0018 §1)\n`,
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
  // Held in a variable rather than called through agentModule so the improvement loop can swap the
  // strategy underneath a running agent (ADR 0018). In every other mode this is just agentModule.decide.
  let activeDecide = agentModule.decide;
  let deciding = false;
  const invokeDecide = async (obs: AgentObservation): Promise<void> => {
    if (!activeDecide || deciding) return;
    deciding = true;
    try {
      const action = await activeDecide(obs, ctx);
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
      // A decide type without intervalMs runs "once per new block" (same cadence as the old shim +
      // readline). Self-improving agents are on this path too -- that is the point: the trading loop
      // is exactly as fast as a rule agent's, and only the strategy behind it changes (ADR 0018).
      if ((mode === "decide" || mode === "improve") && intervalMs === undefined)
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

  if (mode === "improve") {
    await runImproveLoop();
  }

  // ---- self-improving type: the LLM rewrites the strategy, out of the trade path (ADR 0018) ----
  //
  // The block loop above already drives activeDecide every block. All this does is periodically hand
  // the model the current source plus how it has been doing, and swap activeDecide if what comes
  // back is better. Every accept, decline, rejection and rollback is logged, because the previous
  // attempt at this (deleted src/llm) shipped a rollback that never once fired and nobody noticed.
  async function runImproveLoop(): Promise<void> {
    const improveAgent = loadImproveAgent(agentDir);
    const model =
      improveAgent.model ?? process.env.ERIS_LLM_MODEL ?? DEFAULT_IMPROVE_MODEL;
    const { blocks: reviseEvery, clamped } = effectiveReviseInterval(
      improveAgent.reviseEveryBlocks,
      config.runBlocks,
    );
    if (clamped)
      agentLog({
        reason:
          `revision cadence clamped from ${improveAgent.reviseEveryBlocks} to ${reviseEvery} blocks ` +
          `(a co-located run shares one LLM budget; ADR 0018 §4)`,
      });

    // The strategy the participant shipped, as text. It is what the model is shown first, and what a
    // rollback returns to when the first revision turns out worse.
    const originalSource = readFileSync(agentTsPath, "utf8");
    let currentSource = originalSource;
    let currentVersion = 0;
    let previous: {
      executor: typeof activeDecide;
      source: string;
      version: number;
    } | null = null;
    let revisions = 0;
    let lastBlock = 0;
    // Value at the moment of the last revision, to judge whether that revision helped.
    let valueAtRevision: number | null = null;
    let initialValue: number | null = null;
    const recent: Array<{ round: number; reason?: string; action?: unknown }> =
      [];

    ctx.onObservation((obs) => {
      const value = obs.inventory?.valueUsdc;
      if (typeof value === "number") {
        if (initialValue === null) initialValue = value;
      }
      recent.push({ round: obs.round });
      if (recent.length > 32) recent.shift();
    });

    const valueNow = (): number | null => {
      const v = latestObservation?.inventory?.valueUsdc;
      return typeof v === "number" ? v : null;
    };

    const record = (outcome: RevisionOutcome, block: number): void => {
      // `state`, not `signals`: signals is numeric-only, and a revision record is mostly text
      // (the model's notes, a rejection reason). Post-run diagnosis reads this.
      agentLog({
        round: block,
        reason: `revision ${outcome.kind}`,
        state: { ...outcome },
      });
    };

    let revising = false;
    const maybeRevise = async (block: number): Promise<void> => {
      if (revising || revisions >= MAX_REVISIONS_PER_RUN) return;
      revising = true;
      try {
        // Judge the previous revision before asking for another one: if it made things worse, put
        // the old strategy back rather than letting the model iterate on a regression.
        const value = valueNow();
        if (previous && valueAtRevision !== null && value !== null) {
          const delta = value - valueAtRevision;
          if (delta < 0) {
            activeDecide = previous.executor;
            currentSource = previous.source;
            currentVersion = previous.version;
            record(
              {
                kind: "rolled-back",
                version: currentVersion,
                before: valueAtRevision,
                after: value,
              },
              block,
            );
            previous = null;
          }
        }

        const system = buildRevisionSystem(improveAgent, currentSource);
        const context = buildRevisionContext({
          block,
          valueUsdc: value ?? 0,
          initialValueUsdc: initialValue ?? 0,
          sinceLastRevisionUsdc:
            valueAtRevision !== null && value !== null
              ? value - valueAtRevision
              : null,
          currentVersion,
          recent,
          observation: latestObservation,
        });
        revisions++;
        const raw = await callLlm({
          model,
          system,
          messages: [{ role: "user", content: context }],
        });
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(stripFences(raw));
        } catch {
          record(
            { kind: "rejected", reason: "response was not valid JSON" },
            block,
          );
          return;
        }
        const parsed = parseRevision(parsedJson);
        if (!parsed.ok) {
          record({ kind: "rejected", reason: parsed.reason }, block);
          return;
        }
        if (parsed.revision.executorTs === null) {
          record({ kind: "declined", notes: parsed.revision.notes }, block);
          return;
        }
        const compiled = compileExecutor(parsed.revision.executorTs);
        if (!compiled.ok) {
          record({ kind: "rejected", reason: compiled.reason }, block);
          return;
        }
        // Keep what is being replaced so a regression has somewhere to go back to.
        previous = {
          executor: activeDecide,
          source: currentSource,
          version: currentVersion,
        };
        activeDecide = compiled.executor;
        currentSource = parsed.revision.executorTs;
        currentVersion += 1;
        valueAtRevision = value;
        record(
          {
            kind: "installed",
            version: currentVersion,
            notes: parsed.revision.notes,
          },
          block,
        );
      } catch (error) {
        record(
          {
            kind: "rejected",
            reason: `revision failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          block,
        );
      } finally {
        revising = false;
      }
    };

    ctx.onObservation((obs) => {
      const block = obs.round;
      if (block - lastBlock < reviseEvery) return;
      lastBlock = block;
      void maybeRevise(block);
    });
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
