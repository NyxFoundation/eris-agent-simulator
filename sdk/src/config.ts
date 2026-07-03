// run 設定の契約レイヤ（ADR 0015）。SimConfig 型と env→SimConfig の loadConfig を sdk に置き、
// 環境(core)と agent ランタイム(example/agents/runtime)の両プロセスが同じ YAML（ERIS_CONFIG）から
// 同一の config を再構築できるようにする。
//
// 環境専用の設定（stress/vuln イベントのスケジュール定義・agent ロスター）は core 側
// （core/src/config.ts の RealtimeConfig / validateAgentsFile）が拡張する。
import { keccak256, stringToBytes, type Hex } from "viem";
import {
  CHAIN_ID,
  DEFAULT_ANVIL_PRIVATE_KEYS,
  MAX_BUNDLE_ACTIONS,
} from "./constants.js";
import type { ProtocolId } from "./types.js";
import { baseTokens } from "./markets.js";

const ALL_PROTOCOLS: ProtocolId[] = [
  "uniswap",
  "balancer",
  "curve",
  "gmx",
  "aave",
];

export type SimConfig = {
  rpcUrl: string;
  chainId: number;
  // フォーク元の上流 RPC（ARB_RPC_URL）。設定時は resetFork が anvil_reset を
  // forking 設定付きで呼び、フォーク状態を毎回クリーンに再構築する（run/seed 間で
  // Aave 等のポジションが残留する anvil_reset [] の問題を回避）。未設定なら従来の
  // anvil_reset [] にフォールバック。
  forkUrl?: string;
  // 再フォーク先ブロック（FORK_BLOCK_NUMBER）。固定すると再実行が完全再現可能になる。
  // 未設定なら最初の resetFork で latest を捕捉し、以降のリセットで再利用する。
  forkBlockNumber?: number;
  // 清算デモ(GitHub #1)。ERIS_LIQUIDATION_DEMO=1 のとき、coordinator が victim ウォレットに
  // 過剰レバレッジの Aave ポジションを開かせ、shockRound 以降に Aave WETH オラクルを引き下げて
  // HF<1 にし、liquidator agent が清算できる状況を作る。既定 off(既存 run/テストは不変)。
  liquidationDemo: boolean;
  liquidationShockBps: number; // WETH オラクル引き下げ幅(bps, 既定 1500=15%)
  liquidationShockRound: number; // 引き下げを始めるラウンド(既定 3)
  liquidationVictimSupplyWethWei: bigint; // victim が supply する WETH(既定 5)
  // 清算を成立させる seed 由来 victim 群(WETH supply + USDC borrow, HF≈H0)。採点対象外。
  // count=0(既定)で無効。>0 のときは aave 有効 + full re-fork(ARB_RPC_URL 必須)が前提(ADR 0009 §4)。
  stressVictimCount: number; // ERIS_STRESS_VICTIM_COUNT
  stressVictimHf0: number; // ERIS_STRESS_VICTIM_HF0(目標初期 HF。既定 1.10。LT/(0.97·LTV)≈1.08 超が必要)
  stressVictimSupplyWethWei: bigint; // ERIS_STRESS_VICTIM_WETH_WEI(victim 1 体あたり supply。既定 5)
  // 各 vuln プールに積む片側の目安流動性(USDC 建て units)。深いほど agent の trade で価格が
  // 動かず bait が実現益になる。ERIS_VULN_POOL_LIQUIDITY_USDC_UNITS(既定 2,000,000 USDC)。
  vulnPoolLiquidityUsdcUnits: bigint;
  // vuln プールの取引手数料(bps)。honest プールの bait が手数料で相殺されない程度に小さく。
  // ERIS_VULN_POOL_FEE_BPS(既定 30 = 0.3%)。
  vulnPoolFeeBps: number;
  // 取引前 LLM ソース監査(ADR 0014 §4-2)の有効化。"0"(既定 off)/"1"(実 LLM)/"mock"(source
  // キーワード走査のスタブ)。coordinator が discovery-arb-verify に ERIS_VULN_LLM で配布する。
  // 採点は環境 ground-truth なので LLM は補助(verdict は参考ログ)。dry-run が一次検証。
  vulnLlm: string;
  // フラッシュ arb デモ(GitHub #3)。ERIS_FLASH_ARB=1 で coordinator が FlashArb コントラクトを
  // デプロイし、flash-arb agent が利用できるようにする。uniswap+balancer+aave 有効が前提。既定 off。
  flashArbDemo: boolean;
  rounds: number;
  roundTimeSeconds: number;
  // 実時間モード（core/src/realtime/coordinator.ts）。interval mining のブロック間隔（秒）と
  // 実行の終了条件（実時間 or ブロック数）。
  blockTimeSec: number;
  runSeconds: number;
  runBlocks: number;
  // run 開始時の resetFork をスキップする（既定 false）。anvil の fork フェッチキャッシュを
  // 前 run から温存し、cold フェッチ由来のレイテンシ（mine 中の上流取得）を切り分ける診断用。
  // 状態は前 run から残留するため評価には使わない（ERIS_SKIP_RESET=1）。
  skipReset: boolean;
  // ローカル(非fork)デプロイ済み anvil を使うモード（ERIS_LOCAL_DEPLOY=1）。fork が無いため
  // run 間リセットは anvil_reset でなく evm_snapshot/evm_revert を使う。アドレスは
  // constants.local.ts（gen:local-constants 生成）を overlay。fork 上流が無いので
  // FORK_BLOCK_NUMBER 固定・whale 等は不要。
  localDeploy: boolean;
  // ローカルモードの snapshot ID 永続化ファイル（cross-process でクリーン断面を共有）。
  localSnapshotFile: string;
  // 競争開始前に flow bot だけで N block の市場ループを回し、protocol の working set を
  // 温める（ADR 0006 Risks の anvil cold フェッチ対策）。競争フェーズの mine が上流フェッチを
  // 踏まなくなる。0 で無効（ERIS_PREWARM_BLOCKS）。
  prewarmBlocks: number;
  seed: number;
  runDirRoot: string;
  agentTimeoutMs: number;
  agentsConfigPath: string;
  // agent ディレクトリ規約（ADR 0015 §2/§6）のルート。ロスターの id はこの直下のディレクトリ名に
  // 対応し、spawn は一律 <agentsDir>/runtime/bot.ts になる（明示 command は override）。
  agentsDir: string;
  initialEthWei: bigint;
  flowEthWei: bigint;
  // flow ウォレット（非 spread）の初期 base 在庫。USDC-only でも flow が「売り」（価格↓）を
  // 出せるようにする＝両方向ドリフトを成立させる。agent には配らない（agent の USDC-only/β 無しは不変）。
  // 既定 0 = 従来どおり（flow も base 無し）。
  flowWethWei: bigint;
  flowBaseAmounts: Record<string, bigint>;
  initialWethWei: bigint;
  // ADR 0013: base シンボル -> 初期配布量（token units）。WETH は initialWethWei と同値で
  // 互換維持。追加 base は INITIAL_<SYM>_<UNIT>（例 INITIAL_WBTC_SATS）で読み、未指定は 0
  // （USDC-only 方針 = 追加 base は既定で配らない）。fork 既定（WETH のみ）では {WETH:...} の 1 件。
  initialBaseAmounts: Record<string, bigint>;
  initialUsdcUnits: bigint;
  defaultPriorityFeeWei: bigint;
  maxPriorityFeeWei: bigint;
  // gas 経済コスト化（ADR 0011。ADR 0010 を Supersede）。true で priority-fee 上限執行を退役し、
  // env の価格確定を mempool tx（cap+premium ordering）から PriceFeed/Aave オラクルの storage 直書き
  // （cheatcode）へ移して上限非依存にする。agent は機会評価に応じ自由に priority fee を積み、高く
  // 評価した者が先に約定する（realistic priority gas auction）。既定 false で ADR 0010 プロファイルを
  // 完全再現する（ロールバック先）。run 単位スイッチ（ERIS_ECONOMIC_GAS）。
  economicGas: boolean;
  maxAgentWethInWei: bigint;
  maxAgentUsdcInUnits: bigint;
  // ADR 0013: base シンボル -> per-round swap 上限（token units）。WETH は maxAgentWethInWei と
  // 同値で互換維持。追加 base は MAX_AGENT_<SYM>_<UNIT>（例 MAX_AGENT_WBTC_IN_SATS）。未指定は
  // 0（= 当該 base の per-round 上限を課さない。limits 整備は Phase 8 範囲外）。
  maxAgentBaseIn: Record<string, bigint>;
  maxBundleActions: number;
  maxLpWethWei: bigint;
  maxLpUsdcUnits: bigint;
  // ADR 0013: base シンボル -> LP mint 上限。WETH は maxLpWethWei と同値で互換維持。
  // 追加 base は MAX_LP_<SYM>_<UNIT>（例 MAX_LP_WBTC_SATS）。未指定は 0。
  maxLpBase: Record<string, bigint>;
  maxOpenPositions: number;
  uninformedFlowMaxWethWei: bigint;
  // 1 ブロック・1 venue あたりの uninformed flow 本数（既定 1）。>1 でハイブリッド α。
  uninformedFlowCount: number;
  // uninformed 方向の持続ブロック数（既定 1）。>1 で order-flow imbalance を模し spread を自然発生。
  uninformedFlowPersistBlocks: number;
  informedFlowMaxWethWei: bigint;
  enabledProtocols: ProtocolId[];
  maxGmxSizeUsd: bigint;
  maxAaveSupplyWethWei: bigint;
  // ADR 0013: base シンボル -> Aave supply 上限。WETH は maxAaveSupplyWethWei と同値で互換維持。
  // 追加 base は MAX_AAVE_SUPPLY_<SYM>_<UNIT>（例 MAX_AAVE_SUPPLY_WBTC_SATS）。未指定は 0。
  maxAaveSupplyBase: Record<string, bigint>;
  maxAaveBorrowUsdcUnits: bigint;
  balancerFlowMaxWethWei: bigint;
  curveFlowMaxWethWei: bigint;
  gmxFlowMaxSizeUsd: bigint;
  // gmx flow を出すブロック確率（0..1、既定 0.5）。散発的に送る。
  gmxFlowActivityProb: number;
  // 発火ブロックで出す gmx 注文の最大本数（>=1、既定 2）。>1 で 1〜N 件をランダムにバースト。
  gmxFlowMaxBurst: number;
  aaveFlowMaxWethWei: bigint;
  // aave flow の各アクターが毎ブロック行動する確率（0..1、既定 0.5）。<1 で間欠的。
  aaveFlowActivityProb: number;
  // aave 借り手プールの独立アクター数（>=1、既定 4）。1 ブロックの最大同時 borrow 数 = この値。
  // 各アクターは別アドレスで持続ポジションを保ち、債務は翌ブロック以降も残る。
  aaveFlowActorCount: number;
  // ADR 0013: WETH 以外の base の AMM flow 1 leg 上限（base units）。既定空/0 = WBTC flow off。
  baseFlowMax: Record<string, bigint>;
  // orderflow bot（独立プロセス）の起動コマンドと決定論シード。
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
  // 経済化（ADR 0011）では endowment を絞って gas を実コスト化する。INITIAL_ETH_WEI 未指定なら
  // 控えめな placeholder（3 ETH）を既定にする（gas を機会価値に対し意味あるコストにしつつ、
  // runtime の gas マネージャ + 下限検証で gas 切れを防ぐ）。最終値は較正実測で決める
  // （ADR「決めていないこと」）。既定 0010 プロファイル（economicGas=false）は 100 ETH のまま不変。
  const economicGas = env.ERIS_ECONOMIC_GAS === "1";
  const initialEthWeiDefault = economicGas
    ? 3_000_000_000_000_000_000n
    : 100_000_000_000_000_000_000n;
  // WETH の既存 env 値（互換のためここで一度だけ読み、per-base マップの WETH エントリにも流用する）。
  const initialWethWei = bigintEnv(
    env.INITIAL_WETH_WEI,
    10_000_000_000_000_000_000n,
  );
  const maxAgentWethInWei = bigintEnv(
    env.MAX_AGENT_WETH_IN_WEI,
    1_000_000_000_000_000_000n,
  );
  const maxLpWethWei = bigintEnv(
    env.MAX_LP_WETH_WEI,
    1_000_000_000_000_000_000n,
  );
  const maxAaveSupplyWethWei = bigintEnv(
    env.MAX_AAVE_SUPPLY_WETH_WEI,
    5_000_000_000_000_000_000n,
  );
  return {
    rpcUrl: env.ANVIL_RPC_URL ?? `http://127.0.0.1:${anvilPort}`,
    chainId: intEnv(env.CHAIN_ID, CHAIN_ID),
    forkUrl:
      env.ARB_RPC_URL && env.ARB_RPC_URL.trim() !== ""
        ? env.ARB_RPC_URL.trim()
        : undefined,
    forkBlockNumber:
      env.FORK_BLOCK_NUMBER && env.FORK_BLOCK_NUMBER.trim() !== ""
        ? intEnv(env.FORK_BLOCK_NUMBER, 0)
        : undefined,
    liquidationDemo: env.ERIS_LIQUIDATION_DEMO === "1",
    liquidationShockBps: intEnv(env.ERIS_LIQUIDATION_SHOCK_BPS, 1500),
    liquidationShockRound: intEnv(env.ERIS_LIQUIDATION_SHOCK_ROUND, 3),
    liquidationVictimSupplyWethWei: bigintEnv(
      env.ERIS_LIQUIDATION_VICTIM_WETH_WEI,
      5_000_000_000_000_000_000n,
    ),
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
    flashArbDemo: env.ERIS_FLASH_ARB === "1",
    rounds: intEnv(env.ROUNDS, 50),
    // 1 ラウンドあたりに進める EVM 時間（秒）。Aave 変動金利の累積や GMX funding
    // を現実的なスケールで発生させるためにラウンドループで evm_increaseTime に渡す。
    roundTimeSeconds: intEnv(env.ROUND_TIME_SECONDS, 3600),
    // 実時間モード（realtime）の設定。
    blockTimeSec: intEnv(env.ERIS_BLOCK_TIME_SEC, 2),
    runSeconds: intEnv(env.ERIS_RUN_SECONDS, 20),
    runBlocks: intEnv(env.ERIS_RUN_BLOCKS, 0),
    skipReset: env.ERIS_SKIP_RESET === "1",
    localDeploy: env.ERIS_LOCAL_DEPLOY === "1",
    localSnapshotFile: env.ERIS_LOCAL_SNAPSHOT_FILE ?? ".local-snapshot",
    prewarmBlocks: intEnv(env.ERIS_PREWARM_BLOCKS, 0),
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
    maxAgentWethInWei,
    maxAgentUsdcInUnits: bigintEnv(env.MAX_AGENT_USDC_IN_UNITS, 5_000_000_000n),
    // 追加 base の per-round swap 上限は MAX_AGENT_<SYM>_IN_<UNIT>（WETH は WEI 既存値を流用）。
    maxAgentBaseIn: readBaseAmounts(
      env,
      "MAX_AGENT",
      { WETH: maxAgentWethInWei },
      "IN",
    ),
    maxBundleActions: intEnv(env.MAX_BUNDLE_ACTIONS, MAX_BUNDLE_ACTIONS),
    maxLpWethWei,
    maxLpUsdcUnits: bigintEnv(env.MAX_LP_USDC_UNITS, 5_000_000_000n),
    maxLpBase: readBaseAmounts(env, "MAX_LP", { WETH: maxLpWethWei }),
    maxOpenPositions: intEnv(env.MAX_OPEN_POSITIONS, 10),
    uninformedFlowMaxWethWei: bigintEnv(
      env.UNINFORMED_FLOW_MAX_WETH_WEI,
      1_000_000_000_000_000_000n,
    ),
    uninformedFlowCount: intEnv(env.UNINFORMED_FLOW_COUNT, 1),
    uninformedFlowPersistBlocks: intEnv(env.UNINFORMED_FLOW_PERSIST_BLOCKS, 1),
    informedFlowMaxWethWei: bigintEnv(
      env.INFORMED_FLOW_MAX_WETH_WEI,
      2_000_000_000_000_000_000n,
    ),
    enabledProtocols: parseEnabledProtocols(env.ENABLED_PROTOCOLS),
    maxGmxSizeUsd: bigintEnv(env.MAX_GMX_SIZE_USD, 50_000n * 10n ** 30n),
    maxAaveSupplyWethWei,
    maxAaveSupplyBase: readBaseAmounts(env, "MAX_AAVE_SUPPLY", {
      WETH: maxAaveSupplyWethWei,
    }),
    maxAaveBorrowUsdcUnits: bigintEnv(
      env.MAX_AAVE_BORROW_USDC_UNITS,
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
    // gmx flow を出すブロック確率（既定 0.5）。毎ブロック rng で判定し散発的に送る。
    gmxFlowActivityProb: floatEnv(env.GMX_FLOW_ACTIVITY_PROB, 0.5),
    // 発火ブロックで出す gmx 注文の最大本数（既定 2）。1〜N 件をランダムにバースト。
    gmxFlowMaxBurst: intEnv(env.GMX_FLOW_MAX_BURST, 2),
    aaveFlowMaxWethWei: bigintEnv(
      env.AAVE_FLOW_MAX_WETH_WEI,
      2_000_000_000_000_000_000n,
    ),
    // aave flow の各アクターが毎ブロック行動する確率（既定 0.5）。<1 で間欠的。
    aaveFlowActivityProb: floatEnv(env.AAVE_FLOW_ACTIVITY_PROB, 0.5),
    // aave 借り手プールの独立アクター数（既定 4）。1 ブロックの最大同時 borrow 数 = この値。
    aaveFlowActorCount: Math.max(1, intEnv(env.AAVE_FLOW_ACTOR_COUNT, 4)),
    // ADR 0013: WETH 以外の base の AMM flow 1 leg 上限（base units）。env FLOW_MAX_<SYM>_<UNIT>
    // （例 FLOW_MAX_WBTC_SATS）。既定 0 = WBTC 等の flow off → extraBases が RNG 非消費 = byte 互換。
    // WETH flow は uninformed/balancer/curve FlowMaxWethWei を使い続ける（ここには載せない）。
    baseFlowMax: readBaseAmounts(env, "FLOW_MAX", { WETH: 0n }),
    flowBotCommand: env.FLOW_BOT_COMMAND ?? "node",
    flowBotArgs:
      env.FLOW_BOT_ARGS && env.FLOW_BOT_ARGS.trim() !== ""
        ? env.FLOW_BOT_ARGS.trim().split(/\s+/)
        : ["--import", "tsx", "core/src/flow/market-maker.ts"],
    // flow bot のシード。未指定なら SEED と同じにして単一 SEED が run 全体を決定する。
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

function parseEnabledProtocols(value: string | undefined): ProtocolId[] {
  if (!value || value.trim() === "") return [...ALL_PROTOCOLS];
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ProtocolId[];
  const invalid = ids.filter((id) => !ALL_PROTOCOLS.includes(id));
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

// ADR 0013: base シンボルの「金額 env」の単位サフィックス（decimals 由来）。
// WETH(18)=WEI / WBTC(8)=SATS / それ以外=UNITS。新トークンは桁数で自動的に決まる。
export function unitSuffixFor(decimals: number): string {
  if (decimals === 18) return "WEI";
  if (decimals === 8) return "SATS";
  return "UNITS";
}

// ADR 0013: base シンボル -> 金額の Record を env から組む（per-base 配布量 / per-base limits 用）。
// WETH は wethSeed の値をそのまま使い env を読まない（既存 WETH env は呼び出し側で 1 度だけ
// 読み済み = byte 互換を保つ）。追加 base は env キー
//   <prefix>[_<SYM>]<_INFIX?>_<UNIT>   例 INITIAL_WBTC_SATS / MAX_AGENT_WBTC_IN_SATS
// を読み、未指定は 0n（USDC-only 方針 = 追加 base は既定で配らない / 上限を課さない）。
// fork 既定（WETH のみ）では {WETH: wethSeed.WETH} の 1 件のみで従来と完全一致。
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

function hexEnv(value: string | undefined, fallback: string): Hex {
  const result = value && value.length > 0 ? value : fallback;
  if (!/^0x[0-9a-fA-F]{64}$/.test(result))
    throw new Error("Private key must be a 0x-prefixed 32-byte hex string");
  return result as Hex;
}
