import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyForWalletName } from "../config.js";
import { resolveRunInputs } from "../runConfig.js";
import {
  accountAddress,
  activeStables,
  fundWallet,
  getBalances,
  makeClients,
  mine,
  resetFork,
  sendAndMine,
  setAutomine,
  setEthBalance,
  setIntervalMining,
} from "@eris/sdk/chain.js";
import { RunLogger } from "../logger.js";
import { valueUsdc } from "@eris/sdk/pnl.js";
import { checkRunFeeViolations } from "../postRunCheck.js";
import {
  nextFairPrice,
  ouParamsForSymbol,
  priceRngForAsset,
  Rng,
} from "@eris/sdk/rng.js";
import type {
  AgentObservation,
  AgentSpec,
  BalanceSnapshot,
  ProtocolId,
  WalletRole,
} from "@eris/sdk/types.js";
import { initProtocols } from "@eris/sdk/protocols/registry.js";
import type {
  FlowKind,
  FlowWallet,
  ProtocolAdapter,
  SimContext,
} from "@eris/sdk/protocols/types.js";
import {
  updateOracles,
  updateOraclesMempool,
  writeAaveOraclesStorage,
} from "@eris/sdk/protocols/oracles.js";
import { GMX_MARKETS } from "@eris/sdk/constants.js";
import {
  baseTokens,
  gmxMarketAddresses,
  tokenInfo,
} from "@eris/sdk/markets.js";
import {
  buildFlowContext,
  flowOrdersToIntents,
  initialFairPrice,
  initialFairPriceFor,
  requestFlowIntents,
  submitIntent,
} from "../coordinator.js";
import { FlowProcess, type FlowOrderWire } from "../flowProcess.js";
import { deployFlashArb, FLASH_ARB_ADDRESS } from "../flashArbDemo.js";
import { RealtimeAgentProcess } from "./agentProcess.js";
import { RealtimeFlowProcess } from "./flowProcess.js";
import {
  deployPriceFeed,
  updatePriceFeedForMempool,
  updatePriceFeedMempool,
  writePriceFeedStorage,
  writePriceFeedStorageFor,
} from "./priceFeed.js";
import { reconstructValueSeries } from "./reconstruct.js";
import {
  NoArbMonitor,
  noArbFindings,
  STARTUP_FAIL_BPS,
  STARTUP_WARN_BPS,
} from "./noArb.js";
import { EventSchedule } from "./events.js";
import { VulnSchedule } from "./vulnEvents.js";
import {
  deployVulnPools,
  fundVulnPoolsAt,
  watchVulnSwaps,
  type VulnRuntime,
} from "./vulnPools.js";
import {
  deriveStressVictims,
  openStressVictimPositions,
  readVictimsAccount,
  setupStressVictims,
  type StressVictim,
} from "../liquidationDemo.js";

const GAS_ONLY_WEI = 2_000_000_000_000_000_000_000_000n; // 2,000,000 ETH (gas for admin/keeper)

// Look up the WalletRole from a flowWalletMap key (`${protocol}:${kind}`).
function flowRole(key: string): WalletRole {
  return key.endsWith(":informed") ? "informed-flow" : "uninformed-flow";
}

// Before the competition starts (= off the clock), run a short market loop with only the flow bot to make anvil
// fetch and warm the protocols' working set (pool ticks, reserves, gmx, etc.). This keeps the competition
// phase's mining from hitting upstream cold fetches (the anvil bottleneck mitigation of ADR 0006 Risks). It does
// not resetFork, and the market moves only slightly (~blocks). The price main path is not consumed (a separate Rng).
// Note: the competition uses RealtimeFlowProcess (push), but warmup is outside interval mining so it uses the
// synchronous FlowProcess (request/response).
async function prewarmWorkingSet(
  ctx: SimContext,
  adapters: ProtocolAdapter[],
  enabledIds: ProtocolId[],
  blocks: number,
  startPrice: number,
  runDir: string,
): Promise<void> {
  const warmFlow = new FlowProcess(
    ctx.config.flowBotCommand,
    ctx.config.flowBotArgs,
    ctx.config.flowSeed,
    runDir,
  );
  try {
    const warmRng = new Rng(ctx.config.seed);
    let warmPrice = startPrice;
    for (let i = 1; i <= blocks; i++) {
      warmPrice = nextFairPrice(warmPrice, warmRng, startPrice);
      await updateOracles(ctx, warmPrice);
      const states = await Promise.all(
        adapters.map((adapter) => adapter.readState(ctx, warmPrice)),
      );
      const stateById = new Map<ProtocolId, unknown>(
        adapters.map((adapter, idx) => [adapter.id, states[idx]]),
      );
      const intents = await requestFlowIntents(
        ctx,
        warmFlow,
        enabledIds,
        stateById,
        warmPrice,
        i,
        ctx.config.agentTimeoutMs,
      );
      for (const intent of intents) {
        try {
          await submitIntent(ctx, intent, stateById);
        } catch {
          // the purpose is warming, so ignore individual tx failures
        }
      }
      await mine(ctx.publicClient);
      for (const adapter of adapters) {
        if (!adapter.afterMine) continue;
        try {
          await adapter.afterMine(ctx);
        } catch {
          // ignore keeper failures too
        }
      }
    }
  } finally {
    warmFlow.close();
  }
}

type RealtimeAgentRuntime = {
  id: string;
  spec: AgentSpec;
  privateKey: Hex;
  address: Address;
  process: RealtimeAgentProcess | null; // spawned after setup completes
  initial: BalanceSnapshot;
  included: number; // number of txs included in a block (read by aggregation)
  reverted: number; // of those, the number that reverted
};

type SubmittedMeta = {
  ownerId: string;
  role: WalletRole | "system";
  priorityFeeWei: bigint;
  actionType: string;
};

// The realtime-mode orchestrator (reduced to "environment daemon + scorer" in ADR 0006).
//
// The environment moves the world only by writing to the chain:
//   anvil lifecycle / fair price generation → PriceFeed & oracle update txs / flow orders / GMX keeper.
// Agents perceive and act only by reading/writing the chain (unified on direct; relay was removed in ADR 0015 §5).
// In-block ordering is decided by anvil --order fees in descending fee order.
// Scoring (per-agent value series) is batch-reconstructed by reading historical blocks right after the run ends (§4).
// The economic-gas (ADR 0011) endowment floor. 1 tx ~1.5M gas; a floor (~tens of txs) so even a modest tip does
// not run out of gas on the first move. The final endowment value is decided by calibration measurement (ADR "undecided").
const MIN_ECONOMIC_GAS_ETH_WEI = 500_000_000_000_000_000n; // 0.5 ETH

