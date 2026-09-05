import {
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyForWalletName } from "../config.js";
import { resolveRunInputs } from "../runConfig.js";
import {
  accountAddress,
  activeStables,
  fundWallet,
  getBalances,
  fundAddress,
  isPermissionlesslyMintable,
  makeClients,
  mine,
  resetFork,
  sendAndMine,
  sendBatch,
  setAutomine,
  setChainMode,
  setEthBalance,
  setIntervalMining,
  transferEth,
} from "@eris/sdk/chain.js";
import { RunLogger, type RunArtifactWriter } from "../logger.js";
import { SegmentedRun, sliceEpochSeries } from "../segments.js";
import { buildManifest, MANIFEST_FILENAME } from "../manifest.js";
import { methodNameForCalldata } from "@eris/sdk/methodSelectors.js";
import { valueUsdc } from "@eris/sdk/pnl.js";
import {
  marketPricedStables,
  PAR_STABLE_PRICES,
  readStablePrices,
} from "@eris/sdk/stables.js";
import {
  checkRunFeeViolations,
  checkRunGasViolations,
  countRunRevertedTxs,
} from "../postRunCheck.js";
import { nextFairPrice, priceRngForAsset, Rng } from "@eris/sdk/rng.js";
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
import {
  DEFAULT_ANVIL_PRIVATE_KEYS,
  GMX_MARKETS,
  TOKENS,
} from "@eris/sdk/constants.js";
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
import { reconstructValueSeries, type EpochSeries } from "./reconstruct.js";
import {
  deployAgentMarketVenues,
  registerPending,
  sweepMarkets,
  type MarketRegistryRuntime,
} from "./marketRegistry.js";
import { setLendingSingleton } from "@eris/sdk/protocols/lending.js";
import { LiveScorer } from "./liveScoring.js";
import {
  checkDeployment,
  deploymentMismatchMessage,
} from "@eris/sdk/deploymentCheck.js";
import { marketSeriesMeta, reconstructMarketSeries } from "./marketSeries.js";
import {
  scoreEpochSeriesByAgent,
  type EpochScore,
} from "../scoring/epochScore.js";
import {
  NoArbMonitor,
  noArbFindings,
  STARTUP_FAIL_BPS,
  STARTUP_WARN_BPS,
} from "./noArb.js";
import { EventSchedule, withOuOverride } from "./events.js";
import {
  auditOwnerGuards,
  guardFailureMessage,
  guardProbesFor,
  logGuardAudit,
  unprotectedFindings,
} from "./ownerGuards.js";
import { buildWhaleOrder, whaleFunding, WHALE_WALLET_KEY } from "./whale.js";
import {
  accrueLst,
  lstBlockEvent,
  setupLst,
  slashLst,
  stepLstApy,
  type LstRuntime,
} from "./lst.js";
import {
  reconcileLiquidityPull,
  restoreLiquidityPull,
  setupLiquidityPull,
  type LiquidityPullRuntime,
} from "./liquidity.js";
import {
  liquityBlockEvent,
  watchLiquityEvents,
  setupEusdDepeg,
  setupLiquity,
  type LiquityRuntime,
} from "./liquity.js";
import {
  reconcileStableDepeg,
  restoreStableDepeg,
  setupStableDepeg,
  type StableDepegRuntime,
} from "./stableDepeg.js";
import { PULL_VENUES } from "./liquidityVenues.js";
import type { LstState } from "@eris/sdk/protocols/lst.js";
import type { LiquityState } from "@eris/sdk/protocols/liquity.js";
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
} from "../stressVictims.js";

const GAS_ONLY_WEI = 2_000_000_000_000_000_000_000_000n; // 2,000,000 ETH (gas for admin/keeper)

// Look up the WalletRole from a flowWalletMap key (`${protocol}:${kind}`).
function flowRole(key: string): WalletRole {
  return key.endsWith(":informed") ? "informed-flow" : "uninformed-flow";
}

// The chain's actual block cadence, from the last two blocks' timestamps. On anvil the environment
// sets it; on an external chain the sequencer does, and a mismatch with run.blockTimeSec silently
// mis-sizes every epoch (ADR 0021 §3 sets epoch length in real time, converted through this number).
async function observeBlockTimeSec(
  publicClient: PublicClient,
): Promise<number | null> {
  try {
    const head = await publicClient.getBlock();
    if (head.number < 1n) return null;
    const prev = await publicClient.getBlock({ blockNumber: head.number - 1n });
    const dt = Number(head.timestamp - prev.timestamp);
    return dt > 0 ? dt : null;
  } catch {
    return null;
  }
}

// How far apart the two ways of reading the same boundary came out (ADR 0021 §3). Reported per run
// rather than asserted in a test, because the thing that could break them apart -- a venue whose
// state depends on when it is read rather than on which block -- would only show up on a chain.
export function compareEpochSeries(
  live: EpochSeries,
  swept: EpochSeries,
): {
  boundaries: number;
  compared: number;
  maxAbsDiffUsdc: number;
  maxRelDiff: number;
  worst?: {
    agentId: string;
    boundaryBlock: number;
    live: number;
    swept: number;
  };
} {
  const sweptIndex = new Map(swept.boundaryBlocks.map((b, i) => [b, i]));
  let compared = 0;
  let maxAbsDiffUsdc = 0;
  let maxRelDiff = 0;
  let worst:
    | { agentId: string; boundaryBlock: number; live: number; swept: number }
    | undefined;
  for (const [agentId, liveValues] of Object.entries(live.valuesByAgent)) {
    const sweptValues = swept.valuesByAgent[agentId];
    if (!sweptValues) continue;
    live.boundaryBlocks.forEach((block, i) => {
      const j = sweptIndex.get(block);
      if (j === undefined) return;
      const a = liveValues[i];
      const b = sweptValues[j];
      if (a === null || b === null || a === undefined || b === undefined)
        return;
      compared++;
      const abs = Math.abs(a - b);
      const rel = Math.abs(b) > 0 ? abs / Math.abs(b) : abs > 0 ? 1 : 0;
      if (abs > maxAbsDiffUsdc) {
        maxAbsDiffUsdc = abs;
        worst = { agentId, boundaryBlock: block, live: a, swept: b };
      }
      maxRelDiff = Math.max(maxRelDiff, rel);
    });
  }
  return {
    boundaries: live.boundaryBlocks.length,
    compared,
    maxAbsDiffUsdc,
    maxRelDiff,
    ...(worst ? { worst } : {}),
  };
}

