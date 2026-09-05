/**
 * bot.ts: the single entry point for every agent type (ADR 0015 §2/§3/§4).
 *
 * The coordinator spawns every agent uniformly with
 * `node --import tsx example/agents/runtime/bot.ts` and passes the agent directory via
 * env ERIS_AGENT_DIR. bot.ts decides how to run from that directory's contents:
 *   - agent.ts exports run(ctx)   -> self-driven: pass ctx and delegate (no loop)
 *   - agent.ts exports decide()   -> rule strategy: drive a read->decide->send loop
 *   - agent.ts + prompt.md        -> self-improving: the same loop, plus an LLM that periodically
 *                                   rewrites the strategy out of the trade path (ADR 0018)
 *
 * Prompt mode (an LLM producing an action every decision) was removed in ADR 0018: measured at
 * 8-28 blocks per decision and 1/64 the actions of the same strategy in rule mode, it could not
 * compete. The LLM now improves the strategy instead of driving it -- and prompt.md now holds the
 * policy for *that*, not per-decision instructions, which is why it must declare `kind: improve`
 * (ADR 0018 Amendment 1). A file without the marker is refused rather than reinterpreted.
 *
 *   ERIS_AGENT_FROZEN=1             ignore prompt.md and run the strategy unchanged. This is the
 *                                   frozen control every roster needs (ADR 0018 §5), without
 *                                   duplicating the agent directory
 *   ERIS_LLM_MODEL=<model>          backend for the revision call (prompt.md frontmatter wins)
 *   ERIS_IMPROVE_LOG_CALLS=1        record the raw revision exchange (system / context / response)
 *                                   to runs/<id>/agents/<agentId>.llm.jsonl. Off by default: it holds
 *                                   every generated strategy in full
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
import { accountAddress, makeClients, sendAndMine } from "@eris/sdk/chain.js";
import { loadConfig } from "@eris/sdk/config.js";
import { GMX_MARKETS } from "@eris/sdk/constants.js";
import { baseTokens, gmxMarketAddresses } from "@eris/sdk/markets.js";
import type { FlowWallet, SimContext } from "@eris/sdk/protocols/types.js";
import { initProtocols } from "@eris/sdk/protocols/registry.js";
import { setLendingSingleton } from "@eris/sdk/protocols/lending.js";
import { loadYamlConfig } from "@eris/sdk/runConfig.js";
import { Rng } from "@eris/sdk/rng.js";
import type {
  AgentObservation,
  BalanceSnapshot,
  ProtocolId,
} from "@eris/sdk/types.js";
import { createAgentLog, createJsonlAppender } from "./agentLog.js";
import { callLlm } from "./llm.js";
import {
  buildRevisionContext,
  buildRevisionSystem,
  compileExecutor,
  effectiveReviseInterval,
  improvePolicyState,
  loadImproveAgent,
  MAX_REVISIONS_PER_RUN,
  parseRevision,
  type RevisionOutcome,
  type StrategyVersion,
} from "./improve.js";
import { createMempoolLog, Sender } from "./send.js";
import { preflightChain } from "./preflight.js";
import { Reader } from "./read.js";

// Backend for the revision call when neither prompt.md nor the roster names one.
const DEFAULT_IMPROVE_MODEL = "gpt-oss:120b";

// The published environment manifest (ADR 0021 §2), when running self-hosted. Only the two fields
// the runtime cannot otherwise learn are read from it; everything else still comes from the config
// file, which participants have a copy of.
type Manifest = {
  chain?: { rpcUrl?: string };
  contracts?: {
    priceFeed?: string;
    // Issue #40: the discovery registry, the permissionless lending singleton, and the block the
    // registry was deployed (nothing before it can be an entry).
    marketRegistry?: string;
    lending?: string;
    marketRegistryFromBlock?: number;
  };
};

const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// `approve(address,uint256)` = 0x095ea7b3, then two 32-byte words. Decoded by hand rather than with
// viem's decodeFunctionData because a setupWallet tx that is *not* an approve has to fall through
// silently (some venue may add one), and a throw-on-mismatch decoder would make that a crash.
function decodeApprove(data: Hex): { spender: Address; amount: bigint } | null {
  if (!data || !data.startsWith("0x095ea7b3") || data.length < 138) return null;
  const body = data.slice(10);
  return {
    spender: `0x${body.slice(24, 64)}` as Address,
    amount: BigInt(`0x${body.slice(64, 128)}`),
  };
}

function loadManifest(path: string | undefined): Manifest | null {
  if (!path) return null;
  if (!existsSync(path)) {
    process.stderr.write(`[bot] ERIS_MANIFEST=${path} does not exist\n`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch (err) {
    // Refused rather than ignored: falling back to env would silently point the agent at whatever
    // chain happened to be in the shell, which is how a participant ends up trading nothing on a
    // node nobody is scoring.
    process.stderr.write(
      `[bot] ERIS_MANIFEST=${path} is not readable JSON: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
    return null;
  }
}

async function main(): Promise<void> {
  // ADR 0021 §2: on the practice devnet nobody spawns this process, so the three things the
  // coordinator used to inject come from the published environment manifest instead. Env still wins
  // -- a coordinator-spawned run is unchanged, byte for byte.
  const manifest = loadManifest(process.env.ERIS_MANIFEST);
  const privateKey = process.env.ERIS_AGENT_PRIVATE_KEY as Hex | undefined;
  const rpcUrl = process.env.ERIS_RPC_URL ?? manifest?.chain?.rpcUrl;
  const priceFeed = (process.env.ERIS_PRICE_FEED_ADDRESS ??
    manifest?.contracts?.priceFeed) as Address | undefined;
  // Issue #40: per-run contracts, so they come from env (coordinator-spawned) or the manifest
  // (self-hosted), never from constants.local.ts. Absent means the run has no agent-created markets,
  // which is a capability being off rather than an error.
  const marketRegistry = (process.env.ERIS_MARKET_REGISTRY_ADDRESS ??
    manifest?.contracts?.marketRegistry) as Address | undefined;
  const lending = (process.env.ERIS_LENDING_ADDRESS ??
    manifest?.contracts?.lending) as Address | undefined;
  const registryFromBlock = Number(
    process.env.ERIS_MARKET_REGISTRY_FROM_BLOCK ??
      manifest?.contracts?.marketRegistryFromBlock ??
      0,
  );
  const agentDirEnv = process.env.ERIS_AGENT_DIR;
  const agentId = process.env.ERIS_AGENT_ID ?? "unknown";
  const runDir = process.env.ERIS_RUN_DIR;
  if (!privateKey || !rpcUrl || !priceFeed || !agentDirEnv) {
    process.stderr.write(
      "[bot] missing env (ERIS_AGENT_PRIVATE_KEY / ERIS_RPC_URL / ERIS_PRICE_FEED_ADDRESS / ERIS_AGENT_DIR)\n" +
        "      Self-hosted? Point ERIS_MANIFEST at the environment manifest and it supplies the\n" +
        "      RPC URL and PriceFeed address; the key and the agent directory are yours.\n",
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

  // Before the first read: is this chain one this agent can actually trade on? An agent that cannot
  // reach its RPC still starts, still loops, and still reports nothing -- which summary.json records
  // as 0 transactions and 0 PnL, exactly like an agent that chose to sit still (see preflight.ts).
  // Every other startup problem in this file is refused rather than reinterpreted; this one was the
  // exception, and it is the one nobody can spot afterwards.
  const failure = await preflightChain({
    publicClient,
    rpcUrl,
    expectedChainId: config.chainId,
    enabledIds: adapters.map((a) => a.id),
  });
  if (failure) {
    process.stderr.write(`[bot] ${failure.message}\n`);
    process.exit(1);
    return;
  }

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
    ...(marketRegistry ? { marketRegistry } : {}),
    ...(lending ? { lending } : {}),
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
  // The scorer's valuation context has no SimContext, and the improve loop's sandbox runs the same
  // adapters -- so the singleton is published module-side too, exactly as the coordinator does it.
  setLendingSingleton(lending);
  const reader = new Reader({
    ctx: simCtx,
    adapters,
    priceFeed,
    address,
    runId,
    extraBaseSymbols,
    ...(marketRegistry
      ? { registry: { address: marketRegistry, fromBlock: registryFromBlock } }
      : {}),
  });

  // ---- resolve the agent module (1 agent = 1 directory) ----
  // agent.ts is always the strategy (ADR 0015 §2). If prompt.md sits beside it, the same strategy
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
        `optionally with prompt.md (kind: improve) beside it for LLM-driven self-improvement; ` +
        `use ERIS_AGENT_FROZEN=1 to run it without the improvement loop\n`,
    );
    process.exit(1);
    return;
  }
  const agentTsPath = join(agentDir, "agent.ts");
  const hasAgentTs = existsSync(agentTsPath);
  const policy = improvePolicyState(agentDir);
  const hasImprove = policy === "present";
  // The improvement policy was called improve.md until ADR 0018 Amendment 1. A directory still
  // carrying the old name would otherwise run as a plain rule agent: the strategy trades, nothing
  // ever revises it, and no line of output says the LLM was never involved. Refuse instead.
  if (policy === "renamed") {
    process.stderr.write(
      `[bot] ${agentDir} has improve.md, which was renamed prompt.md (ADR 0018 Amendment 1). ` +
        `Rename it and add \`kind: improve\` to its frontmatter, or delete it to run the strategy ` +
        `unchanged\n`,
    );
    process.exit(1);
    return;
  }
  // Opt out of the improvement loop while keeping the same directory: the frozen control that
  // ADR 0018 §5 requires in every roster is this flag, not a second copy of the agent.
  const frozen = process.env.ERIS_AGENT_FROZEN === "1";
  if (!hasAgentTs) {
    process.stderr.write(
      existsSync(join(agentDir, "prompt.md"))
        ? `[bot] ${agentDir} has prompt.md but no agent.ts. Prompt mode was removed (ADR 0018): ` +
            `an agent is agent.ts, and prompt.md is the policy for revising it, not a strategy\n`
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
  // Read the policy before a single block is traded. Loading it inside the improvement loop meant a
  // malformed or unmarked prompt.md was only discovered once the agent was already trading, which
  // makes a configuration error look like a mid-run crash.
  const improveAgent = mode === "improve" ? loadImproveAgent(agentDir) : null;
  if (hasImprove && typeof agentModule.run === "function") {
    // run(ctx) owns its own loop, so there is no decide to swap out.
    process.stderr.write(
      `[bot] ${agentDir} has prompt.md but exports run(ctx); self-improvement applies to ` +
        `decide() strategies only (ADR 0018 §1)\n`,
    );
    process.exit(1);
    return;
  }

  // Every venue approval this wallet still needs, sent from this wallet's own key.
  //
  // Which approvals are needed is the adapters' knowledge (setupWallet), and it is granted with the
  // agent's key in the coordinator path too -- so this costs exactly the same gas and produces the
  // same allowances. What is new is only *who sends it*: an environment that does not hold the key
  // cannot.
  //
  // Each tx is an `approve(spender, max)`, so the calldata is decoded and the current allowance read
  // first. A self-hosted agent restarts (a crash, a redeploy, a new day on a chain that never
  // resets), and re-approving on every start would burn the endowment a little at a time.
  const ensureVenueApprovals = async (): Promise<void> => {
    const pending: Array<{ to: Address; data: Hex }> = [];
    for (const adapter of adapters) {
      if (!adapter.setupWallet) continue;
      let txs: Awaited<ReturnType<NonNullable<typeof adapter.setupWallet>>>;
      try {
        txs = await adapter.setupWallet(simCtx, address);
      } catch {
        continue; // a venue that cannot describe its approvals is one this agent will fail on later, loudly
      }
      for (const tx of txs) {
        const decoded = decodeApprove(tx.data as Hex);
        if (!decoded) {
          pending.push({ to: tx.to as Address, data: tx.data as Hex });
          continue;
        }
        const allowance = (await publicClient
          .readContract({
            address: tx.to as Address,
            abi: erc20AllowanceAbi,
            functionName: "allowance",
            args: [address, decoded.spender],
          })
          .catch(() => 0n)) as bigint;
        if (allowance < decoded.amount / 2n)
          pending.push({ to: tx.to as Address, data: tx.data as Hex });
      }
    }
    if (pending.length === 0) return;
    for (const tx of pending) {
      try {
        await sendAndMine(publicClient, walletClient, chain, privateKey, tx);
      } catch (err) {
        // Not fatal: the agent may not need this venue, and an approval that failed shows up as a
        // reverted trade with a reason rather than as a silent absence.
        logMempool({
          event: "approval_failed",
          to: tx.to,
          error:
            err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }
    logMempool({ event: "approvals_granted", count: pending.length });
  };

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
  // What the strategy actually did recently. The self-improvement loop shows this to the model as
  // the evidence for a rewrite, so it has to hold the decisions themselves -- recording only that a
  // block happened rendered every entry as "no action" and left the model with nothing to reason
  // about. Populated here rather than from the observation stream because that is where the outcome
  // of a decision (an action, or an error) actually exists.
  const recentDecisions: Array<{
    round: number;
    action?: unknown;
    reason?: string;
  }> = [];
  const rememberDecision = (entry: {
    round: number;
    action?: unknown;
    reason?: string;
  }): void => {
    recentDecisions.push(entry);
    if (recentDecisions.length > 32) recentDecisions.shift();
  };
  const invokeDecide = async (obs: AgentObservation): Promise<void> => {
    if (!activeDecide || deciding) return;
    deciding = true;
    try {
      const action = await activeDecide(obs, ctx);
      if (action) ctx.submit(action);
      rememberDecision({ round: obs.round, action: action ?? undefined });
      // Record the decision not to trade, with its reason. send.ts drops noops before they reach
      // the log, so a strategy that passes every block used to leave nothing behind at all -- and an
      // empty agent log cannot distinguish "never started" from "looked and declined". Both happened
      // during this branch's calibration runs and both cost time to diagnose.
      const declined =
        action === null ||
        action === undefined ||
        (action as { type?: string }).type === "noop";
      if (declined)
        agentLog({
          round: obs.round,
          action: { type: "noop" },
          reason:
            (action as { reason?: string } | null)?.reason ??
            "decide returned nothing",
        });
    } catch (error) {
      const reason = `decide error: ${error instanceof Error ? error.message : String(error)}`;
      rememberDecision({ round: obs.round, reason });
      agentLog({ round: obs.round, reason });
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

  // ADR 0021 §2: grant this wallet's venue approvals if nobody else did. A coordinator-spawned
  // agent had them granted during setup, using this same key -- but the environment cannot sign for
  // a participant who holds their own key, so a self-hosted agent grants them itself. Skipped when
  // they are already in place, which makes it a no-op on every existing path and idempotent across
  // restarts on the practice devnet.
  //
  // Before the block watcher, not after. Registered first, the very first block fired a decision
  // that reached the venue with no allowance: `MockERC20: insufficient allowance`, a reverted trade
  // in the participant's log for a reason that had nothing to do with their strategy.
  await ensureVenueApprovals();

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
    if (!improveAgent) return;
    const model =
      improveAgent.model ?? process.env.ERIS_LLM_MODEL ?? DEFAULT_IMPROVE_MODEL;
    // The raw exchange, opt-in. The outcome log says a revision was rejected or rolled back; only
    // this says what was asked and what came back, which is what prompt tuning actually needs.
    // Off by default because it holds every generated strategy in full.
    const llmLog =
      process.env.ERIS_IMPROVE_LOG_CALLS === "1"
        ? createJsonlAppender(runDir, agentId, ".llm")
        : undefined;
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

    // Every version that has run, version 0 being the strategy the participant shipped. Kept whole so
    // the model can revert to any of them by number rather than by reproducing source, and so the
    // log can be read back afterwards.
    const versions: Array<StrategyVersion & { executor: typeof activeDecide }> =
      [
        {
          version: 0,
          source: readFileSync(agentTsPath, "utf8"),
          notes: "the strategy as submitted",
          installedAtBlock: 0,
          valueAtInstall: null,
          executor: activeDecide,
        },
      ];
    const current = () => versions[versions.length - 1];
    let currentVersion = 0;
    let revisions = 0;
    // Block of the last revision opportunity. Seeded from the first observation, not 0: obs.round is
    // the absolute chain block (read.ts passes `round: bn`), so starting at 0 made the very first
    // observation satisfy `block - lastBlock >= reviseEvery` and fire a revision before the strategy
    // had traded a single block -- with no performance to reason about, burning one of the
    // participant's revisions on nothing.
    let lastRevisionBlock: number | null = null;
    // Value at the moment of the last revision, to judge whether that revision helped.
    let valueAtRevision: number | null = null;
    let initialValue: number | null = null;
    ctx.onObservation((obs) => {
      const value = obs.inventory?.valueUsdc;
      if (typeof value === "number" && initialValue === null)
        initialValue = value;
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
        // Nothing is judged here. Whether a revision helped, and whether to undo it, is the model's
        // call -- an automatic revert needs a threshold and there is no defensible one (ADR 0018 §5).
        // What the harness owes the model is the evidence: the history, and the value at each point.
        const value = valueNow();
        const system = buildRevisionSystem(
          improveAgent,
          current().source,
          Object.keys(latestObservation?.protocols ?? {}) as ProtocolId[],
        );
        const context = buildRevisionContext({
          block,
          valueUsdc: value ?? 0,
          initialValueUsdc: initialValue ?? 0,
          sinceLastRevisionUsdc:
            valueAtRevision !== null && value !== null
              ? value - valueAtRevision
              : null,
          currentVersion,
          history: versions.map(({ executor: _executor, ...v }) => v),
          recent: recentDecisions,
          observation: latestObservation,
        });
        revisions++;
        let raw: string;
        try {
          raw = await callLlm({
            model,
            system,
            messages: [{ role: "user", content: context }],
          });
          llmLog?.({
            kind: "revision_call",
            block,
            model,
            system,
            context,
            raw,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          llmLog?.({
            kind: "revision_call",
            block,
            model,
            system,
            context,
            error: reason,
          });
          throw error;
        }
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
        if (parsed.revision.revertTo !== null) {
          const target = versions.find(
            (v) => v.version === parsed.revision.revertTo,
          );
          if (!target) {
            record(
              {
                kind: "rejected",
                reason: `revertTo ${parsed.revision.revertTo}: no such version (have ${versions
                  .map((v) => v.version)
                  .join(", ")})`,
              },
              block,
            );
            return;
          }
          // Re-installed as a new version rather than by rewinding the list: the history is a record
          // of what ran and when, and rewinding it would erase the fact that the reverted version
          // ever did.
          currentVersion += 1;
          activeDecide = target.executor;
          versions.push({
            ...target,
            version: currentVersion,
            notes: `reverted to v${target.version}: ${parsed.revision.notes}`,
            installedAtBlock: block,
            valueAtInstall: value,
          });
          valueAtRevision = value;
          record(
            {
              kind: "reverted",
              to: target.version,
              from: currentVersion - 1,
              notes: parsed.revision.notes,
            },
            block,
          );
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
        currentVersion += 1;
        activeDecide = compiled.executor;
        versions.push({
          version: currentVersion,
          source: parsed.revision.executorTs,
          notes: parsed.revision.notes,
          installedAtBlock: block,
          valueAtInstall: value,
          executor: compiled.executor,
        });
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
      // Seed the baseline from the first block seen rather than 0. obs.round is the absolute chain
      // block, so a 0 baseline made the first observation instantly "overdue" for a revision.
      if (lastRevisionBlock === null) {
        lastRevisionBlock = block;
        return;
      }
      if (block - lastRevisionBlock < reviseEvery) return;
      lastRevisionBlock = block;
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
