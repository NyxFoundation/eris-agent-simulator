// Contract layer for run config (ADR 0015). Placing the SimConfig type and the env→SimConfig
// loadConfig in the sdk lets both the environment (core) and the agent runtime
// (example/agents/runtime) rebuild identical config from the same YAML (ERIS_CONFIG).
//
// Environment-only config (stress/vuln event schedule definitions, the agent roster) is extended on
// the core side (RealtimeConfig / validateAgentsFile in core/src/config.ts).
import { keccak256, stringToBytes, type Hex } from "viem";
import { CHAIN_ID, DEFAULT_ANVIL_PRIVATE_KEYS } from "./constants.js";
import type { ProtocolId } from "./types.js";
import type { OuParams } from "./rng.js";
import { baseTokens } from "./markets.js";

// The lst and liquity venues are deliberately not in the default set: they exist only under local
// deploy (issues #38 / #39), so defaulting either on would break every fork run. Enable them
// explicitly via run.protocols.
const ALL_PROTOCOLS: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "gmx",
  "aave",
];

// Protocols that can be named in run.protocols but are not in the default set.
// Venues a run only gets when it names them. `lending` joins lst/liquity for the same reason -- the
// singleton is ours, so there is nothing to point at on a fork -- and for one more: it only exists
// at all when `agentMarkets.enabled` is on, which the coordinator checks and fails fast on.
const OPT_IN_PROTOCOLS: ProtocolId[] = ["lst", "liquity", "lending"];

export type OuConfig = {
  global: OuParams;
  perBase: Record<string, OuParams>;
};

// ADR 0020 §1. The two shapes a competition can have: one economy run end to end, or a matrix of
// (regime, seed) worlds each started from a clean slate.
export type ResetUnit = "continuous" | "scenario";

// Parsed rather than coerced: a typo silently falling back to "continuous" would label a scenario
// run as a continuous one, and the two are not comparable (ADR 0020 Negative "どちらの数字か分からない").
function resetUnitEnv(value: string | undefined): ResetUnit {
  if (value === undefined || value === "") return "continuous";
  if (value === "continuous" || value === "scenario") return value;
  throw new Error(
    `run.resetUnit must be "continuous" or "scenario" (got "${value}") — ADR 0020 §1`,
  );
}

// Who owns the node the run talks to (issue #33 / ADR 0021 §7). `anvil` is a dev node the
// environment drives with cheatcodes; `external` is a real client (the OP Stack devnet of #35),
// where the sequencer produces blocks and nothing can be conjured.
export type ChainMode = "anvil" | "external";

function chainModeEnv(value: string | undefined): ChainMode {
  if (value === undefined || value === "") return "anvil";
  if (value === "anvil" || value === "external") return value;
  throw new Error(
    `run.chainMode must be "anvil" or "external" (got "${value}") — issue #33`,
  );
}