// Free money check for a public chain (issue #33 (1) / ADR 0021 §7).
//
// "cheatcode-free" is about RPC methods, but the same hole can live in a *contract*: the deployer's
// MockERC20 originally let anyone mint, which on a dev node is a convenience and on a chain
// participants can reach is an unbounded balance for whoever notices. It is checked rather than
// assumed because the answer depends on which build of the token the deployment happens to hold, and
// a run scored against mintable tokens is not scored at all.
async function assertTokensNotMintable(
  ctx: SimContext,
  logger: RunLogger,
): Promise<void> {
  const tokens = [
    ...baseTokens().map((t) => ({ symbol: t.symbol, address: t.address })),
    ...activeStables().map((address) => ({ symbol: "stable", address })),
  ];
  const open: string[] = [];
  for (const t of tokens) {
    if (await isPermissionlesslyMintable(ctx.publicClient, t.address))
      open.push(`${t.symbol} (${t.address})`);
  }
  logger.event({
    type: "external_chain_mint_guard",
    checked: tokens.length,
    permissionlessMint: open,
  });
  if (open.length > 0)
    throw new Error(
      `these scored tokens can be minted by anyone: ${open.join(", ")}. On a chain participants can ` +
        "reach, that is an unlimited balance for whoever calls mint(), and no score computed against " +
        "it means anything. Redeploy with a minter-gated token (deployer/contracts/MockERC20.sol)",
    );
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
      warmPrice = nextFairPrice(
        warmPrice,
        warmRng,
        startPrice,
        ctx.config.ou.global,
      );
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
  // null for a registered participant who holds their own key (ADR 0021 §2). Everything the
  // environment does with an agent -- fund it, attribute its txs, score it, rule-check it -- is
  // address-based, so the key is only ever needed to *spawn* one, and an external agent is not
  // spawned.
  privateKey: Hex | null;
  address: Address;
  // True when nothing here starts the process (ADR 0021 §2). Distinct from `process === null`,
  // which is also true for a local agent before setup finishes.
  external: boolean;
  process: RealtimeAgentProcess | null; // spawned after setup completes
  initial: BalanceSnapshot;
  included: number; // number of txs included in a block (read by aggregation)
  reverted: number; // of those, the number that reverted
  // Why the agent process went away before the run ended, if it did. Set from onExit, which only
  // fires on an early exit or a spawn failure. Surfaced in summary.json because the alternative is
  // grepping events.jsonl, and because scenario-matrix standings treat an agent that died as
  // disqualified for that scenario rather than as one that chose to sit still (ADR 0017 §4).
  exitedEarly?: string;
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

// How long a window the post-run sweep will attempt. anvil retains roughly 1,050 blocks of state
// (ADR 0006 Risks), and reading past that returns zeros rather than an error -- a value series that
// silently reads as a cliff. Below the measured limit on purpose: the sweep also reads the G7 median
// window before each boundary, which reaches a few blocks further back than the boundary itself.
const HISTORY_SWEEP_LIMIT = 1000;

// Roughly what one block of a full-venue run appends to events.jsonl, measured at 1,437 B/block on a
// 400-block run with five venues and three agents (blocks.csv adds another ~731). It scales with the
// roster and the venue count, so this is an order of magnitude rather than a figure -- which is all
// the advisory below needs it to be.
const EVENT_BYTES_PER_BLOCK = 1_400;

// Past this, a run that writes one directory is a run whose artifacts nobody can open and whose
// rounds bar renders one control per round. ADR 0021 §6 exists for exactly this, and 20,000 blocks
// is around eleven hours at a two-second cadence -- comfortably longer than any calibration run and
// comfortably shorter than a period.
const SEGMENT_ADVISORY_BLOCKS = 20_000;

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

  // ADR 0020 §1 fail-fast. `resetUnit: scenario` describes a world per (regime, seed), and only the
  // scenario-matrix runner produces those -- it is the caller that resets between runs, not anything
  // in here. Reaching this from a plain config file would run one continuous world and then stamp
  // `scenario` into summary.json: a stored run whose mode is a lie, which later aggregation cannot
  // detect (that is the whole reason the label exists). Hence the mode is only honoured when it
  // arrives as a programmatic override from the runner, never from YAML alone.
  if (
    config.resetUnit === "scenario" &&
    overrides.ERIS_RESET_UNIT !== "scenario"
  )
    throw new Error(
      `run.resetUnit: scenario requires the scenario-matrix runner ` +
        `(npm run backtest -- --scenarios <path>). A single run has one world, so use ` +
        `resetUnit: continuous for sim:realtime (ADR 0020 §1)`,
    );

  // ---- chain mode (issue #33 / ADR 0021 §7) ----
  // Installed before anything touches the chain, so a cheatcode reached for on an external chain
  // throws at the call rather than returning an RPC error some catch swallows.
  setChainMode(config.chainMode, config.treasuryPrivateKey);
  const external = config.chainMode === "external";
  if (external) {
    if (!config.treasuryPrivateKey)
      throw new Error(
        "run.chainMode: external needs TREASURY_PRIVATE_KEY in .env.local — on a chain without " +
          "cheatcodes every balance has to be sent from an account genesis prefunded (issue #33 (1))",
      );
    if (!config.localDeploy)
      throw new Error(
        "run.chainMode: external requires run.localDeploy: true. The external chain runs *our* venue " +
          "deployment (issue #33 Notes: a closed economy the environment owns every contract of), and " +
          "the address overlay that names those contracts is what localDeploy turns on",
      );
    if (config.economicGas)
      throw new Error(
        "run.chainMode: external cannot use run.economicGas: the profile finalizes prices with a " +
          "storage write, which no real chain permits. Use the default tx-based profile until the " +
          "redesign in issue #33 (2) lands (ADR 0021 Negative)",
      );
    if (config.stressVictimCount > 0)
      throw new Error(
        "run.chainMode: external cannot stage stress victims: they require a fresh state per run " +
          "(ADR 0009 §4), and a chain that never resets has none. Victims for the practice devnet " +
          "have to be staged once and left standing",
      );
    if (config.prewarmBlocks > 0)
      throw new Error(
        "run.chainMode: external cannot prewarm: the warmup loop mines its own blocks, and there is " +
          "no cold fork state to warm in the first place (issue #33 (2))",
      );
  }

  // A long run that writes one directory (ADR 0021 §6). Advisory rather than fatal: a deliberately
  // long unsegmented run is a legitimate thing to do, and the operator is the one who knows whether
  // this is a period or a calibration. But it should not be a surprise -- measured, a week
  // unsegmented is a 435MB events.jsonl, a 221MB blocks.csv and 336 rounds in a single bar.
  if (config.segmentHours === 0 && config.runBlocks > SEGMENT_ADVISORY_BLOCKS) {
    const rounds =
      config.epochBlocks > 0
        ? Math.floor(config.runBlocks / config.epochBlocks)
        : 0;
    console.error(
      `[run] WARNING: ${config.runBlocks.toLocaleString("en-US")} blocks into one directory ` +
        `(~${Math.round((config.runBlocks * EVENT_BYTES_PER_BLOCK) / 1e6)}MB of events.jsonl` +
        (rounds > 0 ? `, ${rounds} rounds in one bar` : "") +
        "). Set run.segmentHours to cut the output into days — the chain stays continuous, " +
        "and each segment is an ordinary run directory (ADR 0021 §6).",
    );
  }

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
  // ADR 0021 §6: a chain that runs for a week cannot write one directory. When segmenting is on,
  // the output is cut into day-sized run directories under one competition, and everything that
  // writes goes through the same interface -- so nothing below this line knows it is happening.
  const segments =
    config.segmentHours > 0
      ? new SegmentedRun({
          root: config.runDirRoot,
          competitionId: runId,
          hours: config.segmentHours,
          scenarioSet: config.segmentName || runId,
        })
      : null;
  const logger: RunArtifactWriter =
    segments ?? new RunLogger(config.runDirRoot, runId);
  logger.event({
    type: "run_started_realtime",
    runId,
    enabledProtocols: enabledIds,
    blockTimeSec: config.blockTimeSec,
    runSeconds: config.runSeconds,
    runBlocks: config.runBlocks,
    // The scoring epoch (ADR 0019) is the competition's round. summary.json carries the boundaries,
    // but only after the run ends -- a live viewer needs the length up front to lay the rounds out.
    epochBlocks: config.epochBlocks,
    scoreEvery: config.scoreEvery,
    // SEED is the label for this run's market conditions (ADR 0005): the fair-price path and the
    // stress schedule are both drawn from it. Nothing recorded it, so a stored run could not say
    // which world it was -- which is the one thing needed to replay it.
    seed: config.seed,
    flowSeed: config.flowSeed,
    // ADR 0021 §4: the endpoint the world is on, recorded by the environment. The dashboard's live
    // mode used to discover it from an agent's `runtime_start` log line, which stops working the
    // moment the agents are somebody else's processes on somebody else's machine. Reads go to
    // readRpcUrl, which is the sequencer unless a replica is configured (#36).
    rpcUrl: config.readRpcUrl,
    chainId: config.chainId,
    chainMode: config.chainMode,
  });

  // batch=true: automatically aggregate same-tick reads (parallel receipt fetches, readState, etc.) into
  // JSON-RPC array batches / Multicall3, cutting the environment loop's round-trip count.
  const { chain, publicClient, walletClient } = makeClients(
    config.rpcUrl,
    config.chainId,
    { batch: true },
  );
  if (external) {
    // There is nothing to reset (issue #33 (3)). On the practice devnet that is the design: the
    // chain does not stop for the whole period, and a run is a window on it rather than a world of
    // its own (ADR 0021 §1).
    logger.event({
      type: "fork_reset_skipped",
      reason: "external-chain",
      note: "a real chain cannot be rewound; this run continues the world already on it",
    });
  } else if (config.skipReset) {
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
  if (config.localDeploy && !external) {
    await setAutomine(publicClient, true);
  }

  // ---- agent wallets (processes start after setup completes; agentSpecs is already resolved from YAML/env) ----
  const agentRuntimes: RealtimeAgentRuntime[] = agentSpecs.map((spec) => {
    // An entry registered by address has no key here at all; one registered by wallet still does,
    // even when external, because a practice devnet that issues funded keys is a legitimate way to
    // run one (the manifest hands the key to that participant).
    const privateKey = spec.address
      ? null
      : privateKeyForWalletName(config, spec.wallet, spec.id);
    return {
      id: spec.id,
      spec,
      privateKey,
      address: (spec.address as Address) ?? accountAddress(privateKey as Hex),
      external: spec.external === true,
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

  // Resolved before wallet funding, not at the start of the block loop: the whale wallet has to be
  // endowed with enough inventory to place the largest order the seed drew, and that is only knowable
  // from the resolved schedule. The schedule is a pure function of (config, seed, runBlocks) with no
  // chain dependency, so building it early costs nothing.
  const schedule = new EventSchedule(
    config.stressEvents,
    config.seed,
    config.runBlocks,
  );
  // A dedicated wallet so a whale order does not drain the ordinary flow wallets mid-run (which
  // would quietly change the flow bot's behavior for the rest of the run) and so blocks.csv
  // attributes the print to the event rather than to background flow.
  const whaleEvents = schedule.events.filter((e) => e.type === "whale");
  if (whaleEvents.length > 0) {
    const key = WHALE_WALLET_KEY;
    const privateKey = keccak256(stringToBytes(`flow:${config.seed}:${key}`));
    flowWalletMap.set(key, {
      id: `flow-${key}`,
      address: accountAddress(privateKey),
      privateKey,
    });
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

  // Top an environment wallet up to a target native balance from the treasury (issue #33 (1)).
  // "Up to", not "by": the practice devnet funds the same admin and keeper on every segment, and
  // sending the full amount each time would drain the treasury over a week of restarts.
  const topUpFromTreasury = async (
    address: Address,
    targetWei: bigint,
  ): Promise<void> => {
    const treasuryPk = config.treasuryPrivateKey;
    if (!treasuryPk) return;
    const held = await publicClient.getBalance({ address });
    if (held >= targetWei) return;
    await transferEth(
      publicClient,
      walletClient,
      chain,
      treasuryPk,
      address,
      targetWei - held,
    );
  };

  // Realtime shared latest state (referenced by the relay's async action handler and flow context)
  let latestStateById = new Map<ProtocolId, unknown>();
  let latestFairPrice = 0;
  const latestHistory: AgentObservation["history"] = [];

  try {
    // Before anything else: is the deployment this run names actually on this chain? Two things pick
    // the target and they are set in different places (the chain in .env.local, the addresses in
    // constants.local.ts), so switching between a local node and a devnet means changing both. When
    // only one moves, every read comes back "0x" and the failure surfaces as a decode error naming a
    // bare address, several minutes into setup.
    {
      const check = await checkDeployment({ publicClient, enabledIds });
      logger.event({
        type: "deployment_check",
        chainId: check.chainId,
        checked: check.checked,
        missing: check.missing,
      });
      if (check.missing.length > 0)
        throw new Error(deploymentMismatchMessage(check, config.rpcUrl));
    }

    // Then, on a chain participants can reach, a token anyone can mint makes the endowment
    // meaningless and the funding below pointless (issue #33 (1)).
    if (external) await assertTokensNotMintable(ctx, logger);

    // ---- setup (fast flush: no-mining + sendAndMine) ----
    // The admin and keeper spend gas every block for the whole run, so on anvil they are simply
    // given an absurd balance. On an external chain the treasury tops them up to a target instead:
    // it is a finite account, and 2,000,000 ETH is not a number a genesis alloc can hand out twice.
    if (external) {
      const treasuryPk = config.treasuryPrivateKey as Hex;
      await topUpFromTreasury(
        accountAddress(adminPk),
        config.externalRoleEthWei,
      );
      await topUpFromTreasury(
        accountAddress(keeperPk),
        config.externalRoleEthWei,
      );
      logger.event({
        type: "treasury_funded_roles",
        treasury: accountAddress(treasuryPk),
        targetWei: config.externalRoleEthWei.toString(),
      });
    } else {
      await setEthBalance(publicClient, accountAddress(adminPk), GAS_ONLY_WEI);
      await setEthBalance(publicClient, accountAddress(keeperPk), GAS_ONLY_WEI);
    }
    for (const adapter of adapters) {
      if (adapter.setupGlobal) await adapter.setupGlobal(ctx);
    }
    const fundTargets: Array<{
      role: WalletRole;
      privateKey: Hex | null;
      address: Address;
      key?: string;
    }> = [
      ...agentRuntimes.map((a) => ({
        role: "agent" as WalletRole,
        privateKey: a.privateKey,
        address: a.address,
      })),
      ...[...flowWalletMap.entries()].map(([key, w]) => ({
        role: flowRole(key),
        privateKey: w.privateKey,
        address: w.address,
        key,
      })),
    ];
    // Progress, because on a real chain this loop is minutes rather than instants, and an
    // environment that prints nothing for ten minutes reads as one that has hung.
    let funded = 0;
    for (const t of fundTargets) {
      // The whale passes through here too, even though its balances are overwritten a moment later
      // once the fair price is known: this loop is also where each adapter's setupWallet grants the
      // token approvals. Skipping it to avoid the redundant funding left the whale unapproved, and
      // all four of its swaps reverted on-chain while every log said the event had fired.
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
      // Agents are scored, so `funding.ethWei` is their whole native balance: the default gas buffer
      // would be unchosen β in the live-marked epoch series (ADR 0019 §6). Flow wallets keep it --
      // they are machinery, and a dry flow bot removes market activity from everyone.
      const gasBuffer = isFlow ? undefined : 0n;
      const ethWei = isFlow ? config.flowEthWei : config.initialEthWei;
      if (!t.privateKey) {
        // A participant's own address (ADR 0021 §2). Same endowment, reached without signing as
        // them -- and therefore without the venue approvals below, which only they can grant.
        await fundAddress(
          publicClient,
          walletClient,
          chain,
          t.address,
          ethWei,
          wethWei,
          config.initialUsdcUnits,
          baseAmounts,
          gasBuffer,
        );
        continue;
      }
      await fundWallet(
        publicClient,
        walletClient,
        chain,
        t.privateKey,
        ethWei,
        wethWei,
        config.initialUsdcUnits,
        baseAmounts,
        gasBuffer,
      );
      // Every venue's approvals for this wallet, collected and sent as one batch. They all come
      // from the same key with nothing between them, so on a dev node this is what it always was
      // (send, mine, wait) and on a chain the environment does not mine it is one block instead of
      // one per approval — fifteen wallets at eighteen transactions each is nine minutes of setup
      // at a two-second block time, which the first external run spent in silence.
      const approvals: Array<{ to: Address; data?: Hex; value?: bigint }> = [];
      for (const adapter of adapters) {
        if (!adapter.setupWallet) continue;
        for (const tx of await adapter.setupWallet(ctx, t.address))
          approvals.push({ to: tx.to, data: tx.data, value: tx.value });
      }
      await sendBatch(
        publicClient,
        walletClient,
        chain,
        t.privateKey,
        approvals,
      );
      funded++;
      if (funded % 5 === 0 || funded === fundTargets.length)
        console.error(`[setup] funded ${funded}/${fundTargets.length} wallets`);
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
      // The storage write is a cheatcode; on an external chain the same calibration is an ordinary
      // mined setter tx from the admin key. Both land before any agent starts, so neither is
      // front-runnable -- the difference is only which mechanism is available (issue #33 (1)/(4)).
      if (external) await updateOracles(ctx, latestFairPrice);
      else await writeAaveOraclesStorage(ctx, latestFairPrice);
    }

    // ---- whale endowment (ADR 0017 regime 3) ----
    // Funded here rather than in the loop above because the size is denominated against the fair
    // price, which is only known once the pools have been read. A whale's whole job is to place an
    // order far larger than ordinary flow, so flow-sized funding would make it fail on balance and
    // silently turn the regime into calm for that seed.
    if (whaleEvents.length > 0) {
      const wallet = flowWalletMap.get(WHALE_WALLET_KEY);
      if (!wallet) throw new Error("whale wallet missing from flowWalletMap");
      // Fail fast on a whale pointed at a venue this run does not have. Otherwise submitIntent
      // cannot resolve an adapter, handleFlowOrders swallows the throw, and the run continues with
      // the event silently missing -- every other calibration coupling here (victim HF, the LST rate
      // oracle, the state dump's venues) fails at setup instead.
      for (const ev of whaleEvents) {
        const venue = ev.venue ?? "uniswap";
        if (!enabledIds.includes(venue as ProtocolId))
          throw new Error(
            `whale event targets venue "${venue}", which is not enabled for this run ` +
              `(enabled: ${enabledIds.join(", ")}). Enable it in run.protocols or retarget the event`,
          );
      }
      const fairForFunding: Record<string, number> = {
        WETH: latestFairPrice,
        ...(ctx.fairPrices ?? {}),
      };
      const funding = whaleFunding(schedule.events, fairForFunding);
      await fundWallet(
        publicClient,
        walletClient,
        chain,
        wallet.privateKey,
        config.flowEthWei,
        funding.baseWei.WETH ?? 0n,
        funding.usdcUnits,
        funding.baseWei,
      );
      logger.event({
        type: "stress_whale_funded",
        address: wallet.address,
        baseWei: Object.fromEntries(
          Object.entries(funding.baseWei).map(([k, v]) => [k, v.toString()]),
        ),
        usdcUnits: funding.usdcUnits.toString(),
        events: whaleEvents.length,
      });
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

    // What each agent actually starts with (ADR 0021 §2 / issue #33 (1)).
    //
    // The two funding mechanisms differ in a way that only shows up here. A cheatcode *assigns* a
    // balance, so every agent starts at exactly the endowment whatever it held before. A treasury
    // *adds* to one, so the endowment is a floor: an address that already holds something keeps it.
    //
    // That is right for a continuous economy — an agent that traded well yesterday should still have
    // its gains — and it is a trap at the start of a period. Measured on the first external run:
    // two agents bound to a prefunded dev account started with $3.0bn against a fresh address's
    // $34k, and their per-round returns were then a report on one very large ETH holding. Nothing in
    // the artifacts said so.
    {
      const fair: Record<string, number> = {
        WETH: latestFairPrice,
        ...(ctx.fairPrices ?? {}),
      };
      const values = agentRuntimes.map((a) => ({
        id: a.id,
        valueUsdc: valueUsdc(a.initial, fair, PAR_STABLE_PRICES),
      }));
      const positive = values.filter((v) => v.valueUsdc > 0);
      const min = Math.min(...positive.map((v) => v.valueUsdc));
      const max = Math.max(...positive.map((v) => v.valueUsdc));
      const ratio = positive.length > 1 && min > 0 ? max / min : 1;
      logger.event({ type: "initial_endowment", values, ratio });
      // A factor of two is already a different competition; this is deliberately loud rather than
      // fatal, because mid-period the spread is real history rather than a misconfiguration.
      if (ratio > 2)
        console.error(
          `[funding] WARNING: agents start ${ratio.toFixed(1)}x apart ` +
            `(${min.toFixed(0)} .. ${max.toFixed(0)} USDC). ` +
            (external
              ? "On a chain the environment cannot assign balances, the endowment is a floor: an " +
                "address that already held something keeps it. Use fresh addresses for a fresh field."
              : "Check the roster's funding overrides."),
        );
    }

    // ---- On-chain distribution path for the fair price (ADR 0006 §3). Kept permanent and written every block ----
    const priceFeedAddress = await deployPriceFeed(ctx, latestFairPrice);
    logger.event({ type: "price_feed_deployed", address: priceFeedAddress });

    // ---- agent-created markets (issue #40): the discovery registry and the lending singleton ----
    // Both are per-*run* contracts, like the PriceFeed: they are deployed here rather than living in
    // constants.local.ts, and their addresses reach the agents through env and the manifest.
    //
    // The registrar has its own key. The oracle update sends from admin every block, and two
    // concurrent senders on one key race on the nonce -- which is how the LST redemption rate once
    // froze for a whole run.
    let marketRegistry: MarketRegistryRuntime | undefined;
    if (config.agentMarkets) {
      // The registrar's key has to be its own, and "has to" is not the same as "is". The oracle
      // update sends from admin every block and the registry write sends from here in the same
      // Promise.all: on one key they resolve the same pending nonce and one silently replaces the
      // other -- which is how the LST redemption rate once froze for a whole run. Checked rather
      // than assumed, because the two keys come from separate env vars and nothing else would
      // notice them being set to the same value.
      const registrarPk = config.privateKeys.setup;
      for (const [name, other] of [
        ["admin", config.privateKeys.admin],
        ["keeper", config.privateKeys.keeper],
      ] as const) {
        if (registrarPk.toLowerCase() === other.toLowerCase())
          throw new Error(
            `SETUP_PRIVATE_KEY is the same key as ${name.toUpperCase()}_PRIVATE_KEY. The market ` +
              "registry writes from the setup key every block, alongside the oracle update on the " +
              "admin key; two senders on one key race on the nonce and one is silently dropped " +
              "(issue #40). Give the registrar its own key, or run with agentMarkets.enabled: false.",
          );
      }
      marketRegistry = await deployAgentMarketVenues(
        ctx,
        registrarPk,
        config.agentMarketsPerBlockCap,
        logger,
      );
      ctx.marketRegistry = marketRegistry.address;
      ctx.lending = marketRegistry.lending;
      // The scorer's valuation context has no SimContext, so the singleton reaches it here.
      setLendingSingleton(marketRegistry.lending);
    } else if (enabledIds.includes("lending")) {
      throw new Error(
        "run.protocols includes `lending` but agentMarkets.enabled is false. The lending venue is a " +
          "singleton the environment deploys as part of the agent-created-market capability " +
          "(issue #40); without it every lending action would be rejected at build time and the " +
          "roster would look like it chose not to lend. Set `agentMarkets: { enabled: true }`.",
      );
    }

    // Contracts the environment owns. The CREATE scan only covers the competition window and every
    // environment deploy happens in setup, so this is belt and braces -- but publishing an
    // environment contract as an "agent-created market" would tell the field the environment is a
    // participant, and that is worth being sure about.
    const environmentAddresses = new Set<string>(
      [
        priceFeedAddress as string,
        marketRegistry?.address as string | undefined,
        marketRegistry?.lending as string | undefined,
        FLASH_ARB_ADDRESS as string,
      ]
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.toLowerCase()),
    );

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
    // ERIS_RUN_DIR is fixed when the process starts; the segment it names is not (ADR 0021 sec 6).
    // Hand the child the pointer so its log follows the roll instead of piling into segment 0.
    const segmentEnv = segments
      ? { ERIS_RUN_DIR_POINTER: segments.pointerPath }
      : undefined;
    // Issue #40: where the registry and the lending singleton are. Per-run contracts, so they
    // cannot come from constants.local.ts the way a venue address does; a self-hosted participant
    // reads them from the manifest instead (ADR 0021 §2).
    const registryEnv = marketRegistry
      ? {
          ERIS_MARKET_REGISTRY_ADDRESS: marketRegistry.address,
          ERIS_LENDING_ADDRESS: marketRegistry.lending,
          ERIS_MARKET_REGISTRY_FROM_BLOCK: String(marketRegistry.deployBlock),
        }
      : undefined;
    // The gas budget the run is actually enforcing (issue #40 T0). Handed to the agents so the
    // runtime self-limits to the same number the post-run check judges by -- three copies of a
    // ceiling is three chances for them to disagree, and the one that matters is the one that
    // disqualifies.
    const gasBudgetEnv = {
      ERIS_MAX_TX_GAS: config.maxTxGas.toString(),
      ERIS_MAX_AGENT_BLOCK_GAS: config.maxAgentBlockGas.toString(),
    };
    const agentExtraEnv = {
      ...victimEnv,
      ...vulnEnv,
      ...segmentEnv,
      ...registryEnv,
      ...gasBudgetEnv,
    };

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
        // ADR 0021 §4: the dashboard hides the decision-log and mempool panels for these, because
        // those artifacts are on the participant's machine and nothing here can show them. An empty
        // panel and an absent one say different things.
        external: a.external,
      })),
    });

    // ---- environment manifest (ADR 0021 §2) ----
    // Written once the PriceFeed exists, because that address is the one piece a participant cannot
    // look up anywhere else. It carries no keys and no stress timings -- see core/src/manifest.ts.
    logger.artifact(
      MANIFEST_FILENAME,
      buildManifest({
        config,
        priceFeed: priceFeedAddress,
        ...(marketRegistry
          ? {
              marketRegistry: marketRegistry.address,
              lending: marketRegistry.lending,
              marketRegistryFromBlock: marketRegistry.deployBlock,
            }
          : {}),
        participants: agentRuntimes.map((a) => ({
          id: a.id,
          address: a.address,
          external: a.external,
          baseline: a.spec.baseline ?? false,
          description: a.spec.description,
        })),
      }),
    );

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

    // ---- LST venue (issue #38): align the deployed vault with this run's economic clock, and
    // refuse to start on a secondary market that is not tracking the redemption rate (an unwired
    // rate oracle would hand every agent the same risk-free arb). Must happen before interval
    // mining starts, since the reconfiguration is a mined setup tx.
    const lstRuntime: LstRuntime | null = enabledIds.includes("lst")
      ? await setupLst(ctx, logger)
      : null;

    // ---- Liquity venue (issue #39): point the CDP's permanent oracle adapter at this run's
    // PriceFeed, and refuse to start on a venue that would mark Troves against another run's price
    // or on a peg that is already broken. A mined setup transaction, so it belongs before interval
    // mining starts -- and after the prewarm, whose trading is what settles the fair price it checks.
    const liquityRuntime: LiquityRuntime | null = enabledIds.includes("liquity")
      ? await setupLiquity(
          ctx,
          { priceFeed: priceFeedAddress, fairPrice: latestFairPrice },
          logger,
        )
      : null;

    // The environment's depth and its eUSD both belong to the deployer, which is the anvil default
    // account 0 (ADR 0016 §4). An agent bound to AGENT0_PRIVATE_KEY is that same account, and two
    // senders on one key race on the nonce — the failure mode that once froze the LST redemption
    // rate for a whole run. Checked once for both events, since they share the key.
    const deployerPk = DEFAULT_ANVIL_PRIVATE_KEYS[0];
    if (
      schedule.hasLiquidityPull() ||
      schedule.hasEusdDepeg() ||
      schedule.depegStables().length > 0
    ) {
      // By address, not by key: a participant registered by address collides just as hard, and the
      // environment never sees their key to compare it against.
      const deployerAddress = accountAddress(deployerPk).toLowerCase();
      const clash = agentRuntimes.find(
        (a) => a.address.toLowerCase() === deployerAddress,
      );
      if (clash) {
        throw new Error(
          `a stress event trades as the deployer account, but agent "${clash.id}" is bound to the ` +
            "same key (AGENT0_PRIVATE_KEY = anvil account 0). Move that agent to another wallet, " +
            "or to AUTO",
        );
      }
    }

    // ---- depeg stress events (issues #39 and #27 (c)): stage the accounts that will push each
    // peg off par. Without one, a stable's market sits at par by construction and there is nothing
    // to trade -- so a regime that wants the peg exercised has to ask for the event.
    //
    // One list rather than one variable: a run can depeg eUSD and a plain stable in the same window,
    // and they differ only in which pool and which float.
    const depegRuntimes: Array<{
      runtime: StableDepegRuntime;
      fractionAt: (blockIndex: number) => number;
      ownerId: string;
    }> = [];
    if (schedule.hasEusdDepeg()) {
      if (!liquityRuntime) {
        throw new Error(
          "stress event eusdDepeg needs the liquity venue: add it to run.protocols (it is the " +
            "venue whose stablecoin the event depegs)",
        );
      }
      depegRuntimes.push({
        runtime: await setupEusdDepeg(
          ctx,
          { localDeploy: config.localDeploy, actorPk: deployerPk },
          logger,
        ),
        fractionAt: (i) => schedule.eusdDepegFractionAt(i),
        ownerId: "liquity-depeg",
      });
    }
    for (const symbol of schedule.depegStables()) {
      if (!config.localDeploy) {
        throw new Error(
          "stress event depeg requires run.localDeploy: the environment sells into a pool it seeded, " +
            "and a fork has no such pool (issue #27 (c))",
        );
      }
      // Enabled-venue gated (marketPricedStables reads the run's protocol set), not merely
      // deployed: a stable this run did not enable is not swept, not priced and not tradable, so
      // depegging it would move a price nobody can see or act on.
      const market = marketPricedStables().find((m) => m.symbol === symbol);
      if (!market) {
        const known = marketPricedStables()
          .map((m) => m.symbol)
          .join(", ");
        throw new Error(
          `stress event depeg targets "${symbol}", which this run does not price from a market ` +
            `(available: ${known || "none"}). Either the deployment has no pool for it, or its ` +
            "venue is missing from run.protocols -- a stable with neither cannot be pushed off " +
            "par, and would be scored at $1 whatever the event did.",
        );
      }
      depegRuntimes.push({
        runtime: await setupStableDepeg(
          ctx,
          {
            market: {
              symbol: market.symbol,
              stable: market.token,
              quote: TOKENS.USDC.address,
              pool: market.pool,
              stableIndex: market.stableIndex,
              quoteIndex: market.quoteIndex,
            },
            label: "stress_depeg",
            actorPk: deployerPk,
            emptyInventoryHint:
              `The deploy mints the initial ${symbol} supply to the deployer account and seeds only ` +
              "part of it into the pool, so an empty balance means a different account deployed the " +
              "tokens, or a previous run spent it.",
          },
          logger,
        ),
        fractionAt: (i) => schedule.depegFractionAt(symbol, i),
        ownerId: `depeg-${symbol.toLowerCase()}`,
      });
    }
    // Their swaps are environment transactions, like the oracle writes: attributing them to a
    // participant would put them through the post-run fee check (core/src/postRunCheck.ts).
    //
    // One entry, not one per runtime. Every depeg -- and the liquidity pull below -- trades as the
    // same deployer account, so per-mechanism entries would simply overwrite each other and label
    // every unmatched tx from that account with whichever ran last. A tx whose hash *is* in
    // submittedByHash still gets its own mechanism's id; this is only the fallback.
    if (depegRuntimes.length > 0) {
      ownerByAddress.set(depegRuntimes[0].runtime.actor.toLowerCase(), {
        ownerId:
          depegRuntimes.length === 1
            ? depegRuntimes[0].ownerId
            : depegRuntimes.map((d) => d.ownerId).join("+"),
        role: "system",
      });
    }

    // ---- liquidity-pull stress event (issue #52): find the environment-owned depth this run may
    // withdraw, and refuse to start if the schedule asks for depth nobody here owns. Like the LST
    // setup this sends mined transactions (standing approvals for the restore leg), so it belongs
    // before interval mining starts.
    let liquidityPullRuntime: LiquidityPullRuntime | null = null;
    if (schedule.hasLiquidityPull()) {
      liquidityPullRuntime = await setupLiquidityPull(
        ctx,
        schedule,
        {
          localDeploy: config.localDeploy,
          ownerPk: deployerPk,
          // Only the venues this run turned on: an event that names no venue thins every book, and
          // asking for one that is not deployed would fail the discovery check for no reason.
          enabledVenues: PULL_VENUES.filter((v) => enabledIds.includes(v)),
        },
        logger,
      );
      // Its withdrawals are environment transactions, like the oracle writes: attributing them to a
      // participant would put them through the post-run fee check (core/src/postRunCheck.ts).
      ownerByAddress.set(liquidityPullRuntime.owner.toLowerCase(), {
        ownerId: "liquidity",
        role: "system",
      });
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

    // ---- owner guards on the environment's own contracts (issue #40 T0) ----
    //
    // Measured, not asserted: every privileged write is simulated from an address with no role, and
    // a call that does not revert is a missing guard. Run here, after every venue is wired and
    // before any agent process exists, so the answer describes the world the agents are about to
    // enter.
    {
      const probes = guardProbesFor({
        priceFeed: priceFeedAddress,
        marketRegistry: marketRegistry?.address,
        aaveAggregators: ctx.oracle.aaveAggregators,
        lstVault: lstRuntime?.vault,
        gmxOracleProvider: ctx.gmx.mockProvider,
      });
      const findings = await auditOwnerGuards(publicClient, probes);
      logGuardAudit(logger, findings);
      const unprotected = unprotectedFindings(findings, probes);
      if (unprotected.length > 0) {
        const message = guardFailureMessage(unprotected);
        // Fatal only when participants can actually send arbitrary transactions. Without
        // agent-created markets the same hole exists and has no reachable exploit -- the only
        // senders are wallets the environment derives -- so it is reported and the run continues,
        // which is what keeps every pre-existing regime running unchanged.
        if (config.agentMarkets) throw new Error(message);
        console.warn(`${message}\n(not fatal: agentMarkets is off in this run)`);
      }
    }

    // ---- launch agent processes (ADR 0015 §5: uniformly runtime/bot.ts; pass the private key and PriceFeed via env) ----
    for (const agent of agentRuntimes) {
      if (agent.external || !agent.privateKey) {
        // ADR 0021 §2: registered, funded, scored -- and started by whoever registered it. Recorded
        // so a run whose participants never connected is distinguishable from one where the
        // coordinator failed to launch them: both look like an agent that made no trades.
        logger.event({
          type: "agent_external_registered",
          agentId: agent.id,
          address: agent.address,
          note: "the participant runs this agent; its decision log stays on their machine",
        });
        continue;
      }
      agent.process = new RealtimeAgentProcess(
        agent.spec,
        config.rpcUrl,
        agent.address,
        logger.runDir,
        { privateKey: agent.privateKey, priceFeedAddress, runId },
        config.agentsDir,
        config.runBlocks,
        agentExtraEnv,
      );
      // An agent that dies mid-run silently stops trading, which reads in summary.json exactly like
      // an agent that chose not to trade. Record it so the two can be told apart.
      const runtime = agent;
      const child = agent.process;
      if (!child) continue;
      child.onExit = (info) => {
        runtime.exitedEarly = info.reason;
        logger.event({
          type: "agent_process_exited",
          agentId: runtime.id,
          ...info,
          stderrTail: child.getStderr().slice(-2000),
        });
        console.error(
          `[agent] ${runtime.id} ${info.reason}` +
            (info.code !== undefined ? ` (code ${info.code})` : "") +
            (info.signal ? ` (signal ${info.signal})` : ""),
        );
      };
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
      // The receipt carries both the status and the gas actually burned (issue #40 T0). The gas is
      // read here rather than estimated anywhere else: it is the chain's number, which is what makes
      // the post-run gas-budget check as untamperable as the fee check beside it.
      const receipts = await Promise.all(
        txs.map(async (tx) => {
          try {
            const receipt = await publicClient.getTransactionReceipt({
              hash: tx.hash,
            });
            return {
              status: receipt.status as string,
              gasUsed: receipt.gasUsed as bigint | undefined,
            };
          } catch {
            return { status: "mined", gasUsed: undefined }; // fallback when receipt fetch fails
          }
        }),
      );
      const statuses = receipts.map((r) => r.status);
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
          // ADR 0021 §4: from the tx's own calldata, which this block fetch already has. The
          // explorer used to name a participant's methods by joining their self-reported log, and a
          // participant who runs their own agent files no such log with anyone.
          method: methodNameForCalldata(tx.input) ?? "",
          ...(receipts[i].gasUsed === undefined
            ? {}
            : { gasUsed: receipts[i].gasUsed }),
        });
      });
    };

    // How far blocks.csv has been written. The scan is off the critical path (it re-reads mined
    // blocks), but *when* it runs matters: a single bulk pass at the end works for a run with an
    // end and fails twice for a period that does not have one — nothing is written while it runs,
    // and when it finally is, every block lands in whichever segment happened to be current. Both
    // observed: five segments of a devnet period, every blocks.csv empty (ADR 0021 §6).
    let loggedThroughBlock = 0;
    const flushBlocks = async (upTo: number): Promise<void> => {
      if (loggedThroughBlock === 0) loggedThroughBlock = runStartBlock - 1;
      for (let b = loggedThroughBlock + 1; b <= upTo; b++) await logBlock(b);
      loggedThroughBlock = Math.max(loggedThroughBlock, upTo);
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
    if (config.localDeploy && !external) {
      await setAutomine(publicClient, false);
    }
    if (external) {
      // The sequencer has been producing blocks the whole time; there is no phase change to make.
      // What the environment does have to know is the real cadence, because the block loop's
      // polling interval and every "blocks per epoch" conversion are derived from it -- so measure
      // it rather than trusting the configured value (issue #33 (2) / #35 genesis block time).
      const observed = await observeBlockTimeSec(publicClient);
      logger.event({
        type: "external_chain_block_time",
        configuredSec: config.blockTimeSec,
        observedSec: observed,
        note:
          observed !== null && Math.abs(observed - config.blockTimeSec) > 0.5
            ? "run.blockTimeSec disagrees with the chain; epoch lengths and the poll interval are " +
              "derived from the configured value, so align it with the sequencer"
            : undefined,
      });
    } else {
      await setIntervalMining(publicClient, config.blockTimeSec);
      logger.event({
        type: "interval_mining_started",
        blockTimeSec: config.blockTimeSec,
      });
    }
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
    let processedBlocks = 0;
    let processing = false;
    let lastProcessedBlock = Number(await publicClient.getBlockNumber());
    const runStartBlock = lastProcessedBlock + 1;

    // ---- live scoring (ADR 0021 §3) ----
    // The epoch boundary is read as it goes past rather than swept up afterwards. On a chain that
    // never stops there is no afterwards, and on any chain the node's history depth is finite --
    // both of which the sweep hits at exactly the run lengths a practice period needs.
    const liveScorer = new LiveScorer({
      publicClient,
      logger,
      agents: agentRuntimes.map((a) => ({ id: a.id, address: a.address })),
      enabledIds,
      activeStables: activeStables(),
      priceFeed: priceFeedAddress,
      runStartBlock,
      epochBlocks: config.epochBlocks,
      markMedianBlocks: config.markMedianBlocks,
      // Venue state at each boundary, so a live viewer has something to draw before market.json
      // exists. Off when the post-run reconstruction will cover it anyway *and* the run is short
      // enough for that to be the richer artifact.
      sampleMarket: true,
    });
    if (segments) segments.noteFirstBlock(runStartBlock);

    // ADR 0019 §2's benchmark, resolved once: every segment's score is excess over the same entry.
    const baselineId = agentRuntimes.find((a) => a.spec.baseline)?.id;

    // Close a segment: write it a summary.json holding the epochs that fell inside it, so each
    // segment is an ordinary run directory that every existing tool can read. The slice carries the
    // boundary immediately before the segment's start as its own boundary 0 (see sliceEpochSeries),
    // because a segment's first epoch ends inside it but begins in the one before.
    const closeSegment = (atBlock: number): unknown[] => {
      if (!segments) return [];
      const whole = liveScorer.series();
      const sliced = whole
        ? sliceEpochSeries(whole, segments.currentSegmentStartBlock, atBlock)
        : undefined;
      const scores =
        sliced && sliced.boundaryBlocks.length > 1
          ? scoreEpochSeriesByAgent(sliced.valuesByAgent, {
              ...(baselineId !== undefined ? { benchmarkId: baselineId } : {}),
            })
          : undefined;
      const agents = agentRuntimes.map((a) => ({
        id: a.id,
        address: a.address,
        // Segment endpoints, from the boundaries the segment covers. Deliberately not the run's
        // opening balances: a segment is a window on a continuous economy, and an agent's PnL for
        // Tuesday is what changed on Tuesday.
        initialValueUsdc: sliced?.valuesByAgent[a.id]?.[0] ?? 0,
        finalValueUsdc:
          sliced?.valuesByAgent[a.id]?.[
            (sliced.boundaryBlocks.length ?? 1) - 1
          ] ?? 0,
        netPnlUsdc:
          (sliced?.valuesByAgent[a.id]?.[
            (sliced.boundaryBlocks.length ?? 1) - 1
          ] ?? 0) - (sliced?.valuesByAgent[a.id]?.[0] ?? 0),
        includedTxCount: a.included,
        revertCount: a.reverted,
      }));
      logger.summary({
        runId: `${runId}/segment-${segments.currentSegment}`,
        mode: config.runMode,
        resetUnit: config.resetUnit,
        blockTimeSec: config.blockTimeSec,
        segment: segments.currentSegment,
        fromBlock: segments.currentSegmentStartBlock,
        toBlock: atBlock,
        finalFairPriceUsdcPerWeth: latestFairPrice,
        valueSeries: sliced
          ? {
              source: "live-epoch-boundaries",
              epochSeries: {
                epochBlocks: config.epochBlocks,
                epochs: Math.max(0, sliced.boundaryBlocks.length - 1),
                ...sliced,
              },
            }
          : { source: "live-epoch-boundaries", failed: true },
        ...(scores ? { epochScores: scores } : {}),
        violations: [],
        agents,
      });
      // The index entry is standings-shaped (the dashboard reads a competition's scenarios with the
      // same code either way), so it carries the score rather than only the balances.
      return agents.map((a) => ({
        id: a.id,
        netPnlUsdc: a.netPnlUsdc,
        // Alpha needs the fixed-reference sweep, which a segment of a continuous chain does not get.
        // Reported as 0 rather than omitted, because the field is what the standings read.
        alphaUsdc: 0,
        score: scores?.[a.id]?.score ?? 0,
        excessLogGrowth: (scores?.[a.id]?.logReturns ?? []).reduce(
          (x, y) => x + y,
          0,
        ),
        initialValueUsdc: a.initialValueUsdc,
        finalValueUsdc: a.finalValueUsdc,
      }));
    };

    const rollSegment = async (atBlock: number): Promise<void> => {
      if (!segments) return;
      // Before the directory changes: these rows belong to the segment that is closing.
      await flushBlocks(atBlock);
      const agents = closeSegment(atBlock);
      const previous = segments.currentSegment;
      segments.roll(atBlock, agents);
      // The new segment opens with the same header the first one did, so it stands alone: a viewer
      // that lands on Thursday should not have to read Monday to learn what the chain is.
      logger.event({
        type: "run_started_realtime",
        runId,
        segment: segments.currentSegment,
        previousSegment: previous,
        enabledProtocols: enabledIds,
        blockTimeSec: config.blockTimeSec,
        runSeconds: config.runSeconds,
        runBlocks: config.runBlocks,
        epochBlocks: config.epochBlocks,
        scoreEvery: config.scoreEvery,
        seed: config.seed,
        flowSeed: config.flowSeed,
        rpcUrl: config.readRpcUrl,
        chainId: config.chainId,
        chainMode: config.chainMode,
        fromBlock: atBlock,
      });
      logger.event({
        type: "agents_registered",
        agents: agentRuntimes.map((a) => ({
          id: a.id,
          address: a.address,
          baseline: a.spec.baseline ?? false,
          description: a.spec.description,
          external: a.external,
        })),
      });
      logger.artifact(
        MANIFEST_FILENAME,
        buildManifest({
          config,
          priceFeed: priceFeedAddress,
          ...(marketRegistry
            ? {
                marketRegistry: marketRegistry.address,
                lending: marketRegistry.lending,
                marketRegistryFromBlock: marketRegistry.deployBlock,
              }
            : {}),
          participants: agentRuntimes.map((a) => ({
            id: a.id,
            address: a.address,
            external: a.external,
            baseline: a.spec.baseline ?? false,
            description: a.spec.description,
          })),
        }),
      );
      console.error(
        `[segment] rolled to ${logger.runDir} at block ${atBlock} (ADR 0021 §6)`,
      );
    };
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
          // perBase.WETH, not global: readOuParams populates an entry for every registered base, so
          // reading the global here made `market.baseVolatility: { WETH: ... }` parse, typecheck and
          // do nothing. The entry falls back to the global when the regime sets no WETH override.
          // A cexDrift episode changes the walk rather than multiplying its output (issue #56):
          // an overlay would leave the base path where it was and let mean reversion erase the
          // episode the moment the window closed. Identity outside every window, so a run without
          // one steps exactly as before.
          const ouWeth = withOuOverride(
            config.ou.perBase.WETH ?? config.ou.global,
            schedule.ouOverrideAt(blockIndex, "WETH"),
          );
          // A repricing episode moves what the walk reverts to, so the level it reached survives the
          // window instead of being pulled back to where the run started (issue #56). 1 otherwise.
          baseFair = nextFairPrice(
            baseFair,
            rng,
            fairAnchor * schedule.anchorMultiplierAt(blockIndex, "WETH"),
            ouWeth,
          );
          const overlay = schedule.at(blockIndex);
          latestFairPrice = baseFair * overlay.wethMult;
          // ADR 0013: advance extra bases with independent Rngs and distribute the effective prices into ctx.fairPrices.
          const fairPrices: Record<string, number> = { WETH: latestFairPrice };
          for (const b of extraBaseSymbols) {
            extraBaseFair[b] = nextFairPrice(
              extraBaseFair[b],
              extraPriceRng[b],
              extraAnchor[b] * schedule.anchorMultiplierAt(blockIndex, b),
              withOuOverride(
                config.ou.perBase[b] ?? config.ou.global,
                schedule.ouOverrideAt(blockIndex, b),
              ),
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

          // Point stress events (lstSlash, whale): one-shot shocks the coordinator executes,
          // placed by the same seed-driven schedule as spike/crash. Applied here, before the block's
          // other work, so what an agent observes this block already reflects them — and so the gap
          // they open against the (not yet repriced) market is the opportunity the event creates.
          //
          // The caught-up range, not just this index: onBlock skips notifications while it is busy,
          // and matching one index exactly let a dropped block swallow the whole event.
          {
            const fromIndex = Math.max(0, fromBlock - runStartBlock);
            for (const ev of schedule.pointEventsAt(fromIndex, blockIndex)) {
              if (ev.type === "lstSlash") {
                if (!lstRuntime) continue;
                try {
                  await slashLst(
                    ctx,
                    lstRuntime,
                    ev.magnitude,
                    logger,
                    oracleFee,
                  );
                } catch (error) {
                  logger.event({
                    type: "lst_slash_failed",
                    blockIndex,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              } else if (ev.type === "whale") {
                // Relayed through the ordinary flow path so the print is signed, ordered and
                // attributed exactly like any other flow order, and competes for the same block
                // space. It is not hidden: the whale trades from a dedicated address endowed during
                // setup, so an agent watching balances at block 0 can identify the wallet and its
                // capacity before any print. That is deliberate — reading the tape is part of the
                // regime — but it does mean the event is anticipatable, not just reactable.
                try {
                  const order = buildWhaleOrder(
                    ev,
                    fairPrices[ev.base] ?? latestFairPrice,
                    config.defaultPriorityFeeWei,
                  );
                  logger.event({
                    type: "stress_whale",
                    blockIndex,
                    blockNumber: bn,
                    venue: ev.venue,
                    side: ev.side,
                    base: ev.base,
                    magnitude: ev.magnitude,
                  });
                  await handleFlowOrders([order]);
                } catch (error) {
                  logger.event({
                    type: "stress_whale_failed",
                    blockIndex,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              }
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
          // LST venue (issue #38): advance the vault's economic clock one block. Accrual is
          // permissionless and its size is a pure function of blocks elapsed, so this only keeps
          // the observable rate current -- it grants the environment nothing an agent could not do
          // itself. It rides inside oracleTask rather than as its own parallel task because it
          // sends from the same admin key: two concurrent senders race on the nonce, and anvil
          // rejects the loser as "replacement transaction underpriced" (seen in a live run, which
          // left the redemption rate frozen for the whole run).
          const accrueLstTask = async (): Promise<void> => {
            if (!lstRuntime) return;
            try {
              const hash = await accrueLst(ctx, lstRuntime, {
                priorityFeeWei: oracleFee,
              });
              submittedByHash.set(hash.toLowerCase(), {
                ownerId: "oracle",
                role: "system",
                priorityFeeWei: oracleFee,
                actionType: "lstAccrue",
              });
              // Phase 2: resample the yield on its own cadence. Sent from the same key, so it is
              // sequential with the accrual above rather than racing it on the nonce.
              const apyBps = await stepLstApy(
                ctx,
                lstRuntime,
                blockIndex,
                oracleFee,
              );
              if (apyBps !== null)
                logger.event({
                  type: "lst_apy_changed",
                  blockNumber: bn,
                  apyBps,
                });
            } catch (error) {
              logger.event({
                type: "lst_accrual_failed",
                blockNumber: bn,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };

          const oracleTask = async (): Promise<void> => {
            try {
              if (economicGas) {
                // These oracle writes are independent, so run them concurrently instead of in
                // series: at high agent counts this phase is the environment loop's dominant cost
                // (it is what sizes the block time), and the calls only queue on anvil, they do not
                // depend on each other. The PriceFeed / Aave / additional-base writes are keyless
                // `anvil_setStorageAt` calls (no nonce). The GMX oracle update and the LST accrual
                // both send txs from the admin key, so they share a nonce and must stay sequential
                // with each other (two concurrent admin-key senders race and anvil drops the loser
                // as "replacement transaction underpriced"); they form one sequential sub-task that
                // runs alongside the storage writes.
                await Promise.all([
                  writePriceFeedStorage(
                    publicClient,
                    priceFeedAddress,
                    latestFairPrice,
                    BigInt(bn),
                  ),
                  writeAaveOraclesStorage(ctx, latestFairPrice),
                  ...extraBaseSymbols.map((b) =>
                    writePriceFeedStorageFor(
                      publicClient,
                      priceFeedAddress,
                      tokenInfo(b).address,
                      fairPrices[b],
                      BigInt(bn),
                    ),
                  ),
                  (async () => {
                    if (ctx.oracle.gmxProvider && ctx.updateGmxOracle) {
                      await ctx.updateGmxOracle(ctx, latestFairPrice, {
                        noMine: true,
                        priorityFeeWei: oracleFee,
                      });
                    }
                    await accrueLstTask();
                  })(),
                ]);
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
              await accrueLstTask();
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
            // LST telemetry rides on the state the loop already read: how far the market sits from
            // redemption, and whether the reward reserve is running dry. The primary post-run
            // source for whether the venue behaved (issue #38).
            const lstState = stateById.get("lst") as LstState | undefined;
            if (lstState) logger.event(lstBlockEvent(lstState, bn));
            // Liquity telemetry rides on the same read: where the peg sat, how the fee curves moved
            // and whether the system ever entered Recovery Mode (issue #39).
            const liquityState = stateById.get("liquity") as
              LiquityState | undefined;
            if (liquityState) logger.event(liquityBlockEvent(liquityState, bn));
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
                // A flowTrend episode leans the uninformed flow for the length of its window
                // (issue #56). Applied here rather than inside the bot: the bot is a separate
                // process with its own RNG, and having it rebuild the schedule would mean two
                // copies of it that can disagree.
                schedule.flowTrendAt(bn - runStartBlock),
              );
              flowProcess.pushContext(flowContext);
            }
          };

          // victim HF observation (ADR 0009 §4,7): read HF and debt only inside/near the stress event window and
          // emit to events.jsonl (source data the dashboard shows as a band; the SSE contract is unchanged). Detect
          // a debt decrease as a liquidation. Outside the window (overlay=1) it does not read, avoiding log bloat / RPC load.
          const victimTask = async (): Promise<void> => {
            if (stressVictims.length === 0) return;
            // Price events only: a liquidityPull window leaves the price where it was, and its
            // trapezoid outlasts the crash's, so gating on any active event would read health
            // factors on blocks where nothing has moved.
            const active = schedule.activePriceEventAt(blockIndex);
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

          // Agent-created markets (issue #40): find what appeared in the caught-up range and
          // publish it. Its own task because the write is on the registrar key, not admin -- and
          // sequential inside itself, because the sweep decides what the write publishes.
          const registryTask = async (): Promise<void> => {
            if (!marketRegistry) return;
            try {
              await sweepMarkets(
                ctx,
                marketRegistry,
                fromBlock,
                bn,
                environmentAddresses,
                logger,
              );
              const hash = await registerPending(
                ctx,
                marketRegistry,
                bn,
                oracleFee,
                logger,
              );
              if (hash)
                submittedByHash.set(hash.toLowerCase(), {
                  ownerId: "registry",
                  role: "system",
                  priorityFeeWei: oracleFee,
                  actionType: "marketRegister",
                });
            } catch (error) {
              logger.event({
                type: "market_registry_task_failed",
                blockNumber: bn,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };

          // Liquidity-pull stress event (issue #52): move each seeded pool toward the depth this
          // block's trapezoid asks for. Its own task rather than riding inside oracleTask because it
          // sends from the LP owner key, not the admin key, so the two cannot collide on a nonce.
          const liquidityTask = async (): Promise<void> => {
            if (!liquidityPullRuntime) return;
            try {
              const hashes = await reconcileLiquidityPull(
                ctx,
                liquidityPullRuntime,
                schedule,
                blockIndex,
                bn,
                { priorityFeeWei: oracleFee },
                logger,
              );
              for (const hash of hashes) {
                submittedByHash.set(hash.toLowerCase(), {
                  ownerId: "liquidity",
                  role: "system",
                  priorityFeeWei: oracleFee,
                  actionType: "liquidityPull",
                });
              }
            } catch (error) {
              // Distinct from liquidity.ts's per-position `stress_liquidity_pull_failed`: this one
              // means *no* position was reconciled this block, which post-run analysis has to be
              // able to tell apart from one market failing.
              logger.event({
                type: "stress_liquidity_task_failed",
                blockIndex,
                blockNumber: bn,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          };

          // Depeg stress events (issues #39 and #27 (c)): move each peg toward where this block's
          // trapezoid wants it.
          const depegStep = async (): Promise<void> => {
            // Sequential across stables as well as with the pull: they all send from the deployer
            // key, and two senders on one key race on the nonce.
            for (const { runtime, fractionAt, ownerId } of depegRuntimes) {
              try {
                const hashes = await reconcileStableDepeg(
                  ctx,
                  runtime,
                  fractionAt(blockIndex),
                  blockIndex,
                  bn,
                  { priorityFeeWei: oracleFee },
                  logger,
                );
                for (const hash of hashes) {
                  submittedByHash.set(hash.toLowerCase(), {
                    ownerId,
                    role: "system",
                    priorityFeeWei: oracleFee,
                    actionType: "depeg",
                  });
                }
              } catch (error) {
                logger.event({
                  type: `${runtime.label}_task_failed`,
                  stable: runtime.symbol,
                  blockIndex,
                  blockNumber: bn,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          };

          // Liquity ground truth (issue #39): a Trove that disappeared could have been closed,
          // redeemed away or liquidated, and only the venue's own logs say which. The open question
          // the issue leaves -- whether Liquity's ordering sensitivity needs special handling when
          // the oracle is rewritten every block ahead of every agent -- is about liquidations, so
          // they have to be counted rather than inferred from the block state.
          const liquityWatchTask = async (): Promise<void> => {
            if (!liquityRuntime || fromBlock > bn) return;
            try {
              await watchLiquityEvents(ctx, fromBlock, bn, logger);
            } catch (error) {
              logger.event({
                type: "liquity_watch_failed",
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
          if (marketRegistry) tasks.push(timed(registryTask));
          // One task for both, actually rather than by comment. Every one of these sends from the
          // deployer key, and `sendNoMine` resolves the nonce per call -- two of them in the same
          // Promise.all resolve the same pending nonce and one silently replaces the other. The
          // comment here used to claim they shared a task while the code pushed two; the crash +
          // depeg combination `alignWith` exists to express is exactly when both are live.
          const deployerKeyTask = async (): Promise<void> => {
            if (liquidityPullRuntime) await liquidityTask();
            if (depegRuntimes.length > 0) await depegStep();
          };
          if (liquidityPullRuntime || depegRuntimes.length > 0)
            tasks.push(timed(deployerKeyTask));
          if (liquityRuntime) tasks.push(timed(liquityWatchTask));
          const results = await Promise.all(tasks);

          // After the block's own work, not beside it: this reads the block that has just been
          // mined, so it cannot race anything above, and running it inside the Promise.all would
          // put a cross-section read on the critical path of every block instead of one in twelve.
          const epochMs = await timed(() => liveScorer.onBlock(bn));

          // Only while segmenting: keep blocks.csv within a block of the head, so a roll is a
          // boundary rather than a bulk scan of a whole day stalling the environment loop. A run
          // with an end keeps the single pass at the end, byte-identical to before.
          //
          // bn - 1, not bn: this block is being processed right now and the environment's own txs
          // for it are still in flight.
          const blocksMs = segments
            ? await timed(() => flushBlocks(bn - 1))
            : 0;

          // ADR 0021 §6: cut the output, never the chain. Checked after the boundary read so a
          // segment that ends on one keeps it -- the next segment carries it as its own first
          // boundary, which is what stops each segment losing an epoch at the seam.
          if (bn >= runStartBlock && segments?.dueToRoll())
            await rollSegment(bn);

          const [keeperMs, oracleMs, stateFlowMs] = results;
          let taskIdx = 3;
          const victimMs =
            stressVictims.length > 0 ? results[taskIdx++] : undefined;
          const vulnMs = vulnRuntime ? results[taskIdx++] : undefined;
          const registryMs = marketRegistry ? results[taskIdx++] : undefined;
          // One measurement now that both share a task; reported under both names so the existing
          // round_timing readers keep working.
          const deployerKeyMs =
            liquidityPullRuntime || depegRuntimes.length > 0
              ? results[taskIdx++]
              : undefined;
          const liquidityMs = liquidityPullRuntime ? deployerKeyMs : undefined;
          const depegMs = depegRuntimes.length > 0 ? deployerKeyMs : undefined;
          const liquityMs = liquityRuntime ? results[taskIdx++] : undefined;
          logger.event({
            type: "round_timing",
            blockNumber: bn,
            blocksCaughtUp: Math.max(0, bn - fromBlock + 1),
            keeperMs,
            oracleMs,
            stateFlowMs,
            ...(victimMs !== undefined ? { victimMs } : {}),
            ...(vulnMs !== undefined ? { vulnMs } : {}),
            ...(registryMs !== undefined ? { registryMs } : {}),
            ...(liquidityMs !== undefined ? { liquidityMs } : {}),
            ...(depegMs !== undefined ? { depegMs } : {}),
            ...(liquityMs !== undefined ? { liquityMs } : {}),
            // Zero on the eleven blocks in twelve that are not a boundary; the non-zero ones are
            // what live scoring costs the loop.
            ...(epochMs > 0 ? { epochMs } : {}),
            ...(blocksMs > 0 ? { blocksMs } : {}),
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
    if (!external) await setIntervalMining(publicClient, 0);

    // The last block anyone competed on, captured *before* the teardowns below. Everything after it
    // is the environment putting the chain back, and scoring across those blocks would score the
    // teardown: a depeg restore buys the stable back to par (issue #27), so an agent that never
    // unwound would be marked at par and holding through the end would cost nothing -- which is
    // exactly the risk the regime exists to create. Nothing agents did lands after this point,
    // because they were stopped one line above.
    const finalBlock = Number(await publicClient.getBlockNumber());

    // ---- liquidity-pull teardown (issue #52): the run can end with a window still open, since the
    // schedule may place it against the last block and the time limit can cut in mid-window. Restore
    // here so a shared anvil does not hand the next run a thinner venue. Agents are already stopped,
    // so this cannot be traded against.
    if (liquidityPullRuntime) {
      try {
        await restoreLiquidityPull(ctx, liquidityPullRuntime, logger);
      } catch (error) {
        logger.event({
          type: "stress_liquidity_teardown_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ---- eUSD depeg teardown (issue #39): same argument as the depth restore above, plus one more.
    // The startup check refuses to begin on a depegged pool, so a run that ended mid-window would
    // not just hand the next run a different venue -- it would stop it from starting at all.
    for (const { runtime } of depegRuntimes) {
      try {
        await restoreStableDepeg(ctx, runtime, logger);
      } catch (error) {
        logger.event({
          type: `${runtime.label}_teardown_failed`,
          stable: runtime.symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ---- blocks.csv: whatever is not yet written ----
    // The whole window for a run with an end (unchanged), the final segment's tail for a period
    // that has been flushing as it went. Finishes before resetFork erases history, and before the
    // violation check and the summary.
    await flushBlocks(finalBlock);

    // ---- scoring: batch-reconstruct the per-agent value series from historical blocks (ADR 0006 §4) ----
    let valueSeries: Record<string, unknown> = {
      source: "live-observation",
      granularityBlocks: 1,
    };
    // agent -> α (β-removed PnL versus fair at execution; ADR 0015 Notes / equivalent to the amm-challenge edge).
    let alphaByAgent: Record<string, number> = {};
    // agent -> realizable value at the last cross-section, where it differs from the mark
    // (issue #38: an LST redemption still in the queue when the run ends).
    let liquidatableValueByAgent: Record<string, number> = {};
    let epochScores: Record<string, EpochScore> | undefined;

    // ---- the score (ADR 0019), from the series read at the boundaries (ADR 0021 §3) ----
    // Taken here rather than out of the post-run sweep below, because this is the series that
    // exists on a chain the sweep cannot cover: too long for the node's history, and with no end to
    // start sweeping from. On a short run the two are the same numbers -- the same reader, the same
    // blocks, the same median window -- so nothing about a bounded run changes.
    const wholeEpochSeries = liveScorer.series();
    // The summary written here belongs to whichever directory `logger` points at -- which, when
    // segmenting, is the *final segment*, not the whole period. Scoring it over the whole series
    // gave the last day the week's epochs: every earlier segment's returns counted twice in any
    // standings taken over the period, and the last day showed a score nothing that happened on it
    // could explain (seen on a five-segment run: 9 epochs in the last segment against 1+3+2+3 in
    // the others).
    const liveEpochSeries = ((): EpochSeries | undefined => {
      if (!wholeEpochSeries || !segments) return wholeEpochSeries;
      const cut = sliceEpochSeries(
        wholeEpochSeries,
        segments.currentSegmentStartBlock,
        finalBlock,
      );
      // `epochs` has to be recomputed, not inherited. Spreading the slice over the whole series
      // replaced its blocks and values and left the period's count behind: the final segment's
      // summary said `epochs: 9` while carrying five boundaries — four returns. An artifact that
      // contradicts itself is worse than one that is missing a field.
      return {
        ...wholeEpochSeries,
        ...cut,
        epochs: Math.max(0, cut.boundaryBlocks.length - 1),
      };
    })();
    if (liveEpochSeries) {
      // ADR 0019 §2: the score is excess over the roster's baseline entry. Without one the returns
      // stay raw and every agent is charged for the drift of the ETH gas reserve it had to hold --
      // measured at 93% of an active agent's dispersion, so this is not a detail.
      if (baselineId === undefined)
        console.warn(
          "[scoring] no roster agent is marked `baseline: true`; epoch scores are raw returns, " +
            "not excess over a benchmark (ADR 0019 §2)",
        );
      epochScores = scoreEpochSeriesByAgent(liveEpochSeries.valuesByAgent, {
        ...(baselineId !== undefined ? { benchmarkId: baselineId } : {}),
      });
      logger.event({
        type: "epoch_series_scored",
        ...liveScorer.meta(),
        ...(segments
          ? {
              segment: segments.currentSegment,
              boundaries: liveEpochSeries.boundaryBlocks.length,
              periodBoundaries: wholeEpochSeries?.boundaryBlocks.length,
            }
          : {}),
      });
    }

    // The post-run sweep produces things the boundary series does not: the equity curve between
    // boundaries, alpha (which needs the first and last cross-section at a fixed reference fair),
    // the unpriced-holdings report, and the venue-state artifact the dashboard draws from. All of it
    // is worth having -- and none of it is reachable once the window outruns the node's history,
    // which is precisely the case ADR 0021 exists for. So it is attempted for a window that fits and
    // skipped, explicitly, for one that does not.
    const sweepWindow = finalBlock - runStartBlock;
    const sweepFits = sweepWindow <= HISTORY_SWEEP_LIMIT;
    if (finalBlock >= runStartBlock && !sweepFits) {
      logger.event({
        type: "post_run_sweep_skipped",
        windowBlocks: sweepWindow,
        limit: HISTORY_SWEEP_LIMIT,
        haveEpochSeries: liveEpochSeries !== undefined,
        note:
          "the run window is longer than the node retains state for, so a post-run sweep would " +
          "read zeros rather than history. The score comes from the boundaries read live (ADR 0021 §3); " +
          "the equity curve, alpha and market.json are what this costs",
      });
      console.error(
        `[reconstruct] window ${sweepWindow} blocks exceeds the ~${HISTORY_SWEEP_LIMIT}-block sweep ` +
          "limit; scoring used the live epoch boundaries and the equity curve was not rebuilt",
      );
    }
    if (finalBlock >= runStartBlock && sweepFits) {
      try {
        const meta = await reconstructValueSeries({
          publicClient,
          logger,
          agents: agentRuntimes.map((a) => ({ id: a.id, address: a.address })),
          enabledIds,
          activeStables: activeStables(),
          priceFeed: priceFeedAddress,
          fromBlock: runStartBlock,
          toBlock: finalBlock,
          scoreEvery: config.scoreEvery,
          epochBlocks: config.epochBlocks,
          markMedianBlocks: config.markMedianBlocks,
          ...(marketRegistry ? { marketRegistry: marketRegistry.address } : {}),
        });
        valueSeries = meta;
        alphaByAgent = meta.alphaByAgent;
        liquidatableValueByAgent = meta.liquidatableValueByAgent;
        logger.event({ type: "value_series_reconstructed", ...meta });
        // The claim that live scoring *replaces* the sweep rests on the two producing the same
        // number at the same boundary. On a run short enough to have both, check it rather than
        // assert it: a divergence means one of the two reads a different world, and the run that
        // discovers it should be the one that says so.
        if (liveEpochSeries && meta.epochSeries)
          logger.event({
            type: "epoch_series_agreement",
            ...compareEpochSeries(liveEpochSeries, meta.epochSeries),
          });
      } catch (err) {
        // The reconstruction refuses a cross-section it cannot read rather than emitting a cliff in
        // the value series (issue #44). Losing the series is bad; publishing a wrong one is worse —
        // so keep the run's other artifacts and make the gap explicit instead of letting
        // summary.json read as if the series were complete.
        const error = err instanceof Error ? err.message : String(err);
        valueSeries = {
          source: "post-run-reconstruction",
          failed: true,
          error,
        };
        logger.event({ type: "value_series_reconstruction_failed", error });
        console.error(`[reconstruct] value series unavailable: ${error}`);
      }

      // ---- dashboard market series (issue #63 Phase 2): venue prices/state + tx notionals ----
      // Same historical-read machinery as the value series, same window, zero live-loop cost.
      // A reporting artifact: losing it degrades the dashboard, never the run, so its failure is
      // logged and swallowed independently of scoring.
      try {
        const artifact = await reconstructMarketSeries({
          publicClient,
          agents: agentRuntimes.map((a) => ({ id: a.id, address: a.address })),
          enabledIds,
          priceFeed: priceFeedAddress,
          fromBlock: runStartBlock,
          toBlock: finalBlock,
          scoreEvery: config.scoreEvery,
        });
        logger.artifact("market.json", artifact);
        logger.event({
          type: "market_series_reconstructed",
          ...marketSeriesMeta(artifact),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.event({ type: "market_series_reconstruction_failed", error });
        console.error(`[reconstruct] market series unavailable: ${error}`);
      }
    }

    // The boundary series is the authoritative one wherever both exist, so that summary.json's
    // rounds and its scores are the same object. They agree by construction on a run the sweep
    // covers -- same reader, same blocks, same median window -- and only the live one exists on a
    // run it does not.
    if (liveEpochSeries) {
      valueSeries = {
        ...valueSeries,
        epochSeries: liveEpochSeries,
        // Nested rather than spread. `valueSeries.source` describes where the *equity curve* came
        // from, and spreading the live meta over it renamed the sweep's own artifact to
        // "live-epoch-boundaries" -- a run that did sweep, claiming it had not.
        epochSeriesMeta: liveScorer.meta(),
      };
    }

    // ---- post-run rule check (ADR 0006 §5): exceeding the fee cap is grounds for invalidating a run ----
    // Under economic gas (ADR 0011 §2), priority-fee cap enforcement is retired (agents bid freely per their
    // opportunity valuation, and whoever values it higher executes first = realistic priority gas auction) → violations is empty.
    const violations = config.economicGas
      ? []
      : checkRunFeeViolations(logger.runDir, config.maxPriorityFeeWei);

    // The environment's own shocks must not fail quietly. A whale is submitted through the ordinary
    // relay, so a *submission* error is caught and logged -- but an on-chain revert is not one: the
    // tx lands, the schedule says the whale fired, and only blocks.csv shows it did nothing. A
    // missing token approval once turned this regime into calm with every log looking healthy.
    if (whaleEvents.length > 0) {
      const whaleTxs = countRunRevertedTxs(
        logger.runDir,
        `flow-${WHALE_WALLET_KEY}`,
      );
      if (whaleTxs.reverted > 0)
        logger.event({
          type: "stress_whale_reverted",
          reverted: whaleTxs.reverted,
          total: whaleTxs.total,
          note: "whale orders landed but reverted on-chain; this regime degraded toward calm",
        });
      console.error(
        whaleTxs.reverted > 0
          ? `[stress] WARNING: ${whaleTxs.reverted}/${whaleTxs.total} whale orders reverted on-chain — ` +
              `the whale regime did not actually shock this run`
          : `[stress] ${whaleTxs.total} whale orders executed`,
      );
    }
    if (config.economicGas) {
      logger.event({
        type: "fee_cap_enforcement_disabled",
        note: "ADR 0011 §2: the economic gas profile does not enforce a priority-fee cap",
      });
    } else if (violations.length > 0) {
      logger.event({ type: "rule_violations_detected", violations });
    }

    // Gas budget (issue #40 T0). Checked whatever the fee profile is: the fee cap is about ordering
    // and is deliberately unenforced under economic gas, but starving the block is about capacity
    // and is a disqualifying offence either way (rules §6 / §8).
    const gasViolations = checkRunGasViolations(logger.runDir, {
      maxTxGas: config.maxTxGas,
      maxAgentBlockGas: config.maxAgentBlockGas,
    });
    if (gasViolations.length > 0) {
      logger.event({ type: "gas_budget_violations", violations: gasViolations });
      const offenders = [...new Set(gasViolations.map((v) => v.ownerId))];
      console.error(
        `[rules] ${gasViolations.length} gas-budget violation(s) by ${offenders.join(", ")} ` +
          `(per-tx ${config.maxTxGas}, per-agent-per-block ${config.maxAgentBlockGas}); ` +
          "see gas_budget_violations in events.jsonl",
      );
    }

    // ---- final PnL ----
    const finalFairPrice = latestFairPrice;
    // Price every registered base, not just WETH. valueUsdc marks an unlisted base at `p[sym] ?? 0`,
    // so passing the scalar WETH price valued an agent's WBTC at exactly zero: anyone holding a
    // non-WETH base at the last block had that inventory deleted from netPnlUsdc. Measured on a
    // 24-agent calm run, the WBTC-trading agents reported a reproducible -6,686 USDC "loss" while the
    // reconstruction (which does price every base since issue #41) put the same agents at +13 alpha.
    // ctx.fairPrices is the per-base map the block loop already maintains; the WETH-only fallback is
    // for a run that ended before the first block was processed.
    const finalFairPrices: Record<string, number> =
      ctx.fairPrices && Object.keys(ctx.fairPrices).length > 0
        ? ctx.fairPrices
        : { WETH: finalFairPrice };
    // Issue #27: what each market-priced stable settles at, at the last block. The initial
    // valuation uses the same prices for the same reason the fair prices are shared -- netPnlUsdc is
    // a difference, and pricing the two ends off different marks would book a peg's whole history
    // as this agent's PnL. Nothing is endowed in a market-priced stable, so the initial snapshot
    // holds none of them and the choice only bites on a run that ends mid-depeg.
    const finalStablePrices = await readStablePrices(
      publicClient,
      activeStables(),
      // At the last competition block, for the same reason the reconstruction stops there.
      BigInt(finalBlock),
    );
    const agentsSummary = [];
    for (const agent of agentRuntimes) {
      const final = await getBalances(publicClient, agent.address);
      const initialValue = valueUsdc(
        agent.initial,
        finalFairPrices,
        finalStablePrices,
      );
      let finalValue = valueUsdc(final, finalFairPrices, finalStablePrices);
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
        // What the position could actually be exited for at the run's last block, when the
        // reconstruction found that it differs from the mark at that same cross-section (issue
        // #38: an LST redemption whose queue outlives the run). Absent for every venue that exits
        // at par, which is all of them today.
        ...(agent.id in liquidatableValueByAgent
          ? { liquidatableValueUsdc: liquidatableValueByAgent[agent.id] }
          : {}),
        // Present only when the agent process went away before the run ended (ADR 0017 §4 reads this
        // to disqualify the agent for that scenario instead of scoring its frozen position).
        ...(agent.exitedEarly !== undefined
          ? { processExitedEarly: agent.exitedEarly }
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
      // Which world shape produced these numbers (ADR 0020 §1). Recorded on every run so an
      // aggregation across stored runs can refuse to mix the modes instead of averaging two
      // different competitions together.
      resetUnit: config.resetUnit,
      blockTimeSec: config.blockTimeSec,
      blocksProcessed: processedBlocks,
      elapsedMs,
      finalFairPriceUsdcPerWeth: finalFairPrice,
      valueSeries,
      // ADR 0019's score, derived from the epoch series in the same summary so it can be recomputed
      // when lambda or the epoch length changes. The denominator is this run's epoch count: every
      // agent shares the boundaries here, which is what "fixed across the field" asks for (the live
      // competition pins it at 42 because a participant can join or die mid-week).
      ...(epochScores ? { epochScores } : {}),
      violations,
      // Kept apart from `violations` rather than merged into it: the fee cap is about ordering and
      // the gas budget is about capacity, they have different enforcement and different remedies,
      // and a reader counting "violations" across old and new runs must not see the number change
      // meaning (issue #40 T0).
      ...(gasViolations.length > 0 ? { gasViolations } : {}),
      agents: agentsSummary,
    });
    // The last segment closes with the same index entry every other one got, so a period that ended
    // is a complete list of days rather than a list missing its last (ADR 0021 §6). Its own
    // summary.json is the one written just above -- the whole-run summary *is* the final segment's,
    // since that is the directory `logger` points at.
    if (segments)
      segments.finish(
        finalBlock,
        agentsSummary.map((a) => ({
          id: a.id,
          address: a.address,
          netPnlUsdc: a.netPnlUsdc,
          alphaUsdc: a.alphaUsdc ?? 0,
          score: epochScores?.[a.id]?.score ?? 0,
          initialValueUsdc: a.initialValueUsdc,
          finalValueUsdc: a.finalValueUsdc,
        })),
      );
    logger.event({ type: "run_completed", runId, runDir: logger.runDir });
    console.error(
      `realtime simulation completed: ${logger.runDir} (${processedBlocks} blocks, ${Math.round(elapsedMs / 1000)}s)`,
    );
  } finally {
    try {
      if (config.chainMode !== "external")
        await setIntervalMining(publicClient, 0);
    } catch {
      // ignore errors during teardown
    }
    for (const agent of agentRuntimes) agent.process?.close();
    flowProcess.close();
  }
  return { runId, runDir: logger.runDir };
}