export async function runRealtimeSimulation(
  // Evaluation tools inject per-regime SEED etc. programmatically (without mutating env).
  overrides: Record<string, string | number | boolean> = {},
  // The return value is the run's location (so callers like the backtest CLI can read results without scanning runs/).
): Promise<{ runId: string; runDir: string }> {
  // ADR 0013: config resolves from YAML (config/local.yaml / --config) as the single source. If there is no YAML,
  // it falls back to the legacy env-driven path (transitional). configPath propagates to child processes so that
  // a direct-mode agent (directShim) can rebuild config from the same YAML.
  const {
    config,
    agents: agentSpecs,
    configPath,
  } = resolveRunInputs(process.argv, overrides);
  if (configPath) process.env.ERIS_CONFIG = configPath;
  const adapters = initProtocols(config.enabledProtocols);
  const enabledIds = adapters.map((a) => a.id);

  // Precondition validation for economic gas (ADR 0011) (fail-fast).
  if (config.economicGas) {
    // Whether the endowment falls below the "minimum gas headroom" (too little runs out of gas on the first move
    // → the run idles; ADR 0011 Risks). 1 tx ~1.5M gas; even a modest tip needs tens of txs' worth of ETH.
    const minGasEthWei = MIN_ECONOMIC_GAS_ETH_WEI;
    if (config.initialEthWei < minGasEthWei) {
      throw new Error(
        `ERIS_ECONOMIC_GAS=1: initialEthWei=${config.initialEthWei} is below the minimum ` +
          `gas headroom (${minGasEthWei}); please raise INITIAL_ETH_WEI (ADR 0011 Risks)`,
      );
    }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logger = new RunLogger(config.runDirRoot, runId);
  logger.event({
    type: "run_started_realtime",
    runId,
    enabledProtocols: enabledIds,
    blockTimeSec: config.blockTimeSec,
    runSeconds: config.runSeconds,
    runBlocks: config.runBlocks,
  });

  // batch=true: automatically aggregate same-tick reads (parallel receipt fetches, readState, etc.) into
  // JSON-RPC array batches / Multicall3, cutting the environment loop's round-trip count.
  const { chain, publicClient, walletClient } = makeClients(
    config.rpcUrl,
    config.chainId,
    { batch: true },
  );
  if (config.skipReset) {
    // Diagnostic: keep the fork cache from the previous run (to isolate cold fetches; ADR 0006 Risks).
    logger.event({ type: "fork_reset_skipped" });
  } else {
    await resetFork(publicClient, {
      forkUrl: config.forkUrl,
      forkBlockNumber: config.forkBlockNumber,
      localDeploy: config.localDeploy,
      localSnapshotFile: config.localSnapshotFile,
    });
  }

  // Mining consistency in local mode: the deployer anvil starts with auto-mine, but a run in a separate process
  // inherits the state after the previous run's teardown (setIntervalMining 0), so setup txs are not mined and it
  // hangs. Explicitly turn auto-mine ON in the setup phase to reliably mine all setup txs (not needed for fork,
  // which starts with --no-mining; turn it back OFF at competition start to make the fee competition work = see below).
  if (config.localDeploy) {
    await setAutomine(publicClient, true);
  }

  // ---- agent wallets (processes start after setup completes; agentSpecs is already resolved from YAML/env) ----
  const agentRuntimes: RealtimeAgentRuntime[] = agentSpecs.map((spec) => {
    const privateKey = privateKeyForWalletName(config, spec.wallet, spec.id);
    return {
      id: spec.id,
      spec,
      privateKey,
      address: accountAddress(privateKey),
      process: null,
      initial: { ethWei: 0n, wethWei: 0n, usdcUnits: 0n },
      included: 0,
      reverted: 0,
    };
  });
  const agentById = new Map(agentRuntimes.map((a) => [a.id, a]));

  // ---- flow-bot process (realtime). Pushes context every block to move the market ----
  // flow is the environment-side market mechanism, so it stays as relay (ADR 0006 "undecided").
  const flowProcess = new RealtimeFlowProcess(
    config.flowBotCommand,
    config.flowBotArgs,
    config.flowSeed,
    logger.runDir,
  );

  // ---- flow wallets (per protocol/kind; used by submitIntent / ctx for selection) ----
  const flowWalletMap = new Map<string, FlowWallet>();
  for (const id of enabledIds) {
    for (const kind of ["informed", "uninformed"] as FlowKind[]) {
      const key = `${id}:${kind}`;
      const privateKey = keccak256(stringToBytes(`flow:${config.seed}:${key}`));
      flowWalletMap.set(key, {
        id: `flow-${key}`,
        address: accountAddress(privateKey),
        privateKey,
      });
    }
  }
  // aave borrower pool: provide independent actors at separate addresses (persistent positions × N).
  // Since they go on flowWalletMap, funding and blocks.csv attribution flow through the same path as other flow wallets.
  if (enabledIds.includes("aave")) {
    for (let i = 0; i < config.aaveFlowActorCount; i++) {
      const key = `aave:actor${i}`;
      const privateKey = keccak256(stringToBytes(`flow:${config.seed}:${key}`));
      flowWalletMap.set(key, {
        id: `flow-${key}`,
        address: accountAddress(privateKey),
        privateKey,
      });
    }
  }

  const adminPk = config.privateKeys.admin;
  const keeperPk = config.privateKeys.keeper;
  const rng = new Rng(config.seed);
  const ctx: SimContext = {
    publicClient,
    walletClient,
    chain,
    config,
    rng,
    adminPk,
    keeperPk,
    oracle: { aaveAggregators: {} },
    gmx: { market: GMX_MARKETS.ETH_USD, markets: gmxMarketAddresses() },
    pendingGmxOrders: [],
    flowWallet(protocol: ProtocolId, kind: FlowKind): FlowWallet {
      const w = flowWalletMap.get(`${protocol}:${kind}`);
      if (!w) throw new Error(`flow wallet not found: ${protocol}:${kind}`);
      return w;
    },
    flowWalletByKey(key: string): FlowWallet {
      const w = flowWalletMap.get(key);
      if (!w) throw new Error(`flow wallet not found: ${key}`);
      return w;
    },
  };

  // tx attribution is primarily by from-address lookup (ADR 0006 §4; keeps blocks.csv even for direct sends).
  // submittedByHash is used only to supplement actionType/fee for txs the environment/relay submitted itself.
  const ownerByAddress = new Map<
    string,
    { ownerId: string; role: WalletRole | "system" }
  >();
  for (const agent of agentRuntimes) {
    ownerByAddress.set(agent.address.toLowerCase(), {
      ownerId: agent.id,
      role: "agent",
    });
  }
  for (const [key, wallet] of flowWalletMap) {
    ownerByAddress.set(wallet.address.toLowerCase(), {
      ownerId: wallet.id,
      role: flowRole(key),
    });
  }
  ownerByAddress.set(accountAddress(adminPk).toLowerCase(), {
    ownerId: "oracle",
    role: "system",
  });
  ownerByAddress.set(accountAddress(keeperPk).toLowerCase(), {
    ownerId: "keeper",
    role: "system",
  });
  const submittedByHash = new Map<string, SubmittedMeta>();

  // Realtime shared latest state (referenced by the relay's async action handler and flow context)
  let latestStateById = new Map<ProtocolId, unknown>();
  let latestFairPrice = 0;
  const latestHistory: AgentObservation["history"] = [];

  try {
    // ---- setup (fast flush: no-mining + sendAndMine) ----
    await setEthBalance(publicClient, accountAddress(adminPk), GAS_ONLY_WEI);
    await setEthBalance(publicClient, accountAddress(keeperPk), GAS_ONLY_WEI);
    for (const adapter of adapters) {
      if (adapter.setupGlobal) await adapter.setupGlobal(ctx);
    }
    const fundTargets: Array<{
      role: WalletRole;
      privateKey: Hex;
      key?: string;
    }> = [
      ...agentRuntimes.map((a) => ({
        role: "agent" as WalletRole,
        privateKey: a.privateKey,
      })),
      ...[...flowWalletMap.entries()].map(([key, w]) => ({
        role: flowRole(key),
        privateKey: w.privateKey,
        key,
      })),
    ];
    for (const t of fundTargets) {
      const isFlow = t.key !== undefined;
      // aave borrower actors are endowed with collateral WETH directly (a USDC→WETH prep swap tends to fail on
      // slippage, and the actor struggles to secure collateral and never reaches borrowing). The collateral is
      // supplied to Aave and stays in a non-scored flow wallet = it never affects the agent's β. Give it a thick
      // buffer for multiple supplies.
      const isAaveActor = t.key?.startsWith("aave:actor") ?? false;
      // Give flow wallets base inventory of flowWethWei / flowBaseAmounts so they can also "sell" under USDC-only
      // (agents stay at initial* = USDC-only/no-β unchanged).
      const wethWei = isAaveActor
        ? config.aaveFlowMaxWethWei * 6n
        : isFlow
          ? config.flowWethWei
          : config.initialWethWei;
      const baseAmounts = isFlow
        ? config.flowBaseAmounts
        : config.initialBaseAmounts;
      await fundWallet(
        publicClient,
        walletClient,
        chain,
        t.privateKey,
        isFlow ? config.flowEthWei : config.initialEthWei,
        wethWei,
        config.initialUsdcUnits,
        baseAmounts,
      );
      for (const adapter of adapters) {
        if (!adapter.setupWallet) continue;
        const approvals = await adapter.setupWallet(
          ctx,
          accountAddress(t.privateKey),
        );
        for (const tx of approvals) {
          await sendAndMine(publicClient, walletClient, chain, t.privateKey, {
            to: tx.to,
            data: tx.data,
            value: tx.value,
          });
        }
      }
    }

    // The initial fair price is finalized here (used by the local oracle calibration and victim setup below).
    latestFairPrice = await initialFairPrice(ctx, enabledIds);

    // [Calibration] Local deploy aligns the Aave oracle to the run's initial fair price. On a fork,
    // "oracle ≈ spot ≈ fair0" holds implicitly, but locally the deployer's seed price and fair0 can diverge (a
    // miscalibration measured where a victim's HF0 breaks at run start and it becomes liquidatable before the
    // crash window; even without victims, the same divergence appears in the initial observation until the first
    // oracle update tx lands). The direct storage write is in the setup phase, so there is no front-run-side
    // impact. If the aggregator is not deployed (aave disabled) it is a no-op (ADR 0016 Phase 0).
    if (config.localDeploy) {
      await writeAaveOraclesStorage(ctx, latestFairPrice);
    }

    // ---- stress victims (ADR 0009 §4): build seed-derived victims that make liquidation possible ----
    // Victims are not included in agentRuntimes = not scored (a profit source for the liquidator agent).
    const stressVictims: StressVictim[] = deriveStressVictims(
      config.seed,
      config.stressVictimCount,
    );
    let victimEnv: Record<string, string> | undefined;
    // Minimum victim HF right after setup (excluding the debt-free sentinel). Used for the crash calibration warning (§2).
    let minVictimHf0: number | null = null;
    if (stressVictims.length > 0) {
      if (!enabledIds.includes("aave")) {
        throw new Error(
          "ERIS_STRESS_VICTIM_COUNT > 0 requires the aave protocol enabled (ADR 0009 §4)",
        );
      }
      // [Hard requirement] fresh state. With a soft-reset, the previous run's victim positions persist and the HF
      // computation breaks (anvil-reset-does-not-clear-state, the cause of the ADR 0007 correction) → fail-fast.
      // A fork satisfies this via a full re-fork (ARB_RPC_URL); local deploy satisfies it because resetFork's
      // snapshot/revert guarantees a "clean cross-section right after load-state / revert" (ADR 0016 §2).
      const victimFreshState =
        !config.skipReset && (config.localDeploy || Boolean(config.forkUrl));
      if (!victimFreshState) {
        throw new Error(
          "stress victims require a fresh state: full re-fork (set ARB_RPC_URL) or local deploy mode, " +
            "and do not set ERIS_SKIP_RESET (ADR 0009 §4 / ADR 0016 §2)",
        );
      }
      await setupStressVictims(ctx, stressVictims);
      await openStressVictimPositions(
        ctx,
        stressVictims,
        config.stressVictimHf0,
      );
      const accounts = await readVictimsAccount(ctx, stressVictims);
      for (const a of accounts) {
        const hf = Number(a.healthFactor) / 1e18;
        // Debt-free (HF is the uint256 max sentinel ≈ 1e59) is out of scope for calibration.
        if (hf < 1e6 && (minVictimHf0 === null || hf < minVictimHf0))
          minVictimHf0 = hf;
      }
      logger.event({
        type: "stress_victims_setup",
        hf0: config.stressVictimHf0,
        victims: accounts.map((a) => ({
          id: a.id,
          address: a.address,
          healthFactor: a.healthFactor.toString(),
          totalCollateralBase: a.totalCollateralBase.toString(),
          totalDebtBase: a.totalDebtBase.toString(),
        })),
      });
      // Pass the victims to monitor to the liquidator agent (the detection-skill premise is preserved: the agent
      // scans HF every block. Addresses are public on-chain info, and distributing them does not add a bidding game).
      victimEnv = {
        ERIS_LIQUIDATION_VICTIMS: stressVictims.map((v) => v.address).join(","),
      };
    }

    for (const agent of agentRuntimes) {
      agent.initial = await getBalances(publicClient, agent.address);
    }

    // ---- On-chain distribution path for the fair price (ADR 0006 §3). Kept permanent and written every block ----
    const priceFeedAddress = await deployPriceFeed(ctx, latestFairPrice);
    logger.event({ type: "price_feed_deployed", address: priceFeedAddress });

    // ---- flash arb demo (GitHub #3, env gate): deploy FlashArb (same gate as the synchronous coordinator) ----
    // Deploy the FlashArb that the flasharb base (ADR 0012) invokes via rawTx here. A one-time setup-phase deploy
    // that does not affect interval mining / mempool ordering (same nature as deployPriceFeed). Without deploying,
    // the receiver has no code and flashLoanSimple reverts (discovered in a live run to be missing from realtime).
    if (
      config.flashArbDemo &&
      enabledIds.includes("aave") &&
      enabledIds.includes("uniswap") &&
      enabledIds.includes("balancer")
    ) {
      await deployFlashArb(ctx);
      logger.event({ type: "flash_arb_deployed", address: FLASH_ARB_ADDRESS });
    }

    // ---- vulnerability-appearance events (ADR 0014): deploy the factory + all pools (a mix of honest/rigged) in
    // setup and issue disclosures. Funding (appearance) happens at each pool's window (the mining loop below).
    // The schedule is SEED-derived and pure. Pools are not included in agentRuntimes = not scored (outside the
    // victims/verifiers).
    const vulnSchedule = new VulnSchedule(
      config.vulnEvents,
      config.seed,
      config.runBlocks,
      baseTokens().map((t) => t.symbol),
    );
    let vulnRuntime: VulnRuntime | null = null;
    let vulnEnv: Record<string, string> | undefined;
    if (vulnSchedule.hasEvents()) {
      vulnRuntime = await deployVulnPools(ctx, vulnSchedule, config, logger);
      // The agent subscribes to the factory and builds a pool graph (§3). fromBlock narrows the getLogs range
      // (scans only from the factory onward even with the fork's huge block numbers). disclosures are referenced via ERIS_RUN_DIR.
      vulnEnv = {
        ERIS_VULN_FACTORY: vulnRuntime.factory,
        ERIS_VULN_FROM_BLOCK: vulnRuntime.factoryDeployBlock.toString(),
        ERIS_VULN_LLM: config.vulnLlm,
      };
    }
    // Merge the stress victim env (ADR 0009) and vuln env (ADR 0014) into a single extra env for distribution.
    const agentExtraEnv =
      victimEnv || vulnEnv ? { ...victimEnv, ...vulnEnv } : undefined;

    // Emit the agent registry in one line (ADR 0008 P0). The dashboard can grasp all agents (id/address/
    // classification hint) immediately from a file tail alone (closes the gap for agents that never act or are
    // missed right after startup). Zero impact on the evaluation/scoring pipeline (an event that is not read).
    logger.event({
      type: "agents_registered",
      agents: agentRuntimes.map((a) => ({
        id: a.id,
        address: a.address,
        baseline: a.spec.baseline ?? false,
        description: a.spec.description,
      })),
    });

    // ---- pre-warm (anvil cold fetch mitigation of ADR 0006 Risks; see prewarmWorkingSet) ----
    if (config.prewarmBlocks > 0) {
      await prewarmWorkingSet(
        ctx,
        adapters,
        enabledIds,
        config.prewarmBlocks,
        latestFairPrice,
        logger.runDir,
      );
      // Re-read the fair price to match the competition's starting point (reflects pools moved during warmup).
      latestFairPrice = await initialFairPrice(ctx, enabledIds);
      logger.event({ type: "prewarm_completed", blocks: config.prewarmBlocks });
    }

    // ---- cross-venue no-arbitrage check at startup (phantom-spread guard; see noArb.ts) ----
    // Calibrated pools must not offer a positive *executable* cross-venue round trip. Fail fast on
    // gross breakage (mis-deploy) before agent processes launch; smaller positives are warned and
    // left to the per-block persistent monitor.
    {
      const states = await Promise.all(
        adapters.map((adapter) => adapter.readState(ctx, latestFairPrice)),
      );
      const stateById = new Map<ProtocolId, unknown>(
        adapters.map((adapter, i) => [adapter.id, states[i]]),
      );
      const findings = noArbFindings(stateById, enabledIds);
      logger.event({
        type: "no_arb_startup",
        warnBps: STARTUP_WARN_BPS,
        failBps: STARTUP_FAIL_BPS,
        findings,
        warned: findings.filter((f) => f.profitBps > STARTUP_WARN_BPS),
      });
      const worst = findings[0];
      if (worst && worst.profitBps > STARTUP_FAIL_BPS) {
        throw new Error(
          `no-arbitrage check failed at startup: executable ${worst.profitBps.toFixed(1)}bps ` +
            `arb on ${worst.base} (buy ${worst.buyVenue} / sell ${worst.sellVenue}) exceeds ` +
            `${STARTUP_FAIL_BPS}bps — venue calibration or pricing is broken (check deploy order/constants)`,
        );
      }
    }

    // ---- launch agent processes (ADR 0015 §5: uniformly runtime/bot.ts; pass the private key and PriceFeed via env) ----
    for (const agent of agentRuntimes) {
      agent.process = new RealtimeAgentProcess(
        agent.spec,
        config.rpcUrl,
        agent.address,
        logger.runDir,
        { privateKey: agent.privateKey, priceFeedAddress, runId },
        config.agentsDir,
        agentExtraEnv,
      );
    }

    // ---- flow order handler: relay the bot's orders to the mempool via the flow wallets ----
    const handleFlowOrders = async (orders: FlowOrderWire[]): Promise<void> => {
      const intents = flowOrdersToIntents(ctx, orders);
      for (const intent of intents) {
        try {
          const hashes = await submitIntent(ctx, intent, latestStateById);
          for (const hash of hashes) {
            submittedByHash.set(hash.toLowerCase(), {
              ownerId: intent.ownerId,
              role: intent.role,
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
            });
            logger.event({
              type: "tx_submitted",
              hash,
              ownerId: intent.ownerId,
              role: intent.role,
              priorityFeeWei: intent.priorityFeeWei,
              actionType: intent.action.type,
              protocol: intent.protocol,
            });
          }
        } catch (error) {
          logger.event({
            type: "tx_submit_failed",
            ownerId: intent.ownerId,
            actionType: intent.action.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    flowProcess.onOrders((orders) => void handleFlowOrders(orders));

    // ---- write mined-block txs to blocks.csv (attribution by from-address lookup; ADR 0006 §4) ----
    // Removed from the realtime loop and scanned in bulk over all blocks after the run ends (the same "off the
    // critical path" move as scoring's history reconstruction). All source data remains on the chain, so a
    // follow-up pass suffices. Consequence: if the run crashes midway, blocks.csv is empty (diagnose via events.jsonl).
    const logBlock = async (b: number): Promise<void> => {
      const block = await publicClient.getBlock({
        blockNumber: BigInt(b),
        includeTransactions: true,
      });
      const txs = block.transactions.filter(
        (tx): tx is Exclude<typeof tx, string> => typeof tx !== "string",
      );
      // Note: bulk fetch via eth_getBlockReceipts cannot be used because it hits "Failed to decode receipt" on
      // anvil's Arbitrum fork. Issue per-tx fetches in parallel (the batch transport bundles them into one HTTP).
      const statuses = await Promise.all(
        txs.map(async (tx) => {
          try {
            const receipt = await publicClient.getTransactionReceipt({
              hash: tx.hash,
            });
            return receipt.status as string;
          } catch {
            return "mined"; // fallback when receipt fetch fails
          }
        }),
      );
      txs.forEach((tx, i) => {
        const meta = submittedByHash.get(tx.hash.toLowerCase());
        const owner = meta ?? ownerByAddress.get(tx.from.toLowerCase());
        if (!owner) return; // tx outside the run (an unexpected external sender)
        const status = statuses[i];
        if (owner.role === "agent") {
          const runtime = agentById.get(owner.ownerId);
          if (runtime) {
            runtime.included++;
            if (status !== "success") runtime.reverted++;
          }
        }
        logger.blockRow({
          round: b,
          blockNumber: BigInt(b),
          txIndex: tx.transactionIndex,
          hash: tx.hash,
          from: tx.from,
          // the fee's authority is the on-chain tx field (the basis for post-run checks; not self-reported)
          priorityFeeWei: tx.maxPriorityFeePerGas ?? meta?.priorityFeeWei ?? 0n,
          status,
          ownerId: owner.ownerId,
          role: owner.role,
          actionType:
            meta?.actionType ?? (owner.role === "agent" ? "direct" : ""),
        });
      });
    };

    // ADR 0010 profile: set the oracle/PriceFeed update fee above the agent cap so --order fees places it at
    // txIndex 0. Place the keeper just below it, fixing the "oracle update → order execution" order within the
    // same block (even with parallel submission, fee decides ordering regardless of arrival order).
    // ADR 0011 economic-gas profile (economicGas): price finalization moves to a direct storage write (the
    // front-run target mechanically disappears), so the env fee ordering guarantee is unnecessary. The keeper only
    // needs to run after agent order placement and does not need front-row fixing, so env txs go out at the normal
    // fee (defaultPriorityFeeWei).
    const economicGas = config.economicGas;
    const oracleFee = economicGas
      ? config.defaultPriorityFeeWei
      : config.maxPriorityFeeWei + 1_000_000_000n;
    const keeperFee = economicGas
      ? config.defaultPriorityFeeWei
      : config.maxPriorityFeeWei + 500_000_000n;
    if (economicGas) {
      logger.event({
        type: "economic_gas_enabled",
        note: "ADR 0011: retire priority-fee cap enforcement, make price finalization a state-write",
        oracleFeeWei: oracleFee.toString(),
        keeperFeeWei: keeperFee.toString(),
      });
    }

    // ---- start the competition phase: switch to interval mining every N real seconds ----
    // Local mode turned auto-mine ON for setup, so turn it back OFF here.
    // If auto-mine remains, each tx becomes its own block and the fee competition breaks (fork is OFF from the start).
    if (config.localDeploy) {
      await setAutomine(publicClient, false);
    }
    await setIntervalMining(publicClient, config.blockTimeSec);
    logger.event({
      type: "interval_mining_started",
      blockTimeSec: config.blockTimeSec,
    });
    const startTime = Date.now();
    // base/effective separation (ADR 0009 §1): advance the OU state as the base series, and derive the effective
    // price from stress events as a separable distortion. Outside the window, β≈0 as before (maintains ADR 0007).
    let baseFair = latestFairPrice; // OU state. Not touched by events.
    // Center of the mean-reverting price model (the base fair price at competition start). Fixed throughout the run.
    const fairAnchor = baseFair;
    // ADR 0013: independent OU prices for extra bases (WBTC etc.). Each base advances with its own Rng, so the
    // WETH price path is unchanged (under the fork default, extraBaseSymbols=[] → exactly matches prior = byte-compatible).
    const extraBaseSymbols = baseTokens()
      .map((t) => t.symbol)
      .filter((s) => s !== "WETH");
    const extraPriceRng: Record<string, Rng> = {};
    const extraBaseFair: Record<string, number> = {};
    const extraAnchor: Record<string, number> = {};
    for (const b of extraBaseSymbols) {
      extraPriceRng[b] = priceRngForAsset(config.seed, b);
      const p0 = await initialFairPriceFor(ctx, b, enabledIds);
      extraBaseFair[b] = p0;
      extraAnchor[b] = p0;
    }
    const schedule = new EventSchedule(
      config.stressEvents,
      config.seed,
      config.runBlocks,
    );
    let processedBlocks = 0;
    let processing = false;
    let lastProcessedBlock = Number(await publicClient.getBlockNumber());
    const runStartBlock = lastProcessedBlock + 1;
    if (schedule.hasEvents()) {
      // Include runStartBlock → the dashboard can judge the window in absolute blocks (ADR 0008/0009).
      logger.event({
        type: "stress_schedule",
        runStartBlock,
        events: schedule.events,
      });
      // Calibration check (§2): whether each crash's realized magnitude can breach a victim
      // (m > (HF0−1)/HF0). If not, warn (victims are not liquidated and the stress axis is empty).
      if (minVictimHf0 !== null) {
        const breachThreshold = (minVictimHf0 - 1) / minVictimHf0;
        for (const ev of schedule.events) {
          if (ev.type === "crash" && ev.magnitude <= breachThreshold) {
            logger.event({
              type: "stress_calibration_warning",
              reason: "crash magnitude may not breach victim HF",
              minVictimHf0,
              breachThreshold,
              crashMagnitude: ev.magnitude,
            });
          }
        }
      }
    }
    // Keep each victim's latest debt (USD 8-decimals) for liquidation detection. Debt decreases only via a
    // liquidationCall (victims are passive) → emit stress_liquidation with the decrease as a liquidation signal.
    const victimLastDebt = new Map<string, bigint>();
    // Cross-venue no-arbitrage monitor (phantom-spread guard; see noArb.ts). Persistent executable
    // arb = structural pricing breakage; transient arb is the alpha agents are meant to capture.
    const noArbMonitor = new NoArbMonitor();

    // End stress/vuln runs by block count (avoids the footgun where the time limit ERIS_RUN_SECONDS expires first
    // and the crash window / vuln window is never reached; ADR 0009 §4 / ADR 0014).
    const stressRun =
      schedule.hasEvents() ||
      stressVictims.length > 0 ||
      vulnSchedule.hasEvents();
    const effectiveRunSeconds =
      stressRun && config.runBlocks > 0 ? 0 : config.runSeconds;
    if (
      stressRun &&
      config.runBlocks > 0 &&
      config.runSeconds > 0 &&
      effectiveRunSeconds === 0
    ) {
      logger.event({
        type: "stress_run_time_limit_disabled",
        runSeconds: config.runSeconds,
        runBlocks: config.runBlocks,
      });
    }

    await new Promise<void>((resolve) => {
      let finished = false;
      let unwatch: () => void = () => {};
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unwatch();
        resolve();
      };
      const timer =
        effectiveRunSeconds > 0
          ? setTimeout(finish, effectiveRunSeconds * 1000)
          : undefined;

      const onBlock = async (bn: number): Promise<void> => {
        if (processing || finished) return;
        processing = true;
        try {
          const fromBlock = lastProcessedBlock + 1;
          lastProcessedBlock = Math.max(lastProcessedBlock, bn);

          // Advance the market one step (RNG updates once per iteration; later parallel tasks share only the values).
          // Advance base by OU only, and apply the (deterministic) stress overlay to derive the effective price.
          // The effective price propagates consistently to PriceFeed / Aave WETH oracle / GMX / scoring (ADR 0009 §1).
          const blockIndex = bn - runStartBlock;
          baseFair = nextFairPrice(baseFair, rng, fairAnchor);
          const overlay = schedule.at(blockIndex);
          latestFairPrice = baseFair * overlay.wethMult;
          // ADR 0013: advance extra bases with independent Rngs and distribute the effective prices into ctx.fairPrices.
          const fairPrices: Record<string, number> = { WETH: latestFairPrice };
          for (const b of extraBaseSymbols) {
            extraBaseFair[b] = nextFairPrice(
              extraBaseFair[b],
              extraPriceRng[b],
              extraAnchor[b],
              ouParamsForSymbol(b),
            );
            fairPrices[b] = extraBaseFair[b] * (overlay.baseMults[b] ?? 1);
          }
          ctx.fairPrices = fairPrices;

          // Fund vulnerability pools (ADR 0014): burn reserve into the pools that entered their window (cheatcode;
          // no mine needed), making the bait-laden opportunity appear on this block. Done synchronously after
          // fairPrices is finalized and before other tasks so the reserve ratio reflects fair (rare processing, window blocks only).
          if (vulnRuntime) {
            try {
              await fundVulnPoolsAt(
                ctx,
                vulnRuntime,
                blockIndex,
                bn,
                fairPrices,
                config,
                logger,
              );
            } catch (error) {
              logger.event({
                type: "vuln_fund_failed",
                blockIndex,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          // keeper / oracle write / state+flow are mutually independent (separate wallets too), so run them in
          // parallel. tx recording (blocks.csv) is removed from the loop and scanned in bulk after the run (see logBlock).

          // keeper (GMX order execution etc.). Scan the caught-up range in one getLogs.
          const keeperTask = async (): Promise<void> => {
            if (fromBlock > bn) return;
            for (const adapter of adapters) {
              if (!adapter.afterMine) continue;
              try {
                await adapter.afterMine(ctx, {
                  noMine: true,
                  priorityFeeWei: keeperFee,
                  fromBlock: BigInt(fromBlock),
                  toBlock: BigInt(bn),
                });
              } catch (error) {
                logger.event({
                  type: "keeper_failed",
                  protocol: adapter.id,
                  fromBlock,
                  toBlock: bn,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          };

          // On-chain distribution of the fair price (PriceFeed) + oracle updates (aave/gmx).
          // Economic gas (ADR 0011): the PriceFeed and Aave oracle are finalized at the block boundary via a direct
          //   storage write (no tx → no front-run target). GMX is not front-run-relevant because the keeper does not
          //   execute in realtime, so avoid direct mapping-storage writes and keep it a normal-fee mempool tx (undecided).
          // 0010: put PriceFeed/oracle on the next block as fee-topping mempool txs.
          const oracleTask = async (): Promise<void> => {
            try {
              if (economicGas) {
                await writePriceFeedStorage(
                  publicClient,
                  priceFeedAddress,
                  latestFairPrice,
                  BigInt(bn),
                );
                await writeAaveOraclesStorage(ctx, latestFairPrice);
                if (ctx.oracle.gmxProvider && ctx.updateGmxOracle) {
                  await ctx.updateGmxOracle(ctx, latestFairPrice, {
                    noMine: true,
                    priorityFeeWei: oracleFee,
                  });
                }
                for (const b of extraBaseSymbols) {
                  await writePriceFeedStorageFor(
                    publicClient,
                    priceFeedAddress,
                    tokenInfo(b).address,
                    fairPrices[b],
                    BigInt(bn),
                  );
                }
                return;
              }
              const feedHash = await updatePriceFeedMempool(
                ctx,
                priceFeedAddress,
                latestFairPrice,
                oracleFee,
              );
              submittedByHash.set(feedHash.toLowerCase(), {
                ownerId: "oracle",
                role: "system",
                priorityFeeWei: oracleFee,
                actionType: "priceFeedUpdate",
              });
              for (const b of extraBaseSymbols) {
                const extraHash = await updatePriceFeedForMempool(
                  ctx,
                  priceFeedAddress,
                  tokenInfo(b).address,
                  fairPrices[b],
                  oracleFee,
                );
                submittedByHash.set(extraHash.toLowerCase(), {
                  ownerId: "oracle",
                  role: "system",
                  priorityFeeWei: oracleFee,
                  actionType: "priceFeedUpdate",
                });
              }
              const oracleHashes = await updateOraclesMempool(
                ctx,
                latestFairPrice,
                oracleFee,
              );
              for (const hash of oracleHashes) {
                submittedByHash.set(hash.toLowerCase(), {
                  ownerId: "oracle",
                  role: "system",
                  priorityFeeWei: oracleFee,
                  actionType: "oracleUpdate",
                });
              }
            } catch (error) {
              logger.event({
                type: "oracle_update_failed",
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };

          // state reads (for flow context and relay observation; a fixed cost independent of agent count) →
          // relay observation push → context push to the flow-bot.
          const stateAndFlowTask = async (): Promise<void> => {
            const states = await Promise.all(
              adapters.map((adapter) =>
                adapter.readState(ctx, latestFairPrice),
              ),
            );
            const stateById = new Map<ProtocolId, unknown>(
              adapters.map((adapter, i) => [adapter.id, states[i]]),
            );
            latestStateById = stateById;
            for (const w of noArbMonitor.check(
              noArbFindings(stateById, enabledIds),
            )) {
              logger.event({
                type: "no_arb_persistent_warning",
                blockNumber: bn,
                base: w.base,
                buyVenue: w.buyVenue,
                sellVenue: w.sellVenue,
                profitBps: w.profitBps,
                consecutiveBlocks: w.consecutiveBlocks,
              });
            }
            const uni = stateById.get("uniswap") as
              { priceUsdcPerWeth?: number } | undefined;
            latestHistory.push({
              round: bn,
              poolPriceUsdcPerWeth: uni?.priceUsdcPerWeth ?? latestFairPrice,
              fairPriceUsdcPerWeth: latestFairPrice,
            });

            // push context to the flow-bot (move the market to create arb opportunities)
            if (flowProcess.isAlive()) {
              const flowContext = await buildFlowContext(
                ctx,
                enabledIds,
                latestStateById,
                latestFairPrice,
                bn,
              );
              flowProcess.pushContext(flowContext);
            }
          };

          // victim HF observation (ADR 0009 §4,7): read HF and debt only inside/near the stress event window and
          // emit to events.jsonl (source data the dashboard shows as a band; the SSE contract is unchanged). Detect
          // a debt decrease as a liquidation. Outside the window (overlay=1) it does not read, avoiding log bloat / RPC load.
          const victimTask = async (): Promise<void> => {
            if (stressVictims.length === 0) return;
            const active = schedule.activeEventAt(blockIndex);
            if (!active && overlay.wethMult === 1) return;
            const accounts = await readVictimsAccount(ctx, stressVictims);
            logger.event({
              type: "stress_victim_hf",
              blockNumber: bn,
              blockIndex,
              wethMult: overlay.wethMult,
              victims: accounts.map((a) => ({
                id: a.id,
                healthFactor: a.healthFactor.toString(),
                totalDebtBase: a.totalDebtBase.toString(),
              })),
            });
            for (const a of accounts) {
              const lastDebt = victimLastDebt.get(a.id);
              if (lastDebt !== undefined && a.totalDebtBase < lastDebt) {
                logger.event({
                  type: "stress_liquidation",
                  blockNumber: bn,
                  blockIndex,
                  victimId: a.id,
                  victimAddress: a.address,
                  repaidBaseUsd: (lastDebt - a.totalDebtBase).toString(),
                  remainingDebtBase: a.totalDebtBase.toString(),
                  healthFactor: a.healthFactor.toString(),
                });
              }
              victimLastDebt.set(a.id, a.totalDebtBase);
            }
          };

          // vulnerability pool hit/execution detection (ADR 0014 §6): scan funded pools' Swap logs as ground-truth
          // and emit vulnerability_exploited / safe_pool_captured.
          // Run only during a vuln run (do not add a per-block getLogs to the default run).
          const vulnTask = async (): Promise<void> => {
            if (!vulnRuntime) return;
            try {
              await watchVulnSwaps(ctx, vulnRuntime, fromBlock, bn, logger);
            } catch (error) {
              logger.event({
                type: "vuln_watch_failed",
                blockNumber: bn,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };

          // Record each task's duration (for diagnosing the environment loop's bottleneck; the measurement source for ADR 0006 "judgment metrics").
          const timed = async (task: () => Promise<void>): Promise<number> => {
            const t0 = Date.now();
            await task();
            return Date.now() - t0;
          };
          const roundStart = Date.now();
          // Run victim/vuln observation only in the relevant run (do not add per-block tasks/Promises to the default run).
          const tasks = [
            timed(keeperTask),
            timed(oracleTask),
            timed(stateAndFlowTask),
          ];
          if (stressVictims.length > 0) tasks.push(timed(victimTask));
          if (vulnRuntime) tasks.push(timed(vulnTask));
          const results = await Promise.all(tasks);
          const [keeperMs, oracleMs, stateFlowMs] = results;
          let taskIdx = 3;
          const victimMs =
            stressVictims.length > 0 ? results[taskIdx++] : undefined;
          const vulnMs = vulnRuntime ? results[taskIdx++] : undefined;
          logger.event({
            type: "round_timing",
            blockNumber: bn,
            blocksCaughtUp: Math.max(0, bn - fromBlock + 1),
            keeperMs,
            oracleMs,
            stateFlowMs,
            ...(victimMs !== undefined ? { victimMs } : {}),
            ...(vulnMs !== undefined ? { vulnMs } : {}),
            totalMs: Date.now() - roundStart,
          });

          processedBlocks++;
          if (config.runBlocks > 0 && processedBlocks >= config.runBlocks)
            finish();
        } catch (error) {
          logger.event({
            type: "realtime_block_error",
            blockNumber: bn,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          processing = false;
        }
      };

      unwatch = publicClient.watchBlockNumber({
        emitOnBegin: true,
        pollingInterval: Math.max(
          100,
          Math.floor((config.blockTimeSec * 1000) / 4),
        ),
        onBlockNumber: (bn) => void onBlock(Number(bn)),
      });
    });

    const elapsedMs = Date.now() - startTime;

    // ---- competition end: stop the agents before scoring (a direct agent keeps placing orders unless stopped) ----
    for (const agent of agentRuntimes) agent.process?.close();
    flowProcess.close();
    await setIntervalMining(publicClient, 0);

    // ---- bulk recording of blocks.csv: scan all run blocks for what was removed from the realtime loop ----
    // (finish before resetFork erases history, and before the violation check and summary)
    const finalBlock = Number(await publicClient.getBlockNumber());
    for (let b = runStartBlock; b <= finalBlock; b++) await logBlock(b);

    // ---- scoring: batch-reconstruct the per-agent value series from historical blocks (ADR 0006 §4) ----
    let valueSeries: Record<string, unknown> = {
      source: "live-observation",
      granularityBlocks: 1,
    };
    // agent -> α (β-removed PnL versus fair at execution; ADR 0015 Notes / equivalent to the amm-challenge edge).
    let alphaByAgent: Record<string, number> = {};
    if (finalBlock >= runStartBlock) {
      const meta = await reconstructValueSeries({
        publicClient,
        logger,
        agents: agentRuntimes.map((a) => ({ id: a.id, address: a.address })),
        enabledIds,
        activeStables: activeStables(),
        priceFeed: priceFeedAddress,
        fromBlock: runStartBlock,
        toBlock: finalBlock,
      });
      valueSeries = meta;
      alphaByAgent = meta.alphaByAgent;
      logger.event({ type: "value_series_reconstructed", ...meta });
    }

    // ---- post-run rule check (ADR 0006 §5): exceeding the fee cap is grounds for invalidating a run ----
    // Under economic gas (ADR 0011 §2), priority-fee cap enforcement is retired (agents bid freely per their
    // opportunity valuation, and whoever values it higher executes first = realistic priority gas auction) → violations is empty.
    const violations = config.economicGas
      ? []
      : checkRunFeeViolations(logger.runDir, config.maxPriorityFeeWei);
    if (config.economicGas) {
      logger.event({
        type: "fee_cap_enforcement_disabled",
        note: "ADR 0011 §2: the economic gas profile does not enforce a priority-fee cap",
      });
    } else if (violations.length > 0) {
      logger.event({ type: "rule_violations_detected", violations });
    }

    // ---- final PnL ----
    const finalFairPrice = latestFairPrice;
    const agentsSummary = [];
    for (const agent of agentRuntimes) {
      const final = await getBalances(publicClient, agent.address);
      const initialValue = valueUsdc(agent.initial, finalFairPrice);
      let finalValue = valueUsdc(final, finalFairPrice);
      const protocolValues: Record<string, number> = {};
      for (const adapter of adapters) {
        const v = await adapter.valueUsdc(
          ctx,
          agent.address,
          null,
          finalFairPrice,
        );
        protocolValues[adapter.id] = v;
        finalValue += v;
      }
      agentsSummary.push({
        id: agent.id,
        address: agent.address,
        initialValueUsdc: initialValue,
        finalValueUsdc: finalValue,
        netPnlUsdc: finalValue - initialValue,
        // alphaUsdc: β-removed PnL versus fair at execution (the trade's take; equivalent to the amm-challenge
        // edge; ADR 0015 Notes). netPnlUsdc is the gross total including price drift β, so look at this for skill
        // comparison. undefined when reconstruction did not run (finalBlock<runStartBlock).
        ...(agent.id in alphaByAgent
          ? { alphaUsdc: alphaByAgent[agent.id] }
          : {}),
        // submission count's primary source is the agent's self-reported log (agents/<id>.jsonl) (ADR 0006 §5)
        includedTxCount: agent.included,
        revertCount: agent.reverted,
        stderrTail: agent.process?.getStderr() ?? "",
      });
    }
    logger.summary({
      runId,
      // the backtest CLI (ADR 0016) injects ERIS_RUN_MODE=backtest. Otherwise realtime.
      mode: config.runMode,
      blockTimeSec: config.blockTimeSec,
      blocksProcessed: processedBlocks,
      elapsedMs,
      finalFairPriceUsdcPerWeth: finalFairPrice,
      valueSeries,
      violations,
      agents: agentsSummary,
    });
    logger.event({ type: "run_completed", runId, runDir: logger.runDir });
    console.error(
      `realtime simulation completed: ${logger.runDir} (${processedBlocks} blocks, ${Math.round(elapsedMs / 1000)}s)`,
    );
  } finally {
    try {
      await setIntervalMining(publicClient, 0);
    } catch {
      // ignore errors during teardown
    }
    for (const agent of agentRuntimes) agent.process?.close();
    flowProcess.close();
  }
  return { runId, runDir: logger.runDir };
}