export type SimConfig = {
  rpcUrl: string;
  // Where reads go. Same as rpcUrl unless the chain is served by a sequencer plus a read replica,
  // which is the architecture decision #36 measures: Eris's load is read-heavy (every agent rebuilds
  // its observation each block), and a sequencer that also answers those reads is the thing that
  // jitters block production. Splitting the two is a config change here and a deployment change
  // there, so the seam exists before the measurement rather than after it.
  readRpcUrl: string;
  chainId: number;
  // issue #33 / ADR 0021 §7. Set from `run.chainMode`; the coordinator installs it into the sdk's
  // chain module (setChainMode) so every cheatcode entry point can refuse rather than fail silently.
  chainMode: ChainMode;
  // The account that funds everything on an external chain (issue #33 (1)): genesis prefunds it, and
  // it sends ETH and mints/transfers tokens to the agent, flow and admin wallets. Unused in anvil
  // mode, where balances are assigned with a cheatcode.
  treasuryPrivateKey?: Hex;
  // Native balance the treasury tops the admin and keeper wallets up to on an external chain
  // (ERIS_EXTERNAL_ROLE_ETH_WEI). In anvil mode they are simply assigned 2,000,000 ETH, which is not
  // a number a genesis alloc can hand out over and over; on a chain that runs for a week this is a
  // real budget and the top-up is incremental.
  externalRoleEthWei: bigint;
  // Upstream RPC to fork from (ARB_RPC_URL). When set, resetFork calls anvil_reset with a forking
  // config to rebuild the fork state clean each time (avoiding the anvil_reset [] problem where
  // positions such as Aave persist across runs/seeds). If unset, falls back to the legacy
  // anvil_reset [].
  forkUrl?: string;
  // Re-fork target block (FORK_BLOCK_NUMBER). Pinning it makes reruns fully reproducible.
  // If unset, the first resetFork captures latest and reuses it for subsequent resets.
  forkBlockNumber?: number;
  // Seed-derived victim cohort that makes liquidations possible (WETH supply + USDC borrow, HF≈H0). Not scored.
  // count=0 (default) disables it. When >0, aave enabled + full re-fork (ARB_RPC_URL required) is a precondition (ADR 0009 §4).
  stressVictimCount: number; // ERIS_STRESS_VICTIM_COUNT
  stressVictimHf0: number; // ERIS_STRESS_VICTIM_HF0 (target initial HF. default 1.10. must exceed LT/(0.97·LTV)≈1.08)
  stressVictimSupplyWethWei: bigint; // ERIS_STRESS_VICTIM_WETH_WEI (supply per victim. default 5)
  // Approximate one-sided liquidity to seed each vuln pool with (in USDC-denominated units). The deeper it is,
  // the less an agent's trade moves the price, so the bait becomes realized profit. ERIS_VULN_POOL_LIQUIDITY_USDC_UNITS (default 2,000,000 USDC).
  vulnPoolLiquidityUsdcUnits: bigint;
  // Trading fee of the vuln pool (bps). Small enough that fees do not cancel out an honest pool's bait.
  // ERIS_VULN_POOL_FEE_BPS (default 30 = 0.3%).
  vulnPoolFeeBps: number;
  // Enables the pre-trade LLM source audit (ADR 0014 §4-2). "0" (default off) / "1" (real LLM) / "mock"
  // (a stub that scans source for keywords). The coordinator distributes it to discovery-arb-verify via ERIS_VULN_LLM.
  // Scoring uses the environment's ground truth, so the LLM is auxiliary (its verdict is a reference log). The dry-run is the primary check.
  vulnLlm: string;
  // ---- agent-created markets (issue #40) ----
  // Whether the environment deploys the MarketRegistry + the permissionless lending singleton and
  // sweeps for agent-deployed contracts. Off by default: it adds a per-block getLogs and a block
  // fetch, and a run that nobody deploys into should not pay for them.
  agentMarkets: boolean;
  // How many discoveries the environment publishes per block. The deploy is paid by the agent
  // (ADR 0011) but the registry write is paid by the environment, so without a cap a deploy-spam
  // agent inflates that cost without bound. The overflow carries into the next block rather than
  // being dropped, factory-made kinds first.
  agentMarketsPerBlockCap: number;
  // Gas ceiling on a single agent transaction, and on one agent's transactions within one block
  // (issue #40 T0). Rules section 5 caps the *number* of transactions per block, not their gas, so a
  // contract that eats the block gas limit can starve other participants and the environment's own
  // oracle update. 0 disables the check. Detection is post-run over blocks.csv, the same mechanical
  // shape as the priority-fee cap; the RPC gateway refuses over-cap transactions up front.
  maxTxGas: bigint;
  maxAgentBlockGas: bigint;
  // Flash arb demo (GitHub #3). With ERIS_FLASH_ARB=1 the coordinator deploys the FlashArb contract
  // and makes it available to the flash-arb agent. Requires uniswap+balancer+aave enabled. Default off.
  flashArbDemo: boolean;
  // Real-time mode (core/src/realtime/coordinator.ts). The interval-mining block interval (seconds)
  // and the run's stop condition (wall-clock time or block count).
  blockTimeSec: number;
  runSeconds: number;
  runBlocks: number;
  // Skip the resetFork at run start (default false). Preserves anvil's fork fetch cache from the
  // previous run for diagnostics that isolate cold-fetch latency (upstream fetches during mining).
  // State persists from the previous run, so do not use for evaluation (ERIS_SKIP_RESET=1).
  skipReset: boolean;
  // Mode that uses a locally (non-fork) deployed anvil (ERIS_LOCAL_DEPLOY=1). With no fork, inter-run
  // reset uses evm_snapshot/evm_revert instead of anvil_reset. Addresses overlay
  // constants.local.ts (generated by gen:local-constants). With no fork upstream, pinning
  // FORK_BLOCK_NUMBER, whales, etc. are unnecessary.
  localDeploy: boolean;
  // Persistence file for the local-mode snapshot ID (shares the clean cross-section cross-process).
  localSnapshotFile: string;
  // The run's execution mode (a label stamped into summary.json's mode. ADR 0016 §6). The backtest CLI
  // injects ERIS_RUN_MODE=backtest. Does not affect scoring or behavior.
  runMode: "realtime" | "backtest";
  // The world's reset unit (ERIS_RESET_UNIT / `run.resetUnit`. ADR 0020 §1). `continuous` is one world
  // for the whole run (what sim:realtime does); `scenario` is a fresh world per (regime, seed), which
  // only the scenario-matrix runner can produce -- the competition itself runs in `scenario` (ADR 0020 §2).
  // It is a label, not a switch: nothing here resets anything. It exists so a stored run says which
  // mode produced it, because the two are not comparable (the epoch count per world differs, and
  // lambda is calibrated per mode -- ADR 0020 Negative).
  resetUnit: ResetUnit;
  // Before the competition starts, run a market loop of N blocks with only the flow bot to warm the
  // protocols' working set (ADR 0006 Risks anvil cold-fetch mitigation). The competition-phase mine
  // then avoids hitting upstream fetches. 0 disables it (ERIS_PREWARM_BLOCKS).
  prewarmBlocks: number;
  // Fair-price OU parameters (market.* in YAML). `global` is the default and the WETH path; `perBase`
  // resolves each registered base, falling back to the global value. A regime sets these to be a
  // regime -- e.g. cex-drift is a nonzero `drift` with a weak `kappa` (ADR 0017 regime 1).
  ou: OuConfig;
  // Reconstruct the value cross-section only every Nth block instead of every block (ERIS_SCORE_EVERY).
  // The final score reads only the first and last cross-sections (alphaByAgent = alphaLast - alphaFirst),
  // so thinning does not change any agent's score -- it only coarsens the equity curve written to
  // events.jsonl. The first and last blocks are always read. 1 (default) = every block.
  // Used to cut reconstruction cost when replaying a whole scenario matrix (ADR 0017 §3).
  scoreEvery: number;
  // Length of a scoring epoch in blocks (ERIS_EPOCH_BLOCKS; 0 disables the series). ADR 0019 scores a
  // log-return series sampled at epoch boundaries rather than the run's endpoints. On the live chain a
  // boundary is a real-time 4h mark, but an anvil run has no simulated clock, so the calibration
  // harness counts blocks: 12/epoch, which leaves room for G7's per-boundary median window and keeps a
  // 42-epoch week (504 blocks) inside anvil's ~1,050 block history retention (ADR 0019 §8).
  epochBlocks: number;
  // Note: `run.epochSeconds` has no field of its own. It is consumed where it is resolved, by
  // resolveEpochBlocks below, and reaching this object as a second unread copy only invited a reader
  // to use the wrong one.
  //
  // Wall-clock hours per output segment (ERIS_SEGMENT_HOURS; 0 = one directory for the whole run,
  // which is every run today). ADR 0021 §6: the chain stays continuous and only the artifacts are
  // cut, because a week of events.jsonl is a file nobody can open and a viewer should not have to
  // read Monday to see Friday.
  segmentHours: number;
  // Display name for the segmented period ("practice week 1"). Falls back to the run id.
  segmentName: string;
  // G7 window (ERIS_MARK_MEDIAN_BLOCKS): how many blocks, the boundary included, the manipulable
  // marks are medianed over when an epoch boundary is valued. <= 1 marks boundaries live.
  // 5 of a 12-block epoch is provisional -- the ADR leaves N to be set against the epoch length once
  // the harness has run (ADR 0019 "not yet decided"). Longer resists a held push better but drags
  // legitimate late-epoch moves into the mark.
  markMedianBlocks: number;
  seed: number;
  runDirRoot: string;
  agentTimeoutMs: number;
  agentsConfigPath: string;
  // Root of the agent directory convention (ADR 0015 §2/§6). A roster id corresponds to a directory
  // name directly under this, and spawn is always <agentsDir>/runtime/bot.ts (explicit command overrides).
  agentsDir: string;
  initialEthWei: bigint;
  flowEthWei: bigint;
  // Initial base inventory for the flow wallet (non-spread). Lets flow post "sells" (price down)
  // even under USDC-only = enables two-way drift. Not granted to agents (agents stay USDC-only/no-beta).
  // Default 0 = as before (flow also has no base).
  flowWethWei: bigint;
  flowBaseAmounts: Record<string, bigint>;
  initialWethWei: bigint;
  // ADR 0013: base symbol -> initial distribution amount (token units). WETH equals initialWethWei
  // for compatibility. Additional bases are read from INITIAL_<SYM>_<UNIT> (e.g. INITIAL_WBTC_SATS),
  // defaulting to 0 (USDC-only policy = additional bases granted none by default). Under the fork default (WETH only) it is the single entry {WETH:...}.
  initialBaseAmounts: Record<string, bigint>;
  initialUsdcUnits: bigint;
  defaultPriorityFeeWei: bigint;
  maxPriorityFeeWei: bigint;
  // Turn gas into an economic cost (ADR 0011, supersedes ADR 0010). When true, retire priority-fee
  // cap enforcement and move the environment's price finalization from mempool txs (cap+premium
  // ordering) to a direct storage write of the PriceFeed/Aave oracles (cheatcode), making it
  // cap-independent. Agents freely stack priority fee per their opportunity assessment, and whoever
  // values it highest fills first (realistic priority gas auction). Default false fully reproduces
  // the ADR 0010 profile (the rollback target). Per-run switch (ERIS_ECONOMIC_GAS).
  economicGas: boolean;
  uninformedFlowMaxWethWei: bigint;
  // Uninformed flow count per block per venue (default 1). >1 gives hybrid alpha.
  uninformedFlowCount: number;
  // How many blocks the uninformed direction persists (default 1). >1 mimics order-flow imbalance and naturally produces a spread.
  uninformedFlowPersistBlocks: number;
  // Probability [0,1] that a venue's persisted uninformed direction follows the market-wide one
  // instead of its own (UNINFORMED_FLOW_TREND_CORRELATION). 0 (default) = independent per venue,
  // which manufactures a cross-venue spread; 1 = the whole market leans the same way, which is what
  // the informed-flow regime is (ADR 0017 regime 2). Only bites when uninformedPersistBlocks > 1.
  uninformedFlowTrendCorrelation: number;
  informedFlowMaxWethWei: bigint;
  enabledProtocols: ProtocolId[];
  // Size of the Aave borrower pool's target debt (USDC units). Environment machinery, not an agent
  // rule: the flow actors size their positions off it. It used to be `limits.aaveBorrowUsdcUnits`,
  // doing double duty as the agent cap; when the agent caps went away it moved into `flow` so that
  // removing a rule did not silently re-calibrate the background market.
  aaveFlowBorrowUsdcUnits: bigint;
  balancerFlowMaxWethWei: bigint;
  curveFlowMaxWethWei: bigint;
  gmxFlowMaxSizeUsd: bigint;
  // Per-block probability of emitting gmx flow (0..1, default 0.5). Sent sporadically.
  gmxFlowActivityProb: number;
  // Max number of gmx orders emitted on a firing block (>=1, default 2). >1 bursts 1..N randomly.
  gmxFlowMaxBurst: number;
  aaveFlowMaxWethWei: bigint;
  // Per-block probability each aave flow actor acts (0..1, default 0.5). <1 makes it intermittent.
  aaveFlowActivityProb: number;
  // Number of independent actors in the aave borrower pool (>=1, default 4). Max simultaneous borrows per block = this value.
  // Each actor keeps a persistent position at its own address, and debt remains into subsequent blocks.
  aaveFlowActorCount: number;
  // ADR 0015 Notes / amm-challenge: threshold (bps) that makes informed (arbitrage) flow fee-aware.
  // Default 30bps = on (emit informed flow only when the gap exceeds the fee band, and only for the
  // excess; the remainder = fee. Same economics as real arbitrage, so the market is not over-tightened).
  // 0 reverts to the legacy gap-linear informed flow.
  informedArbFeeBps: number;
  // ADR 0015 Notes / amm-challenge retail: Poisson(λ) uninformed arrivals with lognormal sizes.
  // Default λ=0.9 = on (count per block is Poisson(λ), each size is lognormal (mean = uninformedMax×0.5,
  // σ=uninformedFlowSizeSigma) = bursty, heavy-tailed realistic flow). 0 reverts to the legacy fixed count + uniform.
  // Note: variance rises, so read run comparisons as an aggregate over multiple seeds.
  uninformedFlowArrivalRate: number;
  uninformedFlowSizeSigma: number;
  // Extends amm-challenge retail to GMX/Aave.
  // gmxFlowArrivalRate: >0 makes GMX open counts Poisson(λ) and sizes lognormal (default 0.75=on). 0 = legacy.
  // gmxFlowSizeSigma: σ of the GMX lognormal size (default 1.0).
  // aaveFlowActorSizeSigma: >0 makes each Aave actor's target collateral lognormal-heterogeneous (whale/minnow. default 1.0).
  gmxFlowArrivalRate: number;
  gmxFlowSizeSigma: number;
  aaveFlowActorSizeSigma: number;
  // ADR 0013: per-leg AMM flow cap for non-WETH bases (base units). Empty/0 default = WBTC flow off.
  baseFlowMax: Record<string, bigint>;
  // ---- LST venue (issue #38) ----
  // Yield runs on a compressed *economic* clock rather than EVM time: one block stands for this
  // many seconds of staking. EVM time is deliberately not warped for it (that would also move
  // Aave's accrual and GMX funding).
  lstSimulatedSecondsPerBlock: number;
  // Target APY in bps on that clock. Kept the same order as the Aave WETH supply rate on purpose:
  // a 1000x-speed LST would make every other venue irrelevant.
  lstApyBps: number;
  // Issue #38 phase 2: when set to a [min,max] bps pair, the APY is resampled from it every
  // lstApyStepBlocks using a seed-derived Rng, instead of holding lstApyBps for the whole run.
  // Without variation the optimum is "stake everything at block 0" and the venue has no decision
  // in it. Empty (the default) keeps the fixed rate.
  lstApyRangeBps: [number, number] | null;
  lstApyStepBlocks: number;
  // Queued WETH the vault can finalize per block. 0 leaves whatever the deploy baked in, and a
  // deploy default of 0 means no limit -- every request waits exactly the delay. With a limit, the
  // wait grows with your own size and with whatever is queued ahead of you.
  lstQueueThroughputWeiPerBlock: bigint;
  // Blocks between requesting a redemption and being able to claim it (the queue's time cost).
  // 0 leaves whatever the deploy baked in.
  lstWithdrawalDelayBlocks: number;
  // Launch command and deterministic seed for the orderflow bot (a separate process).
  flowBotCommand: string;
  flowBotArgs: string[];
  flowSeed: number;
  privateKeys: {
    agent0: Hex;
    agent1: Hex;
    agent2: Hex;
    agent3: Hex;
    agent4: Hex;
    agent5: Hex;
    agent6: Hex;
    uninformedFlow: Hex;
    informedFlow: Hex;
    setup: Hex;
    admin: Hex;
    keeper: Hex;
  };
};

export function loadConfig(env = process.env): SimConfig {
  const anvilPort = env.ANVIL_PORT ?? "8545";
  // Under economization (ADR 0011), squeeze the endowment to make gas a real cost. If INITIAL_ETH_WEI
  // is unset, default to a modest placeholder (3 ETH) (makes gas a meaningful cost against opportunity
  // value while the runtime gas manager + lower-bound validation prevent running out of gas). The final
  // value is decided by calibration measurement (ADR "not yet decided"). The default 0010 profile
  // (economicGas=false) stays at 100 ETH unchanged.
  const economicGas = env.ERIS_ECONOMIC_GAS === "1";
  const initialEthWeiDefault = economicGas
    ? 3_000_000_000_000_000_000n
    : 100_000_000_000_000_000_000n;
  // Existing WETH env value (read once here for compatibility and reused for the per-base map's WETH entry).
  const initialWethWei = bigintEnv(
    env.INITIAL_WETH_WEI,
    10_000_000_000_000_000_000n,
  );
  const rpcUrl = env.ANVIL_RPC_URL ?? `http://127.0.0.1:${anvilPort}`;
  const blockTimeSec = intEnv(env.ERIS_BLOCK_TIME_SEC, 2);
  return {
    rpcUrl,
    readRpcUrl:
      env.ERIS_READ_RPC_URL && env.ERIS_READ_RPC_URL.trim() !== ""
        ? env.ERIS_READ_RPC_URL.trim()
        : rpcUrl,
    chainId: intEnv(env.CHAIN_ID, CHAIN_ID),
    chainMode: chainModeEnv(env.ERIS_CHAIN_MODE),
    treasuryPrivateKey:
      env.TREASURY_PRIVATE_KEY && env.TREASURY_PRIVATE_KEY.trim() !== ""
        ? hexEnv(env.TREASURY_PRIVATE_KEY, "")
        : undefined,
    externalRoleEthWei: bigintEnv(
      env.ERIS_EXTERNAL_ROLE_ETH_WEI,
      50_000_000_000_000_000_000n,
    ),
    forkUrl:
      env.ARB_RPC_URL && env.ARB_RPC_URL.trim() !== ""
        ? env.ARB_RPC_URL.trim()
        : undefined,
    forkBlockNumber:
      env.FORK_BLOCK_NUMBER && env.FORK_BLOCK_NUMBER.trim() !== ""
        ? intEnv(env.FORK_BLOCK_NUMBER, 0)
        : undefined,
    stressVictimCount: intEnv(env.ERIS_STRESS_VICTIM_COUNT, 0),
    stressVictimHf0: floatEnv(env.ERIS_STRESS_VICTIM_HF0, 1.1),
    stressVictimSupplyWethWei: bigintEnv(
      env.ERIS_STRESS_VICTIM_WETH_WEI,
      5_000_000_000_000_000_000n,
    ),
    vulnPoolLiquidityUsdcUnits: bigintEnv(
      env.ERIS_VULN_POOL_LIQUIDITY_USDC_UNITS,
      2_000_000_000_000n,
    ),
    vulnPoolFeeBps: intEnv(env.ERIS_VULN_POOL_FEE_BPS, 30),
    vulnLlm: env.ERIS_VULN_LLM ?? "0",
    agentMarkets: env.ERIS_AGENT_MARKETS === "1",
    agentMarketsPerBlockCap: intEnv(env.ERIS_AGENT_MARKETS_CAP, 8),
    // 30,000,000: the number the agent runtime has always self-limited to (send.ts), promoted to
    // the config so the runtime, the RPC gateway and the post-run check all read one value instead
    // of three that can drift apart. It is ~10x the heaviest real operation and well under the
    // 320,000,000 block gas limit the rules fix.
    maxTxGas: bigintEnv(env.ERIS_MAX_TX_GAS, 30_000_000n),
    // 3 x maxTxGas: the per-block transaction cap (rules §2.6) times the per-transaction ceiling.
    // An agent that uses its whole allowance can therefore take at most 90/320 of a block, which
    // leaves room for the environment's oracle write and for everybody else.
    maxAgentBlockGas: bigintEnv(env.ERIS_MAX_AGENT_BLOCK_GAS, 90_000_000n),
    flashArbDemo: env.ERIS_FLASH_ARB === "1",
    // Real-time mode settings.
    blockTimeSec,
    runSeconds: intEnv(env.ERIS_RUN_SECONDS, 20),
    runBlocks: intEnv(env.ERIS_RUN_BLOCKS, 0),
    skipReset: env.ERIS_SKIP_RESET === "1",
    localDeploy: env.ERIS_LOCAL_DEPLOY === "1",
    localSnapshotFile: env.ERIS_LOCAL_SNAPSHOT_FILE ?? ".local-snapshot",
    runMode: env.ERIS_RUN_MODE === "backtest" ? "backtest" : "realtime",
    resetUnit: resetUnitEnv(env.ERIS_RESET_UNIT),
    prewarmBlocks: intEnv(env.ERIS_PREWARM_BLOCKS, 0),
    ou: readOuParams(env),
    scoreEvery: Math.max(1, intEnv(env.ERIS_SCORE_EVERY, 1)),
    epochBlocks: resolveEpochBlocks(env, blockTimeSec),
    segmentHours: Math.max(0, floatEnv(env.ERIS_SEGMENT_HOURS, 0)),
    segmentName: env.ERIS_SEGMENT_NAME ?? "",
    markMedianBlocks: Math.max(0, intEnv(env.ERIS_MARK_MEDIAN_BLOCKS, 5)),
    seed: intEnv(env.SEED, 1),
    runDirRoot: env.REPORT_DIR ?? "./runs",
    agentTimeoutMs: intEnv(env.AGENT_TIMEOUT_MS, 5000),
    agentsConfigPath: env.AGENTS_CONFIG ?? "config/example.yaml",
    agentsDir: env.ERIS_AGENTS_DIR ?? "example/agents",
    initialEthWei: bigintEnv(env.INITIAL_ETH_WEI, initialEthWeiDefault),
    // Background orderflow is environment machinery, not a competitor. Give it
    // ample gas so long runs do not silently lose market flow as wallets run dry.
    flowEthWei: bigintEnv(
      env.ERIS_FLOW_ETH_WEI,
      1_000_000_000_000_000_000_000n,
    ),
    flowWethWei: bigintEnv(env.FLOW_WETH_WEI, 0n),
    flowBaseAmounts: readBaseAmounts(env, "FLOW_BASE", {}),
    initialWethWei,
    initialBaseAmounts: readBaseAmounts(env, "INITIAL", {
      WETH: initialWethWei,
    }),
    initialUsdcUnits: bigintEnv(env.INITIAL_USDC_UNITS, 25_000_000_000n),
    defaultPriorityFeeWei: bigintEnv(
      env.DEFAULT_PRIORITY_FEE_WEI,
      100_000_000n,
    ),
    maxPriorityFeeWei: bigintEnv(env.MAX_PRIORITY_FEE_WEI, 5_000_000_000n),
    economicGas,
    uninformedFlowMaxWethWei: bigintEnv(
      env.UNINFORMED_FLOW_MAX_WETH_WEI,
      1_000_000_000_000_000_000n,
    ),
    uninformedFlowCount: intEnv(env.UNINFORMED_FLOW_COUNT, 1),
    uninformedFlowPersistBlocks: intEnv(env.UNINFORMED_FLOW_PERSIST_BLOCKS, 1),
    uninformedFlowTrendCorrelation: Math.min(
      1,
      Math.max(0, floatEnv(env.UNINFORMED_FLOW_TREND_CORRELATION, 0)),
    ),
    informedFlowMaxWethWei: bigintEnv(
      env.INFORMED_FLOW_MAX_WETH_WEI,
      2_000_000_000_000_000_000n,
    ),
    enabledProtocols: parseEnabledProtocols(env.ENABLED_PROTOCOLS),
    aaveFlowBorrowUsdcUnits: bigintEnv(
      env.AAVE_FLOW_BORROW_USDC_UNITS,
      5_000_000_000n,
    ),
    balancerFlowMaxWethWei: bigintEnv(
      env.BALANCER_FLOW_MAX_WETH_WEI,
      1_000_000_000_000_000_000n,
    ),
    curveFlowMaxWethWei: bigintEnv(
      env.CURVE_FLOW_MAX_WETH_WEI,
      1_000_000_000_000_000_000n,
    ),
    gmxFlowMaxSizeUsd: bigintEnv(
      env.GMX_FLOW_MAX_SIZE_USD,
      20_000n * 10n ** 30n,
    ),
    // Per-block probability of emitting gmx flow (default 0.5). Decided each block via rng, sent sporadically.
    gmxFlowActivityProb: floatEnv(env.GMX_FLOW_ACTIVITY_PROB, 0.5),
    // Max number of gmx orders emitted on a firing block (default 2). Bursts 1..N randomly.
    gmxFlowMaxBurst: intEnv(env.GMX_FLOW_MAX_BURST, 2),
    aaveFlowMaxWethWei: bigintEnv(
      env.AAVE_FLOW_MAX_WETH_WEI,
      2_000_000_000_000_000_000n,
    ),
    // Per-block probability each aave flow actor acts (default 0.5). <1 makes it intermittent.
    aaveFlowActivityProb: floatEnv(env.AAVE_FLOW_ACTIVITY_PROB, 0.5),
    // Number of independent actors in the aave borrower pool (default 4). Max simultaneous borrows per block = this value.
    aaveFlowActorCount: Math.max(1, intEnv(env.AAVE_FLOW_ACTOR_COUNT, 4)),
    // amm-challenge arbitrage fee boundary (default 30bps = on. Real arbitrage does not take a gap
    // below the fee; matched to the venue fee ~30bps). 0 disables it = revert to the legacy gap-linear informed flow.
    informedArbFeeBps: Math.max(0, intEnv(env.ERIS_INFORMED_ARB_FEE_BPS, 30)),
    // amm-challenge retail arrivals (default λ=0.9 = on. Poisson arrivals + lognormal sizes = bursty,
    // heavy-tailed realistic flow. Calibrated to roughly the same mean as the legacy fixed count). 0 disables it = revert to fixed count + uniform.
    uninformedFlowArrivalRate: Math.max(
      0,
      floatEnv(env.ERIS_UNINFORMED_ARRIVAL_RATE, 0.9),
    ),
    uninformedFlowSizeSigma: Math.max(
      0,
      floatEnv(env.ERIS_UNINFORMED_SIZE_SIGMA, 1),
    ),
    // Extends amm-challenge retail to GMX/Aave (default on. 0 reverts to legacy behavior).
    gmxFlowArrivalRate: Math.max(0, floatEnv(env.ERIS_GMX_ARRIVAL_RATE, 0.75)),
    gmxFlowSizeSigma: Math.max(0, floatEnv(env.ERIS_GMX_SIZE_SIGMA, 1)),
    aaveFlowActorSizeSigma: Math.max(
      0,
      floatEnv(env.ERIS_AAVE_ACTOR_SIZE_SIGMA, 1),
    ),
    // ADR 0013: per-leg AMM flow cap for non-WETH bases (base units). env FLOW_MAX_<SYM>_<UNIT>
    // (e.g. FLOW_MAX_WBTC_SATS). Default 0 = flow off for WBTC etc. → extraBases do not consume RNG = byte-compatible.
    // WETH flow keeps using uninformed/balancer/curve FlowMaxWethWei (not listed here).
    baseFlowMax: readBaseAmounts(env, "FLOW_MAX", { WETH: 0n }),
    // LST venue (issue #38). The defaults mirror what the deployer bakes into the state dump, so a
    // run that says nothing about lst behaves exactly as deployed.
    lstSimulatedSecondsPerBlock: Math.max(
      0,
      intEnv(env.ERIS_LST_SIMULATED_SECONDS_PER_BLOCK, 3600),
    ),
    lstApyBps: Math.max(0, intEnv(env.ERIS_LST_APY_BPS, 300)),
    lstApyRangeBps: parseBpsRange(
      env.ERIS_LST_APY_RANGE_BPS,
      "ERIS_LST_APY_RANGE_BPS",
    ),
    lstApyStepBlocks: Math.max(1, intEnv(env.ERIS_LST_APY_STEP_BLOCKS, 10)),
    lstQueueThroughputWeiPerBlock: bigintEnv(
      env.ERIS_LST_QUEUE_THROUGHPUT_WEI_PER_BLOCK,
      0n,
    ),
    lstWithdrawalDelayBlocks: Math.max(
      0,
      intEnv(env.ERIS_LST_WITHDRAWAL_DELAY_BLOCKS, 0),
    ),
    flowBotCommand: env.FLOW_BOT_COMMAND ?? "node",
    flowBotArgs:
      env.FLOW_BOT_ARGS && env.FLOW_BOT_ARGS.trim() !== ""
        ? env.FLOW_BOT_ARGS.trim().split(/\s+/)
        : ["--import", "tsx", "core/src/flow/market-maker.ts"],
    // Seed for the flow bot. If unset, use the same as SEED so a single SEED determines the whole run.
    flowSeed: intEnv(env.FLOW_SEED, intEnv(env.SEED, 1)),
    privateKeys: {
      agent0: hexEnv(env.AGENT0_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[0]),
      agent1: hexEnv(env.AGENT1_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[1]),
      agent2: hexEnv(env.AGENT2_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[2]),
      agent3: hexEnv(env.AGENT3_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[3]),
      agent4: hexEnv(env.AGENT4_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[4]),
      agent5: hexEnv(env.AGENT5_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[5]),
      agent6: hexEnv(env.AGENT6_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[6]),
      uninformedFlow: hexEnv(
        env.FLOW_UNINFORMED_PRIVATE_KEY,
        DEFAULT_ANVIL_PRIVATE_KEYS[7],
      ),
      informedFlow: hexEnv(
        env.FLOW_INFORMED_PRIVATE_KEY,
        DEFAULT_ANVIL_PRIVATE_KEYS[8],
      ),
      setup: hexEnv(env.SETUP_PRIVATE_KEY, DEFAULT_ANVIL_PRIVATE_KEYS[9]),
      admin: hexEnv(env.ADMIN_PRIVATE_KEY, deriveRoleKey("admin")),
      keeper: hexEnv(env.KEEPER_PRIVATE_KEY, deriveRoleKey("keeper")),
    },
  };
}

// Blocks per scoring epoch. Stated in real time when `run.epochSeconds` is set (ADR 0021 §3), in
// blocks otherwise -- and refusing to accept both, because two answers to "how long is a round" is
// exactly the ambiguity the axis was introduced to remove.
//
// ADR 0021 §3 settles the *unit*: a round on a chain that runs for a week is 30 minutes to an hour,
// so that standings move several times a day without the series growing far past what the metric has
// been calibrated on. Blocks are then whatever that comes to at this chain's cadence, which is the
// right dependency direction -- an operator who changes the block time should not silently change
// how long a round is. The block count it resolves to, and the lambda that goes with it, are the
// pieces ADR 0021 leaves open and #56 decides.
function resolveEpochBlocks(
  env: NodeJS.ProcessEnv,
  blockTimeSec: number,
): number {
  const seconds = Math.max(0, intEnv(env.ERIS_EPOCH_SECONDS, 0));
  const blocks = Math.max(0, intEnv(env.ERIS_EPOCH_BLOCKS, 12));
  if (seconds === 0) return blocks;
  if (env.ERIS_EPOCH_BLOCKS !== undefined && env.ERIS_EPOCH_BLOCKS !== "")
    throw new Error(
      "run.epochSeconds and run.epochBlocks both set. A round has one length: state it in seconds " +
        "(which converts at run.blockTimeSec) or in blocks, not both (ADR 0021 §3)",
    );
  if (!(blockTimeSec > 0))
    throw new Error(
      "run.epochSeconds needs a positive run.blockTimeSec to convert into blocks",
    );
  return Math.max(1, Math.round(seconds / blockTimeSec));
}

function parseEnabledProtocols(value: string | undefined): ProtocolId[] {
  if (!value || value.trim() === "") return [...ALL_PROTOCOLS];
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ProtocolId[];
  const known = [...ALL_PROTOCOLS, ...OPT_IN_PROTOCOLS];
  const invalid = ids.filter((id) => !known.includes(id));
  if (invalid.length > 0)
    throw new Error(
      `unknown protocol in ENABLED_PROTOCOLS: ${invalid.join(", ")}`,
    );
  return ids;
}

function deriveRoleKey(role: string): Hex {
  return keccak256(stringToBytes(`eris-role:${role}`));
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new Error(`Expected integer env value, got ${value}`);
  return parsed;
}

function floatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Expected numeric env value, got ${value}`);
  return parsed;
}

function bigintEnv(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value === "") return fallback;
  return BigInt(value);
}

// A "[min, max]" bps pair, accepted as JSON or as a bare CSV so it survives the YAML→env encoding
// (an array of numbers becomes "200,600"). Null when unset, which means "no variation".
function parseBpsRange(
  value: string | undefined,
  label: string,
): [number, number] | null {
  if (value === undefined || value.trim() === "") return null;
  const parts = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error(`${label} must be a [min, max] pair of non-negative bps`);
  const [lo, hi] = parts;
  if (lo > hi) throw new Error(`${label} must have min <= max`);
  return [lo, hi];
}

// ADR 0013: unit suffix (derived from decimals) for a base symbol's "amount env".
// WETH(18)=WEI / WBTC(8)=SATS / otherwise=UNITS. New tokens are determined automatically by their decimals.
export function unitSuffixFor(decimals: number): string {
  if (decimals === 18) return "WEI";
  if (decimals === 8) return "SATS";
  return "UNITS";
}

// ADR 0013: build a base symbol -> amount Record from env (for per-base distribution / per-base limits).
// WETH uses wethSeed's value directly and does not read env (the existing WETH env is already read once
// on the caller side = keeps byte compatibility). Additional bases are read from the env key
//   <prefix>[_<SYM>]<_INFIX?>_<UNIT>   e.g. INITIAL_WBTC_SATS / MAX_AGENT_WBTC_IN_SATS
// defaulting to 0n (USDC-only policy = additional bases granted none / capped none by default).
// Under the fork default (WETH only) it is the single entry {WETH: wethSeed.WETH}, matching the old behavior exactly.
function readBaseAmounts(
  env: NodeJS.ProcessEnv,
  prefix: string,
  wethSeed: Record<string, bigint>,
  infix?: string,
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const t of baseTokens()) {
    if (t.symbol === "WETH") {
      out.WETH = wethSeed.WETH ?? 0n;
      continue;
    }
    const unit = unitSuffixFor(t.decimals);
    const key = [prefix, t.symbol, infix, unit].filter(Boolean).join("_");
    out[t.symbol] = bigintEnv(env[key], 0n);
  }
  return out;
}

// OU parameters for the fair-price process, per base (ADR 0017 regime 1).
//
// These used to live only in sdk/src/rng.ts as module-level constants read straight from
// process.env, which meant a regime YAML could not set them: the YAML loader builds a source map, it
// does not mutate process.env. Reading them here puts them on the same footing as every other run
// knob -- YAML sets them, and the coordinator passes them explicitly rather than the price model
// reaching for globals.
function readOuParams(env: NodeJS.ProcessEnv): OuConfig {
  const global = {
    volatility: floatEnv(env.ERIS_PRICE_VOLATILITY, 0.004),
    kappa: floatEnv(env.ERIS_PRICE_REVERT_KAPPA, 0.02),
    drift: floatEnv(env.ERIS_PRICE_DRIFT, 0),
  };
  const perBase: Record<string, OuParams> = {};
  for (const t of baseTokens()) {
    const sfx = t.symbol.toUpperCase();
    perBase[t.symbol] = {
      volatility: floatEnv(
        env[`ERIS_PRICE_VOLATILITY_${sfx}`],
        global.volatility,
      ),
      kappa: floatEnv(env[`ERIS_PRICE_REVERT_KAPPA_${sfx}`], global.kappa),
      drift: floatEnv(env[`ERIS_PRICE_DRIFT_${sfx}`], global.drift),
    };
  }
  return { global, perBase };
}

function hexEnv(value: string | undefined, fallback: string): Hex {
  const result = value && value.length > 0 ? value : fallback;
  if (!/^0x[0-9a-fA-F]{64}$/.test(result))
    throw new Error("Private key must be a 0x-prefixed 32-byte hex string");
  return result as Hex;
}
